import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

// Apply lowest CPU and I/O scheduling priority to keep photo slideshow completely fluid
try {
    os.setPriority(os.constants.priority.PRIORITY_LOW);
} catch (e) {}

if (process.platform === 'linux') {
    try {
        exec(`ionice -c 3 -p ${process.pid}`, () => {});
    } catch (e) {}
}

const NAS_ROOT_PATH = process.env.NAS_ROOT_PATH || './test-photos'; 
const DEFAULTS_FOLDER_NAME = '_photoframe_defaults';
const OMITTED_FOLDER_NAME = '_photoframe_omitted';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const ALL_MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const MAX_VIDEO_SIZE_MB = parseInt(process.env.MAX_VIDEO_SIZE_MB || '50', 10);
const MAX_IMAGE_SIZE_MB = parseInt(process.env.MAX_IMAGE_SIZE_MB || '25', 10);
const MAX_VIDEO_SIZE_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;
const BATCH_SIZE = 50; 
const THROTTLE_DIR_MS = 15;   // Cooperative yield after scanning each directory
const THROTTLE_BATCH_MS = 25; // Cooperative yield after dispatching each batch

interface Photo {
    path: string;
    created: string;
    mediaType?: 'image' | 'video';
}

const args = process.argv.slice(2);
const isDefaultsMode = args.includes('--mode=defaults');
const hasIPC = !!process.send;

if (!hasIPC) console.warn("⚠️ Indexer running in standalone mode.");

// Stats counters
let totalDirs = 0;
let totalFiles = 0;

function sendBatch(photos: Photo[], cb?: () => void) {
    if (hasIPC) {
        (process as any).send({ type: 'batch', photos: photos }, (err: any) => {
            if (cb) cb();
        });
    } else {
        if (cb) cb();
    }
}

async function scanDirectory(dir: string, batchBuffer: Photo[]) {
    try {
        await fsPromises.access(dir);
    } catch {
        return;
    }

    totalDirs++;
    // Log progress every 100 directories
    if (totalDirs % 100 === 0) process.stdout.write(`\r📂 Scanned ${totalDirs} directories...`);

    try {
        // Sort reverse to prioritize newer folders
        const rawEntries = await fsPromises.readdir(dir);
        const files = rawEntries.sort().reverse();

        for (const file of files) {
            // Skip hidden files, Synology thumbnails (@eaDir), OR the OMITTED folder
            if (file.startsWith('.') || file.startsWith('@') || file === OMITTED_FOLDER_NAME) continue;

            const filePath = path.join(dir, file);
            let stat;

            try {
                // Use lstat to check for symlinks first to avoid loops
                const lstat = await fsPromises.lstat(filePath);
                if (lstat.isSymbolicLink()) continue; 
                
                stat = await fsPromises.stat(filePath);
            } catch (e) { continue; }

            if (stat.isDirectory()) {
                await scanDirectory(filePath, batchBuffer);
                // Cooperative yield to keep CIFS socket free for slideshow streaming
                await new Promise(r => setTimeout(r, THROTTLE_DIR_MS));
            } else {
                if (stat.size <= 0) continue;
                const ext = path.extname(file).toLowerCase();
                if (ALL_MEDIA_EXTENSIONS.has(ext)) {
                    const isVideo = VIDEO_EXTENSIONS.has(ext);
                    const maxSize = isVideo ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;
                    if (stat.size > maxSize) {
                        continue;
                    }

                    totalFiles++;
                    batchBuffer.push({
                        path: filePath,
                        created: stat.mtime.toISOString(),
                        mediaType: isVideo ? 'video' : 'image'
                    });

                    if (batchBuffer.length >= BATCH_SIZE) {
                        await new Promise<void>(resolve => {
                            sendBatch([...batchBuffer], () => resolve());
                        });
                        batchBuffer.length = 0; 
                        await new Promise(r => setTimeout(r, THROTTLE_BATCH_MS));
                    }
                }
            }
        }
    } catch (err) {
        console.error(`\n❌ Error scanning ${dir}:`, err);
    }
}

// --- MAIN ---

const batchBuffer: Photo[] = [];
let targetPath = NAS_ROOT_PATH;

if (isDefaultsMode) {
    targetPath = path.join(NAS_ROOT_PATH, DEFAULTS_FOLDER_NAME);
}

(async () => {
    console.log(`📷 Indexer started (Nice=19, Ionice=Idle). Scanning: ${targetPath}`);
    await scanDirectory(targetPath, batchBuffer);

    console.log(`\n✅ Scan complete. Found ${totalFiles} files in ${totalDirs} directories.`);
    console.log(`🚚 Flushing final data...`);

    // Send remaining items and WAIT for callback before exiting
    if (batchBuffer.length > 0) {
        sendBatch(batchBuffer, () => {
            console.log("👋 Final batch sent. Exiting.");
            process.exit(0);
        });
    } else {
        setTimeout(() => {
            console.log("👋 Exiting.");
            process.exit(0);
        }, 500);
    }
})();