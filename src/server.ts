import express from 'express';
import cors from 'cors';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import { ChildProcess, execFile, fork } from 'child_process';
import { config, isVideoFile, normalizeRotation } from './config';
import {
    closeDatabase,
    getDbStats,
    getPhotoByPath,
    getPhotoCount,
    initDatabase,
    pruneUnseenPhotos,
    removePhoto,
    renamePhoto,
    setPhotoRotation,
    upsertScannedBatch
} from './db';
import {
    cleanupOrphanedTempFiles,
    ensureDisplayImage,
    ensureMediaCacheDirs,
    ensureOptimizedVideo,
    getMimeType
} from './media';
import {
    assertInsideNas,
    atomicMoveToDir,
    checkNasConnection,
    isNasOffline,
    PathSecurityError,
    safeAccess,
    safeStat
} from './nas';
import { buildImageMediaUrl, buildVideoMediaUrl, memoryQueue } from './queue';
import { weatherService } from './weather';
import { RotationDegrees } from './types';

const app = express();
const bootTimeMs = Date.now();

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve('public')));

// Transparent 1x1 PNG for system alert states
const TRANSPARENT_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==',
    'base64'
);

// --- BACKGROUND INDEXING ---
let isIndexing = false;
let activeIndexerProcess: ChildProcess | null = null;

function runFullIndexer(): Promise<{ totalFiles: number; errorCount: number }> {
    return new Promise((resolve, reject) => {
        const isCompiled = __filename.endsWith('.js');
        const indexerPath = isCompiled
            ? path.join(__dirname, 'indexer.js')
            : path.join(__dirname, 'indexer.ts');

        const scanId = Date.now();
        let totalFiles = 0;
        let errorCount = 0;

        const child = fork(indexerPath);
        activeIndexerProcess = child;

        child.on('message', (msg: any) => {
            if (msg?.type === 'batch' && Array.isArray(msg.photos)) {
                upsertScannedBatch(msg.photos, scanId);
            } else if (msg?.type === 'done') {
                totalFiles = msg.totalFiles ?? 0;
                errorCount = msg.errorCount ?? 0;
            }
        });

        child.on('close', (code) => {
            activeIndexerProcess = null;
            if (code !== 0) {
                reject(new Error(`Indexer exited with code ${code}`));
                return;
            }

            // Prune deleted NAS files ONLY when full scan succeeded cleanly with zero fatal errors
            if (errorCount === 0 && totalFiles > 0) {
                const { pruned, skippedReason } = pruneUnseenPhotos(scanId, totalFiles);
                if (pruned > 0) {
                    console.log(`🧹 Pruned ${pruned} removed NAS files from database.`);
                } else if (skippedReason) {
                    console.log(`ℹ️ Prune skipped: ${skippedReason}`);
                }
            } else if (errorCount > 0) {
                console.warn(`⚠️ Skipping prune because scan encountered ${errorCount} I/O errors.`);
            }

            resolve({ totalFiles, errorCount });
        });
    });
}

async function performIndexing(): Promise<void> {
    if (config.nasRootPath && !(await checkNasConnection())) {
        return;
    }
    if (isIndexing) {
        console.log('ℹ️ Indexing already in progress. Skipping duplicate request.');
        return;
    }

    isIndexing = true;
    const before = getDbStats();
    console.log(`🚀 Starting background indexing (preserving ${before.totalPhotos} cached memories)...`);

    try {
        await runFullIndexer();
        const after = getDbStats();
        console.log(
            `✅ Indexing complete: ${after.totalPhotos} photos (${after.indexedHashes} hashed, ${after.favoritesCount} favorites, ${after.totalQuotes} quotes).`
        );
        memoryQueue.scheduleRefill();
    } catch (err: any) {
        console.error('❌ Background index failed:', err?.message || err);
    } finally {
        isIndexing = false;
    }
}

// --- DAILY 02:00 SCHEDULER (Jitter-Safe, Runs Exactly Once Per Day) ---
let lastDailyMaintenanceDate = '';
const dailyScheduler = setInterval(() => {
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (now.getHours() === 2 && lastDailyMaintenanceDate !== todayKey) {
        lastDailyMaintenanceDate = todayKey;
        performIndexing();
    }
}, 60_000);

