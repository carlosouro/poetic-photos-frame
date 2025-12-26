import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const NAS_ROOT_PATH = process.env.NAS_ROOT_PATH || './test-photos'; 
const DEFAULTS_FOLDER_NAME = '_photoframe_defaults';
const OMITTED_FOLDER_NAME = '_photoframe_omitted';
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const BATCH_SIZE = 50; 

interface Photo {
    path: string;
    created: string;
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
        // FIXED: Cast process to 'any' to bypass TypeScript overload confusion.
        (process as any).send({ type: 'batch', photos: photos }, (err: any) => {
            if (cb) cb();
        });
    } else {
        if (cb) cb();
    }
}

function scanDirectory(dir: string, batchBuffer: Photo[]) {
    if (!fs.existsSync(dir)) return;

    totalDirs++;
    // Log progress every 100 directories
    if (totalDirs % 100 === 0) process.stdout.write(`\r📂 Scanned ${totalDirs} directories...`);

    try {
        // Sort reverse to prioritize newer folders
        const files = fs.readdirSync(dir).sort().reverse();

        for (const file of files) {
            // Skip hidden files, Synology thumbnails (@eaDir), OR the OMITTED folder
            if (file.startsWith('.') || file.startsWith('@') || file === OMITTED_FOLDER_NAME) continue;

            const filePath = path.join(dir, file);
            let stat;

            try {
                // Use lstat to check for symlinks first to avoid loops
                const lstat = fs.lstatSync(filePath);
                if (lstat.isSymbolicLink()) continue; 
                
                stat = fs.statSync(filePath);
            } catch (e) { continue; }

            if (stat.isDirectory()) {
                scanDirectory(filePath, batchBuffer);
            } else {
                const ext = path.extname(file).toLowerCase();
                if (EXTENSIONS.has(ext)) {
                    totalFiles++;
                    batchBuffer.push({
                        path: filePath,
                        created: stat.mtime.toISOString()
                    });

                    if (batchBuffer.length >= BATCH_SIZE) {
                        sendBatch([...batchBuffer]);
                        batchBuffer.length = 0; 
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

console.log(`📷 Indexer started. Scanning: ${targetPath}`);
scanDirectory(targetPath, batchBuffer);

console.log(`\n✅ Scan complete. Found ${totalFiles} files in ${totalDirs} directories.`);
console.log(`🚚 Flushing final data...`);

// Send remaining items and WAIT for callback before exiting
if (batchBuffer.length > 0) {
    sendBatch(batchBuffer, () => {
        console.log("👋 Final batch sent. Exiting.");
        process.exit(0);
    });
} else {
    // If empty, just exit (but give a small tick for any previous sends to clear)
    setTimeout(() => {
        console.log("👋 Exiting.");
        process.exit(0);
    }, 1000);
}