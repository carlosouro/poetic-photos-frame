import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import { config, normalizeRotation } from './config';
import { safeReadFile, safeStat } from './nas';
import { RotationDegrees } from './types';

// Prevent libvips mmap SIGBUS crashes when NAS CIFS disconnects
try {
    sharp.cache(false);
} catch {}

const execFileAsync = promisify(execFile);

export function ensureMediaCacheDirs(): void {
    fs.mkdirSync(config.videoCacheDir, { recursive: true });
    fs.mkdirSync(config.imageCacheDir, { recursive: true });
}

/**
 * Removes orphaned temporary files left over from interrupted transcodes/renders on crash.
 */
export async function cleanupOrphanedTempFiles(): Promise<void> {
    const dirs = [config.videoCacheDir, config.imageCacheDir];
    for (const dir of dirs) {
        try {
            const entries = await fsPromises.readdir(dir);
            for (const name of entries) {
                if (name.includes('.tmp.')) {
                    await fsPromises.unlink(path.join(dir, name)).catch(() => {});
                }
            }
        } catch {}
    }
}

export function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.m4v': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm'
    };
    return map[ext] || 'application/octet-stream';
}

async function cleanupLruDir(dir: string, suffix: string, maxFiles: number, maxSizeBytes: number, label: string): Promise<void> {
    try {
        const files = await fsPromises.readdir(dir);
        const candidates = files.filter(f => f.endsWith(suffix) && !f.includes('.tmp.'));
        const stats = (
            await Promise.all(
                candidates.map(async f => {
                    const fullPath = path.join(dir, f);
                    try {
                        const st = await fsPromises.stat(fullPath);
                        return { fullPath, mtime: st.mtimeMs, size: st.size };
                    } catch {
                        return null;
                    }
                })
            )
        ).filter((item): item is { fullPath: string; mtime: number; size: number } => item !== null);

        let totalSize = stats.reduce((sum, item) => sum + item.size, 0);
        if (stats.length <= maxFiles && totalSize <= maxSizeBytes) return;

        stats.sort((a, b) => a.mtime - b.mtime);

        let deleted = 0;
        for (const item of stats) {
            if (
                stats.length - deleted <= Math.floor(maxFiles * 0.9) &&
                totalSize <= Math.floor(maxSizeBytes * 0.9)
            ) {
                break;
            }
            try {
                await fsPromises.unlink(item.fullPath);
                totalSize -= item.size;
                deleted++;
            } catch {}
        }

        if (deleted > 0) {
            console.log(`🧹 ${label} cleaned up: removed ${deleted} older files (${(totalSize / (1024 * 1024)).toFixed(1)} MB remaining).`);
        }
    } catch (err) {
        console.warn(`⚠️ ${label} cleanup error:`, err);
    }
}

// ============================================================================
// DISPLAY IMAGE PIPELINE (1280x800 WebP + Blurred Ambient Backdrop)
// ============================================================================

const activeImageBuilds = new Map<string, Promise<{ filePath: string; contentType: string }>>();

export function getDisplayImageCacheKey(filePath: string, mtimeMs: number, rotation: RotationDegrees): string {
    return crypto
        .createHash('sha256')
        .update(`d1:${filePath}:${mtimeMs}:${rotation}:${config.screenWidth}x${config.screenHeight}`)
        .digest('hex')
        .substring(0, 24);
}

/**
 * Generates a display-ready WebP for the 1280x800 screen:
 * - Applies EXIF auto-orientation + manual user rotation
 * - Composites a subtle darkened blurred ambient backdrop behind portrait / non-16:10 photos
 */
export async function renderDisplayImageBuffer(
    fileBuffer: Buffer,
    rotation: RotationDegrees = 0,
    screenWidth = config.screenWidth,
    screenHeight = config.screenHeight
): Promise<Buffer> {
    const rot = normalizeRotation(rotation);

    const orientedPipeline = sharp(fileBuffer, { failOn: 'none' }).autoOrient();
    if (rot !== 0) {
        orientedPipeline.rotate(rot);
    }

    const { data: fgData, info: fgInfo } = await orientedPipeline
        .resize(screenWidth, screenHeight, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });

    const fillsWidth = fgInfo.width >= screenWidth * 0.96;
    const fillsHeight = fgInfo.height >= screenHeight * 0.96;

    // If image already fills the 16:10 display cleanly, encode directly without backdrop
    if (fillsWidth && fillsHeight) {
        return sharp(fgData).webp({ quality: 85 }).toBuffer();
    }

    // Fast Pi-friendly ambient blurred backdrop: blur at 160x100 (~15ms on Pi 4), upscale smoothly
    const smallW = 160;
    const smallH = Math.max(64, Math.round((screenHeight / screenWidth) * smallW));

    const backdrop = await sharp(fgData)
        .resize(smallW, smallH, { fit: 'cover', position: 'centre' })
        .blur(8)
        .resize(screenWidth, screenHeight, { kernel: 'cubic' })
        .modulate({ brightness: 0.34, saturation: 1.08 })
        .toBuffer();

    return sharp(backdrop)
        .composite([{ input: fgData, gravity: 'centre' }])
        .webp({ quality: 84 })
        .toBuffer();
}