// --- API ROUTES ---

app.get('/api/config', (_req, res) => {
    res.json({
        slideshowIntervalMs: config.slideshowIntervalSeconds * 1000,
        maxVideoDurationSeconds: config.maxVideoDurationSeconds,
        screenWidth: config.screenWidth,
        screenHeight: config.screenHeight
    });
});

app.get('/api/status', (_req, res) => {
    const stats = getDbStats();
    res.json({
        ...stats,
        queueDepth: memoryQueue.getDepth(),
        isIndexing,
        nasOnline: !isNasOffline(),
        uptimeSeconds: Math.floor((Date.now() - bootTimeMs) / 1000)
    });
});

app.get('/api/next-memory', async (req, res) => {
    try {
        const currentPath = typeof req.query.current === 'string' && req.query.current
            ? decodeURIComponent(req.query.current)
            : undefined;
        const payload = await memoryQueue.popNext(currentPath);
        res.json(payload);
    } catch (error: any) {
        console.error('Next-memory error:', error?.message || error);
        res.status(500).json({ error: 'Server Error' });
    }
});

const handleMediaServing = async (req: express.Request, res: express.Response) => {
    try {
        const rawPath = req.query.path;
        if (typeof rawPath !== 'string' || !rawPath) {
            return res.status(400).send('Missing path');
        }
        const filePath = decodeURIComponent(rawPath);

        if (filePath === config.errorImageMarker) {
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': TRANSPARENT_PIXEL_PNG.length,
                'Cache-Control': 'no-store'
            });
            return res.end(TRANSPARENT_PIXEL_PNG);
        }

        const safePath = config.nasRootPath ? assertInsideNas(filePath) : path.resolve(filePath);
        const stat = await safeStat(safePath);
        if (!stat || stat.size <= 0) {
            return res.status(404).send('Media not found');
        }

        if (isVideoFile(safePath)) {
            const { filePath: servePath, contentType } = await ensureOptimizedVideo(safePath);
            return res.sendFile(path.resolve(servePath), {
                acceptRanges: true,
                headers: {
                    'Content-Type': contentType,
                    'Accept-Ranges': 'bytes'
                }
            });
        }

        if (stat.size > config.maxImageSizeBytes) {
            return res.status(413).send(`Image exceeds ${config.maxImageSizeMb}MB limit`);
        }

        const record = getPhotoByPath(safePath);
        const rotation: RotationDegrees = record ? normalizeRotation(record.rotation) : 0;

        const { filePath: displayPath, contentType } = await ensureDisplayImage(safePath, rotation);
        return res.sendFile(path.resolve(displayPath), {
            acceptRanges: true,
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'private, max-age=3600'
            }
        }, (err: any) => {
            if (err && !res.headersSent) {
                console.warn(`⚠️ Failed to send ${path.basename(safePath)}:`, err.message);
                res.status(err.status || 500).end();
            }
        });
    } catch (err: any) {
        if (err instanceof PathSecurityError) {
            return res.status(403).send('Forbidden path');
        }
        console.warn('⚠️ Media serving error:', err?.message || err);
        if (!res.headersSent) {
            res.status(500).send('Media error');
        }
    }
};

app.get('/api/image', handleMediaServing);
app.get('/api/media', handleMediaServing);

// --- CURATION & MANAGEMENT ENDPOINTS ---

app.post('/api/rotate', async (req, res) => {
    try {
        const { currentPath, delta } = req.body || {};
        if (typeof currentPath !== 'string' || !currentPath) {
            return res.status(400).json({ error: 'Missing currentPath' });
        }
        if (delta !== 90 && delta !== -90) {
            return res.status(400).json({ error: 'delta must be 90 or -90' });
        }

        const safePath = config.nasRootPath ? assertInsideNas(currentPath) : path.resolve(currentPath);
        if (isVideoFile(safePath)) {
            return res.status(400).json({ error: 'Rotation is only supported for images' });
        }

        if (!(await safeAccess(safePath))) {
            return res.status(404).json({ error: 'File not found' });
        }

        const existing = getPhotoByPath(safePath);
        const nextRotation = normalizeRotation((existing?.rotation ?? 0) + delta);
        setPhotoRotation(safePath, nextRotation);

        // Pre-render the newly rotated 1280x800 WebP immediately so the UI swap is instant
        await ensureDisplayImage(safePath, nextRotation);
        memoryQueue.invalidatePath(safePath);

        res.json({
            success: true,
            rotation: nextRotation,
            mediaUrl: buildImageMediaUrl(safePath, nextRotation)
        });
    } catch (err: any) {
        if (err instanceof PathSecurityError) {
            return res.status(403).json({ error: 'Forbidden path' });
        }
        console.error('Rotate error:', err);
        res.status(500).json({ error: err?.message || 'Failed to rotate' });
    }
});

