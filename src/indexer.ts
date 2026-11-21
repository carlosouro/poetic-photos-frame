import { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { ALL_MEDIA_EXTENSIONS, config, VIDEO_EXTENSIONS } from './config';
import { ScannedPhoto } from './types';

// Lowest CPU and I/O scheduling priority to keep slideshow completely fluid on Pi 4
try {
    os.setPriority(os.constants.priority.PRIORITY_LOW);
} catch {}

if (process.platform === 'linux') {
    try {
        execFile('ionice', ['-c', '3', '-p', String(process.pid)], () => {});
    } catch {}
}

const BATCH_SIZE = 50;
const THROTTLE_DIR_MS = 12;
const THROTTLE_BATCH_MS = 20;

const hasIPC = typeof process.send === 'function';
if (!hasIPC) {
    console.warn('⚠️ Indexer running in standalone mode.');
}

let totalDirs = 0;
let totalFiles = 0;
let errorCount = 0;

function sendIpc(payload: any): Promise<void> {
    if (!hasIPC) return Promise.resolve();
    return new Promise((resolve) => {
        (process as any).send(payload, () => resolve());
    });
}

async function scanDirectory(dir: string, batchBuffer: ScannedPhoto[]): Promise<void> {
    try {
        await fsPromises.access(dir);
    } catch {
        errorCount++;
        return;
    }

    totalDirs++;

    try {
        // Reverse sort prioritizes newer year/month folders first
        const rawEntries = await fsPromises.readdir(dir);
        const files = rawEntries.sort().reverse();

        for (const file of files) {
            // Skip hidden files, Synology @eaDir thumbnails, omitted, and quarantined duplicates.
            // Note: _photoframe_defaults AND _photoframe_unfavorited ARE indexed so unfavorited photos remain in library.
            if (
                file.startsWith('.') ||
                file.startsWith('@') ||
                file === config.omittedFolder ||
                file === config.duplicatesFolder
            ) {
                continue;
            }

            const filePath = path.join(dir, file);
            let lstat;
            try {
                // Single lstat() call (eliminates redundant stat() round-trips over CIFS)
                lstat = await fsPromises.lstat(filePath);
            } catch {
                errorCount++;
                continue;
            }

            if (lstat.isSymbolicLink()) continue;

            if (lstat.isDirectory()) {
                await scanDirectory(filePath, batchBuffer);
                await new Promise(r => setTimeout(r, THROTTLE_DIR_MS));
            } else if (lstat.isFile()) {
                if (lstat.size <= 0) continue;
                const ext = path.extname(file).toLowerCase();
                if (!ALL_MEDIA_EXTENSIONS.has(ext)) continue;

                const isVideo = VIDEO_EXTENSIONS.has(ext);
                const maxSize = isVideo ? config.maxVideoSizeBytes : config.maxImageSizeBytes;
                if (lstat.size > maxSize) continue;

                totalFiles++;
                batchBuffer.push({
                    path: filePath,
                    created: lstat.mtime.toISOString(),
                    mediaType: isVideo ? 'video' : 'image'
                });

                if (batchBuffer.length >= BATCH_SIZE) {
                    await sendIpc({ type: 'batch', photos: [...batchBuffer] });
                    batchBuffer.length = 0;
                    await new Promise(r => setTimeout(r, THROTTLE_BATCH_MS));
                }
            }
        }
    } catch (err: any) {
        errorCount++;
        console.error(`❌ Error scanning ${dir}:`, err?.message || err);
    }
}

(async () => {
    const targetPath = config.nasRootPath || path.resolve('./test-photos');
    const batchBuffer: ScannedPhoto[] = [];

    console.log(`📷 Indexer started (Nice=19, Ionice=Idle). Scanning: ${targetPath}`);
    await scanDirectory(targetPath, batchBuffer);

    if (batchBuffer.length > 0) {
        await sendIpc({ type: 'batch', photos: batchBuffer });
    }

    await sendIpc({
        type: 'done',
        totalFiles,
        totalDirs,
        errorCount
    });

    console.log(`✅ Indexer finished: ${totalFiles} files in ${totalDirs} directories (${errorCount} errors).`);
    process.exit(0);
})();