export async function ensureDisplayImage(
    filePath: string,
    rotation: RotationDegrees = 0
): Promise<{ filePath: string; contentType: string }> {
    ensureMediaCacheDirs();
    const stat = await safeStat(filePath);
    if (!stat || stat.size <= 0) {
        throw new Error(`Image file unavailable: ${path.basename(filePath)}`);
    }

    const rot = normalizeRotation(rotation);
    const cacheKey = getDisplayImageCacheKey(filePath, stat.mtimeMs, rot);
    const cachedPath = path.join(config.imageCacheDir, `${cacheKey}.webp`);

    const cachedStat = await safeStat(cachedPath, 1500);
    if (cachedStat && cachedStat.size > 500) {
        const now = new Date();
        fsPromises.utimes(cachedPath, now, now).catch(() => {});
        return { filePath: cachedPath, contentType: 'image/webp' };
    }

    if (activeImageBuilds.has(cacheKey)) {
        return activeImageBuilds.get(cacheKey)!;
    }

    const buildPromise = (async () => {
        const tempPath = path.join(config.imageCacheDir, `${cacheKey}.tmp.webp`);
        try {
            const fileBuffer = await safeReadFile(filePath, 15000);
            const webpBuffer = await renderDisplayImageBuffer(fileBuffer, rot);
            await fsPromises.writeFile(tempPath, webpBuffer);
            await fsPromises.rename(tempPath, cachedPath);

            cleanupLruDir(
                config.imageCacheDir,
                '.webp',
                config.imageCacheMaxFiles,
                config.imageCacheMaxSizeBytes,
                'Image cache'
            ).catch(() => {});

            return { filePath: cachedPath, contentType: 'image/webp' };
        } catch (err: any) {
            await fsPromises.unlink(tempPath).catch(() => {});
            const msg = err?.message || String(err);
            // Fall back to raw file only if rotation is 0 and image wasn't fatally corrupt
            if (rot === 0 && !/premature end|corrupt|unsupported/i.test(msg)) {
                console.warn(`⚠️ Display image render fallback for ${path.basename(filePath)}: ${msg}`);
                return { filePath, contentType: getMimeType(filePath) };
            }
            throw err;
        } finally {
            activeImageBuilds.delete(cacheKey);
        }
    })();

    activeImageBuilds.set(cacheKey, buildPromise);
    return buildPromise;
}

/**
 * Downscales image to <=1024x1024 JPEG with EXIF auto-orient + manual rotation for Gemini Vision.
 */
export async function prepareImageForAI(
    filePath: string,
    rotation: RotationDegrees = 0
): Promise<{ data: string; mimeType: string }> {
    const fileBuffer = await safeReadFile(filePath, 15000);
    const rot = normalizeRotation(rotation);

    try {
        const pipeline = sharp(fileBuffer, { failOn: 'none' }).autoOrient();
        if (rot !== 0) {
            pipeline.rotate(rot);
        }

        const resizedBuffer = await pipeline
            .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

        return {
            data: resizedBuffer.toString('base64'),
            mimeType: 'image/jpeg'
        };
    } catch (sharpError: any) {
        const msg = sharpError?.message || String(sharpError);
        if (/premature end|corrupt|unsupported image format|input buffer contains unsupported/i.test(msg)) {
            throw new Error(`Unreadable image (${path.basename(filePath)}): ${msg}`);
        }
        console.warn(`⚠️ Sharp AI resize fallback for ${path.basename(filePath)}: ${msg}`);
        return {
            data: fileBuffer.toString('base64'),
            mimeType: getMimeType(filePath)
        };
    }
}

// ============================================================================
// VIDEO TRANSCODING PIPELINE (Serial Concurrency=1, execFile, Muted -an, v2 Cache Compatible)
// ============================================================================

const activeTranscodes = new Map<string, Promise<string>>();
let transcodeSerialChain: Promise<void> = Promise.resolve();

/**
 * Preserves exact v2 cache key format so existing Pi cache/transcoded/*.mp4 clips are reused with zero re-transcoding.
 */
export function getVideoCacheKey(filePath: string, mtimeMs: number): string {
    return crypto
        .createHash('sha256')
        .update(`v2:${filePath}:${mtimeMs}:${config.screenWidth}x${config.screenHeight}:${config.maxVideoDurationSeconds}`)
        .digest('hex')
        .substring(0, 24);
}

function runInSerialTranscodeQueue<T>(task: () => Promise<T>): Promise<T> {
    const resultPromise = transcodeSerialChain.then(task, task);
    transcodeSerialChain = resultPromise.then(
        () => undefined,
        () => undefined
    );
    return resultPromise;
}