app.post('/api/favorite', async (req, res) => {
    try {
        const { currentPath } = req.body || {};
        if (typeof currentPath !== 'string' || !currentPath) {
            return res.status(400).json({ error: 'Missing currentPath' });
        }
        if (!config.nasRootPath) {
            return res.status(500).json({ error: 'NAS Root not configured' });
        }

        const safePath = assertInsideNas(currentPath);
        if (!(await safeAccess(safePath))) {
            return res.status(404).json({ error: 'File not found' });
        }

        const existing = getPhotoByPath(safePath);
        const isCurrentlyFavorite = safePath.includes(`/${config.defaultsFolder}/`) || safePath.includes(`\\${config.defaultsFolder}\\`);

        let targetDir: string;
        let preferredName = path.basename(safePath);
        let originalPathUpdate: string | null;

        if (!isCurrentlyFavorite) {
            // Favoriting: move into _photoframe_defaults and record original album path
            targetDir = path.join(config.nasRootPath, config.defaultsFolder);
            originalPathUpdate = safePath;
        } else {
            // Unfavoriting: restore to original album if recorded & inside NAS, else _photoframe_unfavorited
            let restoredDir: string | null = null;
            if (existing?.originalPath) {
                try {
                    const origSafe = assertInsideNas(existing.originalPath);
                    restoredDir = path.dirname(origSafe);
                    preferredName = path.basename(origSafe);
                } catch {
                    restoredDir = null;
                }
            }
            targetDir = restoredDir || path.join(config.nasRootPath, config.unfavoritedFolder);
            originalPathUpdate = null;
        }

        const newPath = await atomicMoveToDir(safePath, targetDir, preferredName);
        renamePhoto(safePath, newPath, originalPathUpdate);
        memoryQueue.invalidatePath(safePath);

        const isNowFavorite = !isCurrentlyFavorite;
        const rotation = normalizeRotation(existing?.rotation ?? 0);
        const isVideo = isVideoFile(newPath);

        res.json({
            success: true,
            newPath,
            imagePathEncoded: encodeURIComponent(newPath),
            mediaUrl: isVideo ? buildVideoMediaUrl(newPath) : buildImageMediaUrl(newPath, rotation),
            isFavorite: isNowFavorite
        });
    } catch (err: any) {
        if (err instanceof PathSecurityError) {
            return res.status(403).json({ error: 'Forbidden path' });
        }
        console.error('Favorite error:', err);
        res.status(500).json({ error: err?.message || 'Failed to update favorite' });
    }
});

app.post('/api/omit', async (req, res) => {
    try {
        const { currentPath } = req.body || {};
        if (typeof currentPath !== 'string' || !currentPath) {
            return res.status(400).json({ error: 'Missing currentPath' });
        }
        if (!config.nasRootPath) {
            return res.status(500).json({ error: 'NAS Root not configured' });
        }

        const safePath = assertInsideNas(currentPath);
        if (!(await safeAccess(safePath))) {
            return res.status(404).json({ error: 'File not found' });
        }

        const omittedDir = path.join(config.nasRootPath, config.omittedFolder);
        const newPath = await atomicMoveToDir(safePath, omittedDir);
        removePhoto(safePath);
        memoryQueue.invalidatePath(safePath);

        res.json({ success: true, newPath });
    } catch (err: any) {
        if (err instanceof PathSecurityError) {
            return res.status(403).json({ error: 'Forbidden path' });
        }
        console.error('Omit error:', err);
        res.status(500).json({ error: err?.message || 'Failed to omit' });
    }
});

