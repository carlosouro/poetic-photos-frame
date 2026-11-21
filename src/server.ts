import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { promises as fsPromises } from 'fs'; // Async File System API
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { exec, fork } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';

// Disable libvips mmap file caching to prevent Bus Error (SIGBUS) when NAS CIFS disconnects
try {
    sharp.cache(false);
} catch (e) {}

const execAsync = promisify(exec);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURATION ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
const modelName = process.env.GEMINI_MODEL || "gemini-flash-latest";

const NAS_ROOT_PATH = process.env.NAS_ROOT_PATH;
const DEFAULTS_FOLDER_NAME = '_photoframe_defaults';
const OMITTED_FOLDER_NAME = '_photoframe_omitted';
const UNFAVORITED_FOLDER_NAME = '_photoframe_unfavorited';
const DUPLICATES_FOLDER_NAME = '_photoframe_duplicates';
const ERROR_IMAGE_MARKER = 'SYSTEM_ERROR_IMAGE';

// --- CACHE & DB SETUP ---
const CACHE_DIR = './cache';

// Boot-time sync directory creation is fine
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

import {
    initDatabase,
    getDbStats,
    getPhotoCount,
    insertPhotosBatch,
    getPhotoByPath,
    getPhotoByHash,
    updatePhotoHash,
    removePhoto,
    renamePhoto,
    selectSmartPhoto,
    getRandomPhoto,
    getRandomCachedQuotePhoto,
    getQuote,
    setQuote,
    deleteQuote,
    hasDuplicateQuote,
    getDuplicateQuoteCount,
    migrateQuote,
    Photo,
    QuoteEntry
} from './db';
import { weatherService } from './weather';


const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const isVideoFile = (filePath: string): boolean => {
    const ext = path.extname(filePath).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
};

const MAX_VIDEO_SIZE_MB = parseInt(process.env.MAX_VIDEO_SIZE_MB || '50', 10);
const MAX_IMAGE_SIZE_MB = parseInt(process.env.MAX_IMAGE_SIZE_MB || '25', 10);
const MAX_VIDEO_SIZE_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

// Display & Video Optimization Configuration
const FRAME_SCREEN_WIDTH = parseInt(process.env.FRAME_SCREEN_WIDTH || '1280', 10);
const FRAME_SCREEN_HEIGHT = parseInt(process.env.FRAME_SCREEN_HEIGHT || '800', 10);
const MAX_VIDEO_DURATION_SECONDS = parseInt(process.env.MAX_VIDEO_DURATION_SECONDS || '20', 10);
const VIDEO_CACHE_DIR = path.resolve(process.env.VIDEO_CACHE_DIR || path.join(CACHE_DIR, 'transcoded'));
const VIDEO_CACHE_MAX_FILES = parseInt(process.env.VIDEO_CACHE_MAX_FILES || '1500', 10);
const VIDEO_CACHE_MAX_SIZE_BYTES = parseInt(process.env.VIDEO_CACHE_MAX_SIZE_GB || '10', 10) * 1024 * 1024 * 1024;

if (!fs.existsSync(VIDEO_CACHE_DIR)) {
    fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true });
}

const activeTranscodes = new Map<string, Promise<string>>();

const getVideoCacheKey = (filePath: string, mtimeMs: number): string => {
    return crypto.createHash('sha256')
        .update(`v2:${filePath}:${mtimeMs}:${FRAME_SCREEN_WIDTH}x${FRAME_SCREEN_HEIGHT}:${MAX_VIDEO_DURATION_SECONDS}`)
        .digest('hex')
        .substring(0, 24);
};

const getCachedOptimizedVideoPath = async (filePath: string): Promise<string | null> => {
    try {
        const stat = await fsPromises.stat(filePath);
        const cacheKey = getVideoCacheKey(filePath, stat.mtimeMs);
        const cachedPath = path.join(VIDEO_CACHE_DIR, `${cacheKey}.mp4`);
        if (fs.existsSync(cachedPath)) {
            const cachedStat = await fsPromises.stat(cachedPath);
            if (cachedStat.size > 1000) {
                const now = new Date();
                await fsPromises.utimes(cachedPath, now, now).catch(() => {});
                return cachedPath;
            }
        }
    } catch {}
    return null;
};