export async function ensureOptimizedVideo(filePath: string): Promise<{ filePath: string; contentType: string }> {
    ensureMediaCacheDirs();

    const stat = await safeStat(filePath);
    if (!stat) {
        return { filePath, contentType: getMimeType(filePath) };
    }

    const cacheKey = getVideoCacheKey(filePath, stat.mtimeMs);
    const cachedPath = path.join(config.videoCacheDir, `${cacheKey}.mp4`);

    const cachedStat = await safeStat(cachedPath, 1500);
    if (cachedStat && cachedStat.size > 1000) {
        const now = new Date();
        fsPromises.utimes(cachedPath, now, now).catch(() => {});
        return { filePath: cachedPath, contentType: 'video/mp4' };
    }

    if (activeTranscodes.has(cacheKey)) {
        const resolved = await activeTranscodes.get(cacheKey)!;
        return { filePath: resolved, contentType: getMimeType(resolved) };
    }

    const transcodePromise = runInSerialTranscodeQueue(async () => {
        const tempPath = path.join(config.videoCacheDir, `${cacheKey}.tmp.mp4`);
        try {
            // Re-check cache in case another job completed while queued
            const recheckStat = await safeStat(cachedPath, 1500);
            if (recheckStat && recheckStat.size > 1000) {
                return cachedPath;
            }

            let duration = 0;
            let codec = '';
            let width = 0;
            let height = 0;
            let srcFps = 30;

            try {
                const { stdout } = await execFileAsync(
                    'ffprobe',
                    [
                        '-v', 'error',
                        '-select_streams', 'v:0',
                        '-show_entries', 'stream=codec_name,width,height,r_frame_rate',
                        '-show_entries', 'format=duration',
                        '-of', 'json',
                        filePath
                    ],
                    { timeout: 15000 }
                );
                const info = JSON.parse(stdout);
                duration = parseFloat(info?.format?.duration || '0');
                const stream = info?.streams?.[0];
                codec = stream?.codec_name || '';
                width = parseInt(stream?.width || '0', 10);
                height = parseInt(stream?.height || '0', 10);
                if (stream?.r_frame_rate) {
                    const parts = String(stream.r_frame_rate).split('/');
                    if (parts.length === 2 && parseFloat(parts[1]) > 0) {
                        srcFps = parseFloat(parts[0]) / parseFloat(parts[1]);
                    } else if (parts.length === 1) {
                        srcFps = parseFloat(parts[0]);
                    }
                }
            } catch (probeErr: any) {
                if (probeErr?.code === 'ENOENT') {
                    // ffprobe not installed (e.g. local dev macOS without ffmpeg) -> serve raw cleanly
                    return filePath;
                }
                console.warn(`⚠️ ffprobe failed for ${path.basename(filePath)}:`, probeErr?.message || probeErr);
            }

            let targetFps = 30;
            if (srcFps >= 45) {
                targetFps = 60;
            } else if (srcFps > 0 && srcFps < 35) {
                targetFps = Math.max(15, Math.round(srcFps));
            }

            let startTime = 0;
            let clipDuration = duration > 0 ? duration : config.maxVideoDurationSeconds;
            if (duration > config.maxVideoDurationSeconds) {
                startTime = Math.max(0, Math.floor((duration - config.maxVideoDurationSeconds) / 2));
                clipDuration = config.maxVideoDurationSeconds;
            }

            console.log(
                `🎬 Optimizing video: ${path.basename(filePath)} (${codec || 'unknown'}, ${width}x${height}, ${srcFps.toFixed(1)}fps, dur ${duration.toFixed(1)}s -> ${clipDuration.toFixed(1)}s @ ${targetFps}fps, muted)`
            );

            const scaleFilter = `scale=${config.screenWidth}:${config.screenHeight}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`;
            const ffmpegArgs = [
                '-n', '15',
                'ffmpeg',
                '-y',
                '-ss', String(startTime),
                '-t', String(clipDuration),
                '-i', filePath,
                '-vf', scaleFilter,
                '-r', String(targetFps),
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                '-an', // Strip audio for muted kiosk playback (faster encode & smaller files)
                '-threads', '2',
                '-movflags', '+faststart',
                tempPath
            ];

            await execFileAsync('nice', ffmpegArgs, { timeout: 120000 });

            const tempStat = await safeStat(tempPath, 2000);
            if (!tempStat || tempStat.size <= 1000) {
                throw new Error('Transcoded file is empty or corrupted');
            }

            await fsPromises.rename(tempPath, cachedPath);
            console.log(`✅ Video optimized: ${cacheKey}.mp4 (${(tempStat.size / (1024 * 1024)).toFixed(2)} MB, ${targetFps}fps)`);

            cleanupLruDir(
                config.videoCacheDir,
                '.mp4',
                config.videoCacheMaxFiles,
                config.videoCacheMaxSizeBytes,
                'Video cache'
            ).catch(() => {});

            return cachedPath;
        } catch (err: any) {
            await fsPromises.unlink(tempPath).catch(() => {});
            console.error(`❌ Video optimization failed for ${path.basename(filePath)}:`, err?.message || err);
            return filePath;
        } finally {
            activeTranscodes.delete(cacheKey);
        }
    });

    activeTranscodes.set(cacheKey, transcodePromise);
    const resolved = await transcodePromise;
    return { filePath: resolved, contentType: getMimeType(resolved) };
}