app.delete('/api/photo', async (req, res) => {
    try {
        const { currentPath } = req.body || {};
        if (typeof currentPath !== 'string' || !currentPath) {
            return res.status(400).json({ error: 'Missing currentPath' });
        }

        const safePath = config.nasRootPath ? assertInsideNas(currentPath) : path.resolve(currentPath);
        if (!(await safeAccess(safePath))) {
            return res.status(404).json({ error: 'File not found' });
        }

        await fsPromises.unlink(safePath);
        removePhoto(safePath);
        memoryQueue.invalidatePath(safePath);

        res.json({ success: true });
    } catch (err: any) {
        if (err instanceof PathSecurityError) {
            return res.status(403).json({ error: 'Forbidden path' });
        }
        console.error('Delete error:', err);
        res.status(500).json({ error: err?.message || 'Failed to delete' });
    }
});

app.get('/api/duplicates', async (_req, res) => {
    try {
        if (!config.nasRootPath) return res.status(500).json({ error: 'NAS Root not configured' });
        const duplicatesDir = path.join(config.nasRootPath, config.duplicatesFolder);
        let count = 0;

        if (await safeAccess(duplicatesDir)) {
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
        res.status(500).json({ error: err?.message || 'Failed to inspect duplicates' });
    }
});

app.post('/api/reindex', (_req, res) => {
    res.json({ message: 'Reindexing started...' });
    performIndexing();
});

app.get('/api/weather', async (_req, res) => {
    try {
        const weather = await weatherService.getWeather();
        if (!weather) {
            return res.status(503).json({ error: 'Weather data temporarily unavailable' });
        }
        res.json(weather);
    } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Weather error' });
    }
});

app.post('/api/exit', (_req, res) => {
    res.json({ message: 'Shutting down...' });
    try {
        fs.writeFileSync(config.exitSentinelPath, String(Date.now()));
    } catch {}
    execFile('pkill', ['-f', 'chromium'], () => {});
    setTimeout(() => gracefulShutdown(0), 600);
});

app.post('/api/reboot', (_req, res) => {
    res.json({ message: 'Rebooting system...' });
    try {
        fs.writeFileSync(config.exitSentinelPath, String(Date.now()));
    } catch {}
    execFile('sudo', ['-n', 'systemctl', 'reboot'], (err) => {
        if (err) {
            execFile('sudo', ['-n', 'reboot'], (err2) => {
                if (err2) console.error('❌ Reboot command failed:', err2.message);
            });
        }
    });
});

// --- BOOTSTRAP & GRACEFUL SHUTDOWN ---
let serverInstance: ReturnType<typeof app.listen> | null = null;

function gracefulShutdown(exitCode = 0): void {
    clearInterval(dailyScheduler);
    memoryQueue.stop();
    if (activeIndexerProcess) {
        try { activeIndexerProcess.kill('SIGTERM'); } catch {}
    }
    if (serverInstance) {
        serverInstance.close(() => {
            closeDatabase();
            process.exit(exitCode);
        });
        setTimeout(() => {
            closeDatabase();
            process.exit(exitCode);
        }, 3000);
    } else {
        closeDatabase();
        process.exit(exitCode);
    }
}

process.on('SIGTERM', () => gracefulShutdown(0));
process.on('SIGINT', () => gracefulShutdown(0));

export function startServer(): void {
    ensureMediaCacheDirs();
    initDatabase();

    serverInstance = app.listen(config.port, () => {
        console.log(`Server running on http://localhost:${config.port}`);
        const stats = getDbStats();
        console.log(
            `📚 Database ready: ${stats.totalPhotos} photos (${stats.indexedHashes} hashed, ${stats.favoritesCount} favorites) | 📜 ${stats.totalQuotes} quotes`
        );

        cleanupOrphanedTempFiles().catch(() => {});
        if (stats.totalPhotos === 0) {
            performIndexing();
        } else {
            memoryQueue.start();
        }
        weatherService.fetchForecast().catch(err => {
            console.warn(`[WeatherService] Initial fetch failed: ${err?.message || err}`);
        });
    });
}

if (require.main === module) {
    startServer();
}