const cleanupVideoCache = async (): Promise<void> => {
    try {
        const files = await fsPromises.readdir(VIDEO_CACHE_DIR);
        const mp4Files = files.filter(f => f.endsWith('.mp4') && !f.endsWith('.tmp.mp4'));

        const fileStats = await Promise.all(
            mp4Files.map(async f => {
                const fullPath = path.join(VIDEO_CACHE_DIR, f);
                try {
                    const st = await fsPromises.stat(fullPath);
                    return { fullPath, mtime: st.mtimeMs, size: st.size };
                } catch {
                    return null;
                }
            })
        );

        const validStats = fileStats.filter((item): item is { fullPath: string; mtime: number; size: number } => item !== null);
        let totalSize = validStats.reduce((sum, item) => sum + item.size, 0);

        if (validStats.length <= VIDEO_CACHE_MAX_FILES && totalSize <= VIDEO_CACHE_MAX_SIZE_BYTES) {
            return;
        }

        validStats.sort((a, b) => a.mtime - b.mtime); // Oldest accessed first

        let deletedCount = 0;
        for (const item of validStats) {
            if (validStats.length - deletedCount <= Math.floor(VIDEO_CACHE_MAX_FILES * 0.9) &&
                totalSize <= Math.floor(VIDEO_CACHE_MAX_SIZE_BYTES * 0.9)) {
                break;
            }
            try {
                await fsPromises.unlink(item.fullPath);
                totalSize -= item.size;
                deletedCount++;
            } catch {}
        }
        if (deletedCount > 0) {
            console.log(`🧹 Video cache cleaned up: removed ${deletedCount} older cached clips (current size: ${(totalSize / (1024 * 1024)).toFixed(1)} MB).`);
        }
    } catch (e) {
        console.warn("⚠️ Video cache cleanup error:", e);
    }
};

