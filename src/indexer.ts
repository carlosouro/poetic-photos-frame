import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const NAS_ROOT_PATH = process.env.NAS_ROOT_PATH || './test-photos'; 
const DEFAULTS_FOLDER_NAME = '_photoframe_defaults';
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const BATCH_SIZE = 50; // Send photos to server in batches of 50 to reduce IPC overhead

interface Photo {
    path: string;
    created: string;
}

// Determine Mode
const args = process.argv.slice(2);
const isDefaultsMode = args.includes('--mode=defaults');

// Check if we are running as a child process with IPC
const hasIPC = !!process.send;

if (!hasIPC) {
    console.warn("⚠️ Indexer running in standalone mode. No data will be sent to server.");
}

function scanDirectory(dir: string, batchBuffer: Photo[]) {
    if (!fs.existsSync(dir)) return;

    try {
        // CHANGE: Sort in reverse order immediately after reading.
        // This ensures "2025" is processed before "2024", etc.
        const files = fs.readdirSync(dir).sort().reverse();

        for (const file of files) {
            // Skip hidden files or Synology thumbnails (@eaDir)
            if (file.startsWith('.') || file.startsWith('@')) continue;

            const filePath = path.join(dir, file);
            let stat;

            try {
                stat = fs.statSync(filePath);
            } catch (e) { continue; }

            if (stat.isDirectory()) {
                scanDirectory(filePath, batchBuffer);
            } else {
                const ext = path.extname(file).toLowerCase();
                if (EXTENSIONS.has(ext)) {
                    const photo = {
                        path: filePath,
                        // CHANGE: Use mtime (Modified Time) for correct photo dates
                        created: stat.mtime.toISOString()
                    };
                    
                    batchBuffer.push(photo);

                    // If buffer is full, send to parent and clear
                    if (batchBuffer.length >= BATCH_SIZE && hasIPC) {
                        process.send!({ type: 'batch', photos: batchBuffer });
                        batchBuffer.length = 0; // Clear array
                    }
                }
            }
        }
    } catch (err) {
        console.error(`Error scanning ${dir}:`, err);
    }
}

// Main Execution
const batchBuffer: Photo[] = [];
let targetPath = NAS_ROOT_PATH;

if (isDefaultsMode) {
    targetPath = path.join(NAS_ROOT_PATH, DEFAULTS_FOLDER_NAME);
}

console.log(`📷 Indexer started. Scanning: ${targetPath}`);
scanDirectory(targetPath, batchBuffer);

// Send remaining photos in buffer
if (batchBuffer.length > 0 && hasIPC) {
    process.send!({ type: 'batch', photos: batchBuffer });
}

console.log(`✅ Indexer finished.`);
process.exit(0);