import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { exec, fork } from 'child_process';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURATION ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const model = genAI.getGenerativeModel({ model: modelName });

const PHOTOS_JSON_PATH = process.env.PHOTOS_JSON_PATH || './photos.json';
const TEXTS_JSON_PATH = './texts.json';
const NAS_ROOT_PATH = process.env.NAS_ROOT_PATH;
const ERROR_IMAGE_MARKER = 'SYSTEM_ERROR_IMAGE';

// --- DATA STRUCTURES ---
interface Photo {
    path: string;
    created: string;
}

interface TextEntry {
    content: string;
    type: 'poem' | 'quote';
    author: string | null;
}

// In-Memory Storage
// We use a Set for fast "exists" checks to avoid duplicates during auto-reindex
let photoPaths = new Set<string>(); 
let photoLibrary: Photo[] = [];
let textLibrary: Record<string, TextEntry> = {};

// Flags
let isDirtyPhotos = false; // Tracks if we need to save photos.json

// --- PERSISTENCE HELPERS ---

const loadLibraries = () => {
    // 1. Load Photos
    try {
        if (fs.existsSync(PHOTOS_JSON_PATH)) {
            const data = fs.readFileSync(PHOTOS_JSON_PATH, 'utf-8');
            photoLibrary = JSON.parse(data);
            // Rebuild the Set for fast lookups
            photoPaths = new Set(photoLibrary.map(p => p.path));
            console.log(`📚 Photos loaded: ${photoLibrary.length}`);
        }
    } catch (e) { console.error("Error loading photos:", e); }

    // 2. Load Texts (Poems/Quotes cache)
    try {
        if (fs.existsSync(TEXTS_JSON_PATH)) {
            const data = fs.readFileSync(TEXTS_JSON_PATH, 'utf-8');
            textLibrary = JSON.parse(data);
            console.log(`📜 Texts loaded: ${Object.keys(textLibrary).length}`);
        }
    } catch (e) { console.error("Error loading texts:", e); }
};

const savePhotosToDisk = () => {
    if (!isDirtyPhotos) return;
    try {
        fs.writeFileSync(PHOTOS_JSON_PATH, JSON.stringify(photoLibrary, null, 2));
        console.log(`💾 Saved ${photoLibrary.length} photos to disk.`);
        isDirtyPhotos = false;
    } catch (e) { console.error("Error saving photos:", e); }
};

const saveTextsToDisk = () => {
    try {
        fs.writeFileSync(TEXTS_JSON_PATH, JSON.stringify(textLibrary, null, 2));
    } catch (e) { console.error("Error saving texts:", e); }
};

// --- INDEXING LOGIC ---

/**
 * Runs the indexer script as a child process.
 * It listens for 'batch' messages to update memory incrementally.
 */
const runIndexer = (mode: 'defaults' | 'full'): Promise<void> => {
    return new Promise((resolve, reject) => {
        // Validation: Don't start indexing if NAS is missing
        if (NAS_ROOT_PATH && !fs.existsSync(NAS_ROOT_PATH)) {
            console.error("CRITICAL: NAS Root path not found during index attempt:", NAS_ROOT_PATH);
            return reject(new Error("NAS not mounted"));
        }

        console.log(`Triggering Indexer [${mode}]...`);
        
        // We use 'fork' to enable IPC (Inter-Process Communication) easily.
        // ts-node automatically handles .ts files when forking if started via ts-node.
        const indexer = fork('src/indexer.ts', [`--mode=${mode}`]);

        indexer.on('message', (msg: any) => {
            if (msg.type === 'batch' && Array.isArray(msg.photos)) {
                let addedCount = 0;
                msg.photos.forEach((p: Photo) => {
                    if (!photoPaths.has(p.path)) {
                        photoPaths.add(p.path);
                        photoLibrary.push(p);
                        addedCount++;
                    }
                });
                
                if (addedCount > 0) {
                    isDirtyPhotos = true; // Mark for next save cycle
                }
            }
        });

        indexer.on('close', (code) => {
            if (code === 0) {
                console.log(`Indexer [${mode}] finished.`);
                savePhotosToDisk(); // Force save at end of run
                resolve();
            } else {
                reject();
            }
        });
    });
};

/**
 * Orchestrates the reindexing process.
 * @param clearCache If true, wipes memory before starting (Manual/First Run). If false, appends (Auto-Nightly).
 */
const performIndexing = async (clearCache: boolean) => {
    if (clearCache) {
        console.log("🧹 Clearing Cache for Full Reindex...");
        photoLibrary = [];
        photoPaths.clear();
        isDirtyPhotos = true;
        
        // 1. Defaults First (Blocking-ish, we wait for it)
        try { await runIndexer('defaults'); } catch (e) { console.error("Defaults load failed"); }
    }

    // 2. Full Scan (Background)
    runIndexer('full').catch(err => console.error("Background index failed"));
};