const ensureOptimizedVideo = async (filePath: string): Promise<string> => {
    let stat: fs.Stats;
    try {
        stat = await fsPromises.stat(filePath);
    } catch {
        return filePath;
    }

    const cacheKey = getVideoCacheKey(filePath, stat.mtimeMs);
    const cachedPath = path.join(VIDEO_CACHE_DIR, `${cacheKey}.mp4`);

    if (fs.existsSync(cachedPath)) {
        try {
            const cachedStat = await fsPromises.stat(cachedPath);
            if (cachedStat.size > 1000) {
                const now = new Date();
                await fsPromises.utimes(cachedPath, now, now).catch(() => {});
                return cachedPath;
            }
        } catch {}
    }

    if (activeTranscodes.has(cacheKey)) {
        return activeTranscodes.get(cacheKey)!;
    }

    const transcodePromise = (async () => {
        try {
            const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate -show_entries format=duration -of json "${filePath}"`;
            let duration = 0;
            let codec = '';
            let width = 0;
            let height = 0;
            let srcFps = 30;

            try {
                const { stdout } = await execAsync(probeCmd);
                const info = JSON.parse(stdout);
                duration = parseFloat(info?.format?.duration || '0');
                const stream = info?.streams?.[0];
                codec = stream?.codec_name || '';
                width = parseInt(stream?.width || '0', 10);
                height = parseInt(stream?.height || '0', 10);
                if (stream?.r_frame_rate) {
                    const parts = stream.r_frame_rate.split('/');
                    if (parts.length === 2 && parseFloat(parts[1]) > 0) {
                        srcFps = parseFloat(parts[0]) / parseFloat(parts[1]);
                    } else if (parts.length === 1) {
                        srcFps = parseFloat(parts[0]);
                    }
                }
            } catch (probeErr) {
                console.warn(`⚠️ ffprobe failed for ${path.basename(filePath)}:`, probeErr);
            }

            // Dynamic framerate selection:
            // 60fps for high-framerate source (iPhone 60fps / 59.94fps); preserve 24/30fps for cinematic/standard clips
            let targetFps = 30;
            if (srcFps >= 45) {
                targetFps = 60;
            } else if (srcFps > 0 && srcFps < 35) {
                targetFps = Math.round(srcFps);
            }

            let startTime = 0;
            let clipDuration = duration > 0 ? duration : MAX_VIDEO_DURATION_SECONDS;
            if (duration > MAX_VIDEO_DURATION_SECONDS) {
                startTime = Math.max(0, Math.floor((duration - MAX_VIDEO_DURATION_SECONDS) / 2));
                clipDuration = MAX_VIDEO_DURATION_SECONDS;
            }

            const tempPath = path.join(VIDEO_CACHE_DIR, `${cacheKey}.tmp.mp4`);

            console.log(`🎬 Optimizing video: ${path.basename(filePath)} (${codec || 'unknown'}, ${width}x${height}, src: ${srcFps.toFixed(1)}fps, dur: ${duration.toFixed(1)}s -> clip ${clipDuration}s from ${startTime}s, target: <=${FRAME_SCREEN_WIDTH}x${FRAME_SCREEN_HEIGHT} @ ${targetFps}fps)...`);

            const scaleFilter = `scale=${FRAME_SCREEN_WIDTH}:${FRAME_SCREEN_HEIGHT}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`;
            const ffmpegCmd = `nice -n 15 ffmpeg -y -ss ${startTime} -t ${clipDuration} -i "${filePath}" -vf "${scaleFilter}" -r ${targetFps} -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -threads 2 -movflags +faststart "${tempPath}"`;

            await execAsync(ffmpegCmd);

            const tempStat = await fsPromises.stat(tempPath);
            if (tempStat.size <= 1000) {
                throw new Error("Transcoded file is empty or corrupted");
            }

            await fsPromises.rename(tempPath, cachedPath);
            console.log(`✅ Video optimized and cached: ${cacheKey}.mp4 (${(tempStat.size / (1024 * 1024)).toFixed(2)} MB, ${targetFps}fps)`);

            cleanupVideoCache().catch(() => {});

            return cachedPath;
        } catch (err) {
            console.error(`❌ Video optimization failed for ${path.basename(filePath)}:`, err);
            return filePath;
        } finally {
            activeTranscodes.delete(cacheKey);
        }
    })();

    activeTranscodes.set(cacheKey, transcodePromise);
    return transcodePromise;
};

const getMediaFileSize = async (filePath: string): Promise<number | null> => {
    try {
        const stat = await fsPromises.stat(filePath);
        return stat.size;
    } catch {
        return null;
    }
};

let isIndexing = false; 
let isGeneratingAI = false;

// --- NAS CIRCUIT BREAKER ---
let isNasOffline = false;
let nasRetryTimestamp = 0;

// Centralized safe NAS check
async function checkNasConnection(): Promise<boolean> {
    if (!NAS_ROOT_PATH) return false;
    
    // If the breaker is tripped, fail instantly so we don't pile up kernel threads
    if (isNasOffline && Date.now() < nasRetryTimestamp) {
        return false; 
    }

    try {
        const check = fsPromises.access(NAS_ROOT_PATH).then(() => true).catch(() => false);
        const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000));
        const isOnline = await Promise.race([check, timeout]);
        
        if (!isOnline) {
            isNasOffline = true;
            nasRetryTimestamp = Date.now() + 60000; // 60s cooldown period
            console.error("⚠️ NAS Circuit Breaker Tripped! Cooldown active for 60s.");
        } else {
            isNasOffline = false;
        }
        return isOnline;
    } catch {
        return false;
    }
}

// Safe async check if a file/folder exists WITH strict timeout to prevent OS freezing
async function fileExists(pathStr: string): Promise<boolean> {
    try {
        const check = fsPromises.access(pathStr).then(() => true).catch(() => false);
        const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000));
        return await Promise.race([check, timeout]);
    } catch {
        return false;
    }
}


// --- DUPLICATE DETECTION & AUTO-CURATION ENGINE ---

const computeFileSha256 = (filePath: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
};

const scorePathForSurvival = (filePath: string): number => {
    let score = 0;
    const base = path.basename(filePath);
    const lowerPath = filePath.toLowerCase();

    // 1. Favorites folder always takes absolute priority
    if (filePath.includes(DEFAULTS_FOLDER_NAME)) {
        score += 10000;
    }

    // 2. Filename Cleanliness: penalize copy/duplicate suffixes (e.g. " (1)", "_1", " - Copy", "copy")
    const dupSuffixRegex = /([_\s-](copy|\(\d+\)|\d{1,2}))\.[a-z0-9]+$/i;
    if (dupSuffixRegex.test(base)) {
        score -= 500;
    }

    // 3. Folder Organization: penalize generic dump/backup/messenger folders
    const dumpFolderRegex = /\/(mobilebackup|downloads|whatsapp|staging|temp|tmp|camera\s*roll)\//i;
    if (dumpFolderRegex.test(lowerPath)) {
        score -= 200;
    }

    // 4. Shorter directory depth indicates more curated placement
    const depth = filePath.split(path.sep).length;
    score -= depth * 5;

    return score;
};

const determineSurvivor = (
    pathA: string,
    pathB: string,
    createdA?: string,
    createdB?: string
): { survivor: string; duplicate: string } => {
    const scoreA = scorePathForSurvival(pathA);
    const scoreB = scorePathForSurvival(pathB);

    if (scoreA !== scoreB) {
        return scoreA > scoreB
            ? { survivor: pathA, duplicate: pathB }
            : { survivor: pathB, duplicate: pathA };
    }

    // Tie-breaker: Earliest timestamp
    if (createdA && createdB) {
        const timeA = new Date(createdA).getTime();
        const timeB = new Date(createdB).getTime();
        if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
            return timeA < timeB
                ? { survivor: pathA, duplicate: pathB }
                : { survivor: pathB, duplicate: pathA };
        }
    }

    // Alphabetical tie-breaker
    return pathA.localeCompare(pathB) <= 0
        ? { survivor: pathA, duplicate: pathB }
        : { survivor: pathB, duplicate: pathA };
};

const quarantineDuplicate = async (duplicatePath: string, survivorPath: string): Promise<boolean> => {
    try {
        if (!NAS_ROOT_PATH) return false;

        // Calculate relative path preserving folder hierarchy
        let relPath = path.relative(NAS_ROOT_PATH, duplicatePath);
        if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
            relPath = path.basename(duplicatePath);
        }

        const targetDir = path.join(NAS_ROOT_PATH, DUPLICATES_FOLDER_NAME, path.dirname(relPath));
        await fsPromises.mkdir(targetDir, { recursive: true });

        let targetFilePath = path.join(targetDir, path.basename(relPath));
        if (await fileExists(targetFilePath)) {
            const ext = path.extname(targetFilePath);
            const base = path.basename(targetFilePath, ext);
            targetFilePath = path.join(targetDir, `${base}_${Date.now()}${ext}`);
        }

        await fsPromises.rename(duplicatePath, targetFilePath);

        // Remove duplicate from SQLite and migrate quote to survivor if survivor lacks one
        removePhoto(duplicatePath);
        migrateQuote(duplicatePath, survivorPath);

        console.log(`🗑️ Auto-quarantined duplicate: ${path.basename(duplicatePath)} -> ${DUPLICATES_FOLDER_NAME}/${relPath} (Surviving original: ${path.basename(survivorPath)})`);
        return true;
    } catch (err) {
        console.error(`❌ Failed to quarantine duplicate ${path.basename(duplicatePath)}:`, err);
        return false;
    }
};

// --- INDEXING LOGIC ---

const runIndexer = (mode: 'defaults' | 'full'): Promise<void> => {
    return new Promise((resolve, reject) => {
        const isCompiled = __filename.endsWith('.js');
        const indexerPath = isCompiled
            ? path.join(__dirname, 'indexer.js')
            : path.join(__dirname, 'indexer.ts');
        const indexer = fork(indexerPath, [`--mode=${mode}`]);

        indexer.on('message', (msg: any) => {
            if (msg.type === 'batch' && Array.isArray(msg.photos)) {
                insertPhotosBatch(msg.photos);
            }
        });

        indexer.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Indexer failed with code ${code}`));
        });
    });
};

const performIndexing = async (clearCache: boolean = false) => {
    if (NAS_ROOT_PATH && !(await checkNasConnection())) {
        isIndexing = false;
        return; 
    }

    if (isIndexing) {
        console.log("ℹ️ Indexing already in progress. Skipping duplicate request.");
        return;
    }

    isIndexing = true;
    const initialStats = getDbStats();
    console.log(`🚀 Starting zero-downtime background indexing (preserving ${initialStats.totalPhotos} active cached photos)...`);

    runIndexer('full')
        .then(() => {
            const stats = getDbStats();
            console.log(`✅ Indexing completed. Library size: ${stats.totalPhotos} items (${stats.indexedHashes} hashed, ${stats.favoritesCount} favorites).`);
        })
        .catch(err => console.error("❌ Background index failed:", err))
        .finally(() => isIndexing = false);
};


// --- LOG MAINTENANCE ---
const trimLogFile = async (maxLines = 10000) => {
    const logPath = path.resolve('frame.log');
    try {
        if (await fileExists(logPath)) {
            const data = await fsPromises.readFile(logPath, 'utf-8');
            const lines = data.split('\n');
            if (lines.length > maxLines + 500) {
                const trimmed = lines.slice(-maxLines).join('\n');
                await fsPromises.writeFile(logPath, trimmed, 'utf-8');
                console.log(`🧹 Log trimmed to last ${maxLines} lines.`);
            }
        }
    } catch (err) {
        console.error("Log trimming error:", err);
    }
};

// --- SCHEDULING ---
setInterval(() => {
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() === 0) {
        performIndexing(false); 
        trimLogFile(10000);
    }
}, 60 * 1000);

// --- API LOGIC ---

const RECENT_QUOTES_LIMIT = 50;
const OVERUSED_QUOTE_THRESHOLD = 5;
const recentDisplayedQuotes: string[] = [];

function rememberDisplayedQuote(content: string) {
    const trimmed = content?.trim();
    if (!trimmed) return;
    const existingIdx = recentDisplayedQuotes.indexOf(trimmed);
    if (existingIdx !== -1) {
        recentDisplayedQuotes.splice(existingIdx, 1);
    }
    recentDisplayedQuotes.push(trimmed);
    if (recentDisplayedQuotes.length > RECENT_QUOTES_LIMIT) {
        recentDisplayedQuotes.shift();
    }
}

function getImageMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    return 'image/jpeg';
}

async function fileToGenerativePart(filePath: string) {
    // Read file into Buffer to avoid libvips mmap SIGBUS on remote CIFS/NFS mounts
    const fileBuffer = await fsPromises.readFile(filePath);
    try {
        // failOn: 'none' gracefully recovers slightly truncated/corrupt JPEGs into valid JPEGs
        // Downscale image to max 1024x1024 to drop base64 payload from 15MB+ to ~150KB
        const resizedBuffer = await sharp(fileBuffer, { failOn: 'none' })
            .rotate() // preserve EXIF orientation
            .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

        return {
            data: resizedBuffer.toString("base64"),
            mimeType: "image/jpeg"
        };
    } catch (sharpError: any) {
        const msg = sharpError?.message || String(sharpError);
        // Never send unreadable/corrupt bytes to Gemini (triggers 400 INVALID_ARGUMENT)
        if (/premature end|corrupt|unsupported image format|input buffer contains unsupported/i.test(msg)) {
            throw new Error(`Unreadable image (${path.basename(filePath)}): ${msg}`);
        }
        console.warn(`⚠️ Sharp resizing failed for ${path.basename(filePath)}, using buffer fallback:`, msg);
        return {
            data: fileBuffer.toString("base64"),
            mimeType: getImageMimeType(filePath)
        };
    }
}

async function generateWithRetry(prompt: string, imagePart: { data: string; mimeType: string }, retries = 3, delay = 1000): Promise<QuoteEntry> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
        // Enforce a strict 25-second timeout on Gemini API calls so network drops don't hang the app forever
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("Gemini API Timeout")), 25000);
        });

        const apiCall = ai.models.generateContent({
            model: modelName,
            contents: [
                { text: prompt },
                {
                    inlineData: {
                        mimeType: imagePart.mimeType,
                        data: imagePart.data
                    }
                }
            ],
            config: {
                thinkingConfig: {
                    thinkingBudget: 0
                },
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'OBJECT',
                    properties: {
                        content: { type: 'STRING', description: 'A meaningful, profound quote matching the photo. Can be well-known/famous, or a lesser-known quote if it better fits the scene and emotional resonance.' },
                        type: { type: 'STRING', enum: ['quote'], description: 'Must always be quote' },
                        author: { type: 'STRING', description: 'The author, thinker, poet, writer, philosopher, or figure who said/wrote the quote. If the author is unknown or of traditional/folk origin, use Anonymous, Unknown, or Popular wisdom (or Provérbio Popular / Anónimo in PT). Never null.' }
                    },
                    required: ['content', 'type', 'author']
                }
            } as any
        });

        const result = await Promise.race([apiCall, timeoutPromise]) as any;
        const text = typeof result.text === 'function'
            ? result.text()
            : (typeof result.text === 'string' ? result.text : (result.candidates?.[0]?.content?.parts?.[0]?.text || ''));
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        if (!cleanText) {
            const finishReason = result.candidates?.[0]?.finishReason || 'EMPTY_RESPONSE';
            throw new Error(`Gemini returned empty response (${finishReason})`);
        }
        const parsed = JSON.parse(cleanText) as QuoteEntry;
        if (!parsed?.content?.trim() || !parsed?.author?.trim()) {
            throw new Error('Gemini returned incomplete quote payload');
        }
        return {
            content: parsed.content.trim(),
            type: 'quote',
            author: parsed.author.trim()
        };
    } catch (error: any) {
        if (error.message?.includes('404') || error.status === 400) throw error;

        // Catch timeouts and fetch failures to trigger retries cleanly
        if (retries > 0 && (error.message?.includes('503') || error.message?.includes('overloaded') || error.message?.includes('Timeout') || error.message?.includes('fetch failed'))) {
            console.log(`⚠️ Gemini API failed (${error.message}). Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            return generateWithRetry(prompt, imagePart, retries - 1, delay * 2);
        }
        throw error;
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
}

app.get('/api/next-memory', async (req, res) => {
    try {
        // ASYNC: Check NAS existence with Circuit Breaker
        if (NAS_ROOT_PATH) {
            const nasMounted = await checkNasConnection();
            if (!nasMounted) {
                return res.json({
                    text: "⚠️ System Alert: Storage not accessible. Retrying shortly...",
                    type: 'quote',
                    author: "System Alert",
                    date: new Date().toISOString(),
                    imagePathEncoded: encodeURIComponent(ERROR_IMAGE_MARKER),
                    mediaUrl: `/api/image?path=${encodeURIComponent(ERROR_IMAGE_MARKER)}`,
                    isVideo: false,
                    isFavorite: false
                });
            }
        }

        if (getPhotoCount() === 0) {
            return res.json({
                text: "Loading memories from storage...",
                type: 'quote',
                author: "Poetic Memories",
                date: new Date().toISOString(),
                imagePathEncoded: encodeURIComponent(ERROR_IMAGE_MARKER),
                mediaUrl: `/api/image?path=${encodeURIComponent(ERROR_IMAGE_MARKER)}`,
                isVideo: false,
                isFavorite: false
            });
        }

        // 1. SELECT VALID MEDIA CANDIDATE WITHIN SIZE LIMITS & DEDUPLICATE ON-THE-FLY
        const currentPath = req.query.current ? decodeURIComponent(req.query.current as string) : null;
        let selectedPhoto: Photo | null = null;
        for (let attempt = 0; attempt < 10; attempt++) {
            const candidate = selectSmartPhoto(currentPath || undefined) || (currentPath ? getRandomPhoto(currentPath) : null) || getRandomPhoto();
            if (!candidate) break;

            const size = await getMediaFileSize(candidate.path);
            if (size === null || size <= 0) {
                if (!isNasOffline) {
                    removePhoto(candidate.path);
                }
                continue;
            }

            const isVideo = candidate.mediaType === 'video' || isVideoFile(candidate.path);
            const maxSize = isVideo ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;
            if (size > maxSize) {
                console.warn(`⚠️ Skipping oversized media (${(size / (1024 * 1024)).toFixed(1)}MB > ${isVideo ? MAX_VIDEO_SIZE_MB : MAX_IMAGE_SIZE_MB}MB): ${path.basename(candidate.path)}`);
                continue;
            }

            // --- ON-THE-FLY DUPLICATE DETECTION & AUTO-CURATION ---
            let hash = candidate.hash;
            if (!hash) {
                try {
                    hash = await computeFileSha256(candidate.path);
                    updatePhotoHash(candidate.path, hash);
                    candidate.hash = hash;
                } catch (hashErr) {
                    console.warn(`⚠️ Could not compute hash for ${path.basename(candidate.path)}:`, hashErr);
                }
            }

            if (hash) {
                const existingCandidate = getPhotoByHash(hash, candidate.path);
                if (existingCandidate) {
                    // Hash collision detected! Determine survivor
                    const { survivor, duplicate } = determineSurvivor(
                        candidate.path,
                        existingCandidate.path,
                        candidate.created,
                        existingCandidate.created
                    );

                    if (duplicate === candidate.path) {
                        // Candidate is the duplicate -> quarantine and continue searching
                        await quarantineDuplicate(candidate.path, survivor);
                        continue;
                    } else {
                        // Existing file was the duplicate -> quarantine it, candidate survives
                        await quarantineDuplicate(existingCandidate.path, candidate.path);
                        updatePhotoHash(candidate.path, hash);
                    }
                }
            }

            selectedPhoto = candidate;
            break;
        }


        if (!selectedPhoto) {
            return res.json({
                text: isNasOffline ? "Waiting for storage connection..." : "Finding your next memory...",
                type: 'quote',
                author: "System Alert",
                date: new Date().toISOString(),
                imagePathEncoded: encodeURIComponent(ERROR_IMAGE_MARKER),
                mediaUrl: `/api/image?path=${encodeURIComponent(ERROR_IMAGE_MARKER)}`,
                isVideo: false,
                isFavorite: false
            });
        }

        const isFavorite = selectedPhoto.path.includes(DEFAULTS_FOLDER_NAME);
        const isVideo = selectedPhoto.mediaType === 'video' || isVideoFile(selectedPhoto.path);

        // If it's a video, bypass Gemini AI generation completely
        if (isVideo) {
            const videoPath = selectedPhoto.path;
            // Kick off background/pre-buffering optimization so it's ready when played
            ensureOptimizedVideo(videoPath).catch(err => {
                console.warn(`⚠️ Pre-transcoding error for ${path.basename(videoPath)}:`, err);
            });

            return res.json({
                text: "",
                type: 'video',
                author: null,
                date: selectedPhoto.created,
                imagePathEncoded: encodeURIComponent(videoPath),
                mediaUrl: `/api/media?path=${encodeURIComponent(videoPath)}`,
                isVideo: true,
                isFavorite: isFavorite
            });
        }


        let aiResponse: QuoteEntry | null = null;
        let duplicateDetected = false;
        let textToExclude = "";

        // 2. CHECK CACHE & DETECT OVERUSED / RECENTLY SHOWN DUPLICATES
        const cachedEntry = getQuote(selectedPhoto.path);
        if (cachedEntry) {
            const recentlyShown = recentDisplayedQuotes.includes(cachedEntry.content.trim());
            const duplicateCount = getDuplicateQuoteCount(cachedEntry.content, selectedPhoto.path);
            if (recentlyShown || duplicateCount >= OVERUSED_QUOTE_THRESHOLD) {
                duplicateDetected = true;
                textToExclude = cachedEntry.content;
                console.log(`♻️  Refreshing ${recentlyShown ? 'recently shown' : `overused (${duplicateCount + 1}x)`} quote for ${path.basename(selectedPhoto.path)}...`);
            } else {
                aiResponse = cachedEntry;
            }
        }

        // 3. GENERATE OR FALLBACK
        if (!aiResponse || duplicateDetected) {
            
            if (isGeneratingAI) {
                console.log("⚠️ Backend is busy. Forcing a cached fallback quote memory.");
                const availableCachedPhoto = getRandomCachedQuotePhoto(currentPath || undefined);
                if (availableCachedPhoto) {
                    selectedPhoto = availableCachedPhoto;
                    aiResponse = getQuote(selectedPhoto.path) || { content: "A vida é feita de momentos que o tempo eterniza.", type: "quote", author: "Fernando Pessoa" };
                } else {
                    aiResponse = { content: "A vida é feita de momentos que o tempo eterniza.", type: "quote", author: "Fernando Pessoa" };
                }
            } else {
                isGeneratingAI = true; 
                
                const excludedQuotes = new Set<string>();
                if (duplicateDetected && textToExclude) excludedQuotes.add(textToExclude);
                for (const q of recentDisplayedQuotes.slice(-5)) excludedQuotes.add(q);

                let exclusionInstruction = "";
                if (excludedQuotes.size > 0) {
                    const list = Array.from(excludedQuotes).map(q => `"${q}"`).join('; ');
                    exclusionInstruction = `IMPORTANT: Do NOT use any of these recently/overused quotes: ${list}. Choose a distinct, less clichéd quote.`;
                }

                const photoDate = new Date(selectedPhoto.created);
                const now = new Date();
                const yearsAgo = now.getFullYear() - photoDate.getFullYear();
                let temporalContext = "";
                if (yearsAgo > 0 && Math.abs(now.getMonth() - photoDate.getMonth()) <= 1) {
                    temporalContext = `Context: This memory is an anniversary memory from ${yearsAgo} ${yearsAgo === 1 ? 'year' : 'years'} ago (${photoDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}).`;
                }

                const prompt = `
                    You are a literary curator for a digital photo frame. Look closely at this image.
                    
                    Goal: Select a profound, meaningful, and poignant existing quote that reflects the scene, mood, location, activity, or emotional resonance of the photo.
                    ${temporalContext ? `${temporalContext}\n` : ''}
                    
                    ${exclusionInstruction}

                    Directives:
                    - Only real, authentic, existing quotes. Can be a widely famous quote, or a lesser-known quote if it captures the moment and emotional mood better.
                    - Avoid overly clichéd quotes; favor fresh, evocative literary quotes that match specific visual details of the scene.
                    - DO NOT compose your own poem, rhymes, or AI-generated prose.
                    - Provide the author in the 'author' field (e.g. Fernando Pessoa, Oscar Wilde, Albert Einstein, Sophia de Mello Breyner Andresen, Victor Hugo, Ralph Waldo Emerson, Clarice Lispector, etc.).
                    - If the quote is of unknown origin or traditional/folk wisdom, set author to "Anonymous", "Unknown", "Proverb", or "Provérbio Popular" / "Anónimo".
                    - Language: Randomly choose between European Portuguese (PT-PT) or English. If European Portuguese, quotes from Portuguese or Lusophone writers or well-known translated quotes/proverbs are welcomed.
                `;

                try {
                    const imagePart = await fileToGenerativePart(selectedPhoto.path);
                    aiResponse = await generateWithRetry(prompt, imagePart);
                    if (aiResponse) {
                        setQuote(selectedPhoto.path, aiResponse);
                    }
                } catch (aiError: any) {
                    console.error("Gemini Final Error:", aiError?.message || aiError);
                    if (!aiResponse) {
                        aiResponse = cachedEntry || { content: "O valor das coisas não está no tempo que elas duram, mas na intensidade com que acontecem.", type: "quote", author: "Fernando Pessoa" };
                    }
                } finally {
                    isGeneratingAI = false; 
                }
            }
        }

        rememberDisplayedQuote(aiResponse!.content);

        res.json({
            text: aiResponse!.content,
            type: aiResponse!.type,
            author: aiResponse!.author,
            date: selectedPhoto.created,
            imagePathEncoded: encodeURIComponent(selectedPhoto.path),
            mediaUrl: `/api/image?path=${encodeURIComponent(selectedPhoto.path)}`,
            isVideo: false,
            isFavorite: selectedPhoto.path.includes(DEFAULTS_FOLDER_NAME)
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
});

const handleMediaServing = async (req: express.Request, res: express.Response) => {
    const filePath = decodeURIComponent(req.query.path as string);
    if (filePath === ERROR_IMAGE_MARKER) {
        const img = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==", 'base64');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
        return res.end(img);
    }
    
    const size = await getMediaFileSize(filePath);
    if (size === null || size <= 0) return res.status(404).send('Media not found');

    const ext = path.extname(filePath).toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.has(ext);

    if (isVideo) {
        let servePath = filePath;
        try {
            const optimizedPath = await ensureOptimizedVideo(filePath);
            if (optimizedPath && fs.existsSync(optimizedPath)) {
                servePath = optimizedPath;
            }
        } catch (err) {
            console.warn(`⚠️ Serving raw video for ${path.basename(filePath)} after optimization error:`, err);
        }

        return res.sendFile(path.resolve(servePath), {
            acceptRanges: true,
            headers: {
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes'
            }
        });
    }

    if (size > MAX_IMAGE_SIZE_BYTES) {
        console.warn(`⛔ Refused oversized image request: ${path.basename(filePath)} (${(size / (1024 * 1024)).toFixed(1)}MB > ${MAX_IMAGE_SIZE_MB}MB)`);
        return res.status(413).send(`Image file exceeds maximum allowed size of ${MAX_IMAGE_SIZE_MB}MB`);
    }

    const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.sendFile(path.resolve(filePath), {
        acceptRanges: true,
        headers: {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
        }
    }, (err: any) => {
        if (err && !res.headersSent) {
            console.warn(`⚠️ Failed to send media file ${path.basename(filePath)}:`, err.message);
            res.status(err.status || 500).end();
        }
    });
};


app.get('/api/image', handleMediaServing);
app.get('/api/media', handleMediaServing);

// --- MANAGEMENT ENDPOINTS ---

app.post('/api/favorite', async (req, res) => {
    try {
        const { currentPath } = req.body;
        if (!currentPath || !(await fileExists(currentPath))) return res.status(404).json({error: "File not found"});
        if (!NAS_ROOT_PATH) return res.status(500).json({error: "NAS Root not configured"});

        const isCurrentlyFavorite = currentPath.includes(DEFAULTS_FOLDER_NAME);
        const targetFolderName = isCurrentlyFavorite ? UNFAVORITED_FOLDER_NAME : DEFAULTS_FOLDER_NAME;

        const targetDir = path.join(NAS_ROOT_PATH, targetFolderName);
        if (!(await fileExists(targetDir))) {
            await fsPromises.mkdir(targetDir, {recursive: true});
        }

        let fileName = path.basename(currentPath);
        let newPath = path.join(targetDir, fileName);

        if (currentPath === newPath) return res.json({message: "No change needed", isFavorite: isCurrentlyFavorite});
        
        if (await fileExists(newPath)) {
             const timestamp = Date.now();
             const ext = path.extname(fileName);
             const name = path.basename(fileName, ext);
             newPath = path.join(targetDir, `${name}_${timestamp}${ext}`);
        }

        await fsPromises.rename(currentPath, newPath);
        renamePhoto(currentPath, newPath);

        const isNowFavorite = !isCurrentlyFavorite;
        res.json({ success: true, newPath, isFavorite: isNowFavorite });

    } catch(e: any) {
        console.error("Favorite Error:", e);
        res.status(500).json({error: e.message});
    }
});

app.post('/api/omit', async (req, res) => {
    try {
        const { currentPath } = req.body;
        if (!currentPath || !(await fileExists(currentPath))) return res.status(404).json({error: "File not found"});
        if (!NAS_ROOT_PATH) return res.status(500).json({error: "NAS Root not configured"});

        const omittedDir = path.join(NAS_ROOT_PATH, OMITTED_FOLDER_NAME);
        if (!(await fileExists(omittedDir))) {
            await fsPromises.mkdir(omittedDir, {recursive: true});
        }

        let fileName = path.basename(currentPath);
        let newPath = path.join(omittedDir, fileName);

        if (currentPath === newPath) return res.json({message: "Already omitted"});
        
        if (await fileExists(newPath)) {
             const timestamp = Date.now();
             const ext = path.extname(fileName);
             const name = path.basename(fileName, ext);
             newPath = path.join(omittedDir, `${name}_${timestamp}${ext}`);
        }

        await fsPromises.rename(currentPath, newPath);
        removePhoto(currentPath);

        res.json({ success: true, newPath });
    } catch(e: any) {
        console.error("Omit Error:", e);
        res.status(500).json({error: e.message});
    }
});

app.delete('/api/photo', async (req, res) => {
    try {
        const { currentPath } = req.body;
        if (!currentPath || !(await fileExists(currentPath))) return res.status(404).json({error: "File not found"});

        await fsPromises.unlink(currentPath);
        removePhoto(currentPath);

        res.json({ success: true });
    } catch(e: any) {
        console.error("Delete Error:", e);
        res.status(500).json({error: e.message});
    }
});

app.get('/api/duplicates', async (req, res) => {
    try {
        if (!NAS_ROOT_PATH) return res.status(500).json({ error: "NAS Root not configured" });
        const duplicatesDir = path.join(NAS_ROOT_PATH, DUPLICATES_FOLDER_NAME);
        let count = 0;
        if (await fileExists(duplicatesDir)) {
            const countFiles = async (dir: string): Promise<number> => {
                let total = 0;
                try {
                    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const full = path.join(dir, entry.name);
                        if (entry.isDirectory()) total += await countFiles(full);
                        else total++;
                    }
                } catch {}
                return total;
            };
            count = await countFiles(duplicatesDir);
        }

        const stats = getDbStats();
        res.json({
            duplicatesFolder: duplicatesDir,
            quarantinedCount: count,
            indexedHashesCount: stats.indexedHashes,
            totalPhotosInLibrary: stats.totalPhotos
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/exit', (req, res) => {
    res.json({ message: 'Shutting down...' });
    // Terminate all chromium kiosk processes cleanly
    exec('pkill -f chromium 2>/dev/null; killall -9 chromium chromium-browser 2>/dev/null', () => {}); 
    setTimeout(() => process.exit(0), 1000);
});

app.post('/api/reboot', (req, res) => {
    res.json({ message: 'Rebooting system...' });
    exec('sudo -n systemctl reboot || sudo -n reboot', (err) => {
        if (err) console.error('❌ Reboot command failed:', err.message);
    });
});

app.post('/api/reindex', (req, res) => {
    res.json({ message: 'Reindexing started...' });
    performIndexing(false);
});

app.get('/api/weather', async (req, res) => {
    try {
        const weather = await weatherService.getWeather();
        if (!weather) {
            return res.status(503).json({ error: 'Weather data temporarily unavailable' });
        }
        res.json(weather);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    initDatabase();
    const stats = getDbStats();
    console.log(`📚 Database ready: ${stats.totalPhotos} photos (${stats.indexedHashes} hashed, ${stats.favoritesCount} favorites) | 📜 ${stats.totalQuotes} quotes`);
    if (stats.totalPhotos === 0) performIndexing(false);
    weatherService.fetchForecast().catch(err => console.warn(`[WeatherService] Initial fetch failed: ${err.message}`));
});