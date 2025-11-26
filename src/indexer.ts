import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configuration
const NAS_ROOT_PATH = process.env.NAS_ROOT_PATH || './test-photos'; 
const PHOTOS_JSON_PATH = process.env.PHOTOS_JSON_PATH || './photos.json';
const DEFAULTS_FOLDER_NAME = '_photoframe_defaults';

// Allowed image types
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

interface Photo {
    path: string;
    created: string;
}

// Determine Mode
const args = process.argv.slice(2);
const isDefaultsMode = args.includes('--mode=defaults');

console.log(`📷 Starting Indexer... Mode: [${isDefaultsMode ? 'DEFAULTS ONLY' : 'FULL LIBRARY'}]`);

function scanDirectory(dir: string, fileList: Photo[] = []) {
    if (!fs.existsSync(dir)) {
        console.warn(`Path does not exist: ${dir}`);
        return fileList;
    }

    try {
        const files = fs.readdirSync(dir);

        for (const file of files) {
            // Skip hidden files
            if (file.startsWith('.') || file.startsWith('@')) continue;

            const filePath = path.join(dir, file);
            let stat;

            try {
                stat = fs.statSync(filePath);
            } catch (e) {
                continue;
            }

            if (stat.isDirectory()) {
                scanDirectory(filePath, fileList);
            } else {
                const ext = path.extname(file).toLowerCase();
                if (EXTENSIONS.has(ext)) {
                    // CHANGE: Use mtime (Modified Time) to ensure correct dates
                    fileList.push({
                        path: filePath,
                        created: stat.mtime.toISOString()
                    });
                }
            }
        }
    } catch (err) {
        console.error(`Error scanning directory ${dir}:`, err);
    }

    return fileList;
}

// Main Execution
const photos: Photo[] = [];
let targetPath = NAS_ROOT_PATH;

if (isDefaultsMode) {
    targetPath = path.join(NAS_ROOT_PATH, DEFAULTS_FOLDER_NAME);
}

console.log(`Scanning: ${targetPath}...`);
const foundPhotos = scanDirectory(targetPath, photos);

console.log(`✅ Found ${foundPhotos.length} photos.`);

try {
    fs.writeFileSync(PHOTOS_JSON_PATH, JSON.stringify(foundPhotos, null, 2));
    console.log(`💾 Saved index to ${PHOTOS_JSON_PATH}`);
} catch (err) {
    console.error('Error writing JSON file:', err);
    process.exit(1);
}