// --- SCHEDULING ---

// 1. Persistence Loop (Every 30 seconds)
setInterval(() => {
    savePhotosToDisk();
}, 30 * 1000);

// 2. Auto-Reindex Loop (Checks every minute)
setInterval(() => {
    const now = new Date();
    // Run at 02:00 AM
    if (now.getHours() === 2 && now.getMinutes() === 0) {
        console.log("🕑 2AM Auto-Index Triggered.");
        performIndexing(false); // False = Do not clear cache, just append new files
    }
}, 60 * 1000);


// --- API LOGIC ---

function fileToGenerativePart(filePath: string, mimeType: string) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
            mimeType
        },
    };
}

app.get('/api/next-memory', async (req, res) => {
    try {
        // CRITICAL CHECK: Ensure Volume is Mounted
        if (NAS_ROOT_PATH && !fs.existsSync(NAS_ROOT_PATH)) {
            console.error(`ERROR: Volume at ${NAS_ROOT_PATH} is not accessible.`);
            return res.json({
                text: "⚠️ System Error: Photo storage volume is not mounted. Please check NAS connection.",
                type: 'quote',
                author: "System Alert",
                date: new Date().toISOString(),
                imagePathEncoded: ERROR_IMAGE_MARKER // Special marker for the image endpoint
            });
        }

        if (photoLibrary.length === 0) {
            return res.status(503).json({ error: "Indexing photos..." });
        }

        // 1. Select Random Photo
        const randomIndex = Math.floor(Math.random() * photoLibrary.length);
        const selectedPhoto = photoLibrary[randomIndex];

        if (!fs.existsSync(selectedPhoto.path)) {
            // Cleanup bad link
            photoLibrary.splice(randomIndex, 1);
            photoPaths.delete(selectedPhoto.path);
            return res.status(500).json({ error: "File missing" });
        }

        // 2. CHECK CACHE (texts.json)
        let aiResponse: TextEntry;

        if (textLibrary[selectedPhoto.path]) {
            // CACHE HIT: Use saved poem
            aiResponse = textLibrary[selectedPhoto.path];
        } else {
            // CACHE MISS: Call Gemini
            // console.log("✨ Generating new poem for:", path.basename(selectedPhoto.path));
            const prompt = `
                You are a poetic assistant. Look at this image.
                Task: Generate EITHER a short, beautiful poem (max 4 lines) OR select a profound famous quote that matches the mood.
                Language: Randomly choose between Portuguese (European - PT-PT) or English.
                Output Format: JSON only.
                Structure: { "content": "The poem or quote text", "type": "poem" OR "quote", "author": "Author Name or null" }
            `;

            try {
                const imagePart = fileToGenerativePart(selectedPhoto.path, "image/jpeg");
                const result = await model.generateContent([prompt, imagePart]);
                const text = result.response.text();
                const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
                
                aiResponse = JSON.parse(cleanText);

                // SAVE TO CACHE
                textLibrary[selectedPhoto.path] = aiResponse;
                saveTextsToDisk(); // Save immediately to prevent API waste

            } catch (aiError) {
                console.error("Gemini Error:", aiError);
                aiResponse = { content: "Memories are timeless treasures.", type: "poem", author: null };
            }
        }

        res.json({
            text: aiResponse.content,
            type: aiResponse.type,
            author: aiResponse.author,
            date: selectedPhoto.created,
            imagePathEncoded: encodeURIComponent(selectedPhoto.path) 
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
});

app.get('/api/image', (req, res) => {
    const filePath = decodeURIComponent(req.query.path as string);
    
    // Fallback for System Errors
    if (filePath === ERROR_IMAGE_MARKER) {
        // Return a 1x1 transparent pixel so the frontend image loads (and shows the text overlay)
        const img = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==", 'base64');
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': img.length
        });
        return res.end(img);
    }

    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Image not found');
    res.sendFile(filePath);
});

app.post('/api/exit', (req, res) => {
    res.json({ message: 'Shutting down...' });
    exec('killall chromium-browser', () => setTimeout(() => process.exit(0), 1000));
});

// Manual Reindex (Triple Tap)
app.post('/api/reindex', (req, res) => {
    res.json({ message: 'Reindexing started...' });
    // Manual trigger = Clear cache and rebuild
    performIndexing(true);
});

// Start
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    loadLibraries();

    // First Run Logic
    if (photoLibrary.length === 0) {
        console.log("⚠️ Library empty. Starting First-Run Indexing.");
        performIndexing(true);
    }
});