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

const NAS_ROOT_PATH = process.env.NAS_ROOT_PATH;
const ERROR_IMAGE_MARKER = 'SYSTEM_ERROR_IMAGE';

// --- CACHE SETUP ---
const CACHE_DIR = './cache';
const PHOTOS_JSON_PATH = path.join(CACHE_DIR, 'photos.json');
const TEXTS_JSON_PATH = path.join(CACHE_DIR, 'texts.json');

if (!fs.existsSync(CACHE_DIR)) {
    console.log(`Creating cache directory at ${CACHE_DIR}`);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

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

let photoPaths = new Set<string>(); 
let photoLibrary: Photo[] = [];
let textLibrary: Record<string, TextEntry> = {};

let isDirtyPhotos = false; 
let isIndexing = false; 

// --- PERSISTENCE HELPERS ---

const loadLibraries = () => {
    try {
        if (fs.existsSync(PHOTOS_JSON_PATH)) {
            const data = fs.readFileSync(PHOTOS_JSON_PATH, 'utf-8');
            photoLibrary = JSON.parse(data);
            photoPaths = new Set(photoLibrary.map(p => p.path));
            console.log(`📚 Photos loaded from cache: ${photoLibrary.length}`);
        }
    } catch (e) { console.error("Error loading photos cache:", e); }

    try {
        if (fs.existsSync(TEXTS_JSON_PATH)) {
            const data = fs.readFileSync(TEXTS_JSON_PATH, 'utf-8');
            textLibrary = JSON.parse(data);
            console.log(`📜 Texts loaded from cache: ${Object.keys(textLibrary).length}`);
        }
    } catch (e) { console.error("Error loading texts cache:", e); }
};

const savePhotosToDisk = () => {
    if (!isDirtyPhotos) return;
    try {
        fs.writeFileSync(PHOTOS_JSON_PATH, JSON.stringify(photoLibrary, null, 2));
        console.log(`💾 Persisted ${photoLibrary.length} photos to cache.`);
        isDirtyPhotos = false;
    } catch (e) { console.error("Error saving photos:", e); }
};

const saveTextsToDisk = () => {
    try {
        fs.writeFileSync(TEXTS_JSON_PATH, JSON.stringify(textLibrary, null, 2));
    } catch (e) { console.error("Error saving texts:", e); }
};

// --- INDEXING LOGIC ---

const runIndexer = (mode: 'defaults' | 'full'): Promise<void> => {
    return new Promise((resolve, reject) => {
        console.log(`Triggering Indexer [${mode}]...`);
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
                if (addedCount > 0) isDirtyPhotos = true; 
            }
        });

        indexer.on('close', (code) => {
            if (code === 0) {
                console.log(`Indexer [${mode}] finished.`);
                resolve();
            } else {
                console.error(`Indexer [${mode}] failed/exited with code ${code}`);
                reject(new Error(`Indexer failed with code ${code}`));
            }
        });
    });
};

const performIndexing = async (clearCache: boolean) => {
    if (NAS_ROOT_PATH && !fs.existsSync(NAS_ROOT_PATH)) {
        console.error("❌ CRITICAL: NAS Root path not found. Indexing aborted.");
        isIndexing = false;
        return; 
    }

    isIndexing = true;

    if (clearCache) {
        console.log("🧹 Clearing Memory for Full Reindex...");
        photoLibrary = [];
        photoPaths.clear();
        isDirtyPhotos = true; 
        try { await runIndexer('defaults'); } catch (e) { console.error("Defaults load failed"); }
    }

    runIndexer('full')
        .then(() => {
            console.log("✅ Full Indexing Complete.");
            savePhotosToDisk(); 
        })
        .catch(err => console.error("❌ Background index failed:", err))
        .finally(() => isIndexing = false);
};

// --- SCHEDULING ---

setInterval(() => savePhotosToDisk(), 30 * 1000);

setInterval(() => {
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() === 0) {
        console.log("🕑 2AM Auto-Index Triggered.");
        performIndexing(false); 
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

// NEW HELPER: Retry Logic for AI
async function generateWithRetry(prompt: string, imagePart: any, retries = 3, delay = 1000): Promise<string> {
    try {
        const result = await model.generateContent([prompt, imagePart]);
        return result.response.text();
    } catch (error: any) {
        // Check for overload (503) or generic failures
        if (retries > 0 && (error.message?.includes('503') || error.message?.includes('overloaded'))) {
            console.warn(`⚠️ Gemini overloaded. Retrying in ${delay}ms... (${retries} attempts left)`);
            await new Promise(r => setTimeout(r, delay));
            return generateWithRetry(prompt, imagePart, retries - 1, delay * 2); // Exponential backoff
        }
        throw error;
    }
}

app.get('/api/next-memory', async (req, res) => {
    try {
        if (NAS_ROOT_PATH && !fs.existsSync(NAS_ROOT_PATH)) {
            return res.json({
                text: "⚠️ System Alert: Storage not accessible. Please check connection.",
                type: 'quote',
                author: "System Alert",
                date: new Date().toISOString(),
                imagePathEncoded: ERROR_IMAGE_MARKER
            });
        }

        if (photoLibrary.length === 0) {
            if (isIndexing) return res.status(503).json({ error: "Indexing photos..." });
            return res.json({
                text: "⚠️ No photos found in library. Try re-indexing.",
                type: 'quote',
                author: "System Alert",
                date: new Date().toISOString(),
                imagePathEncoded: ERROR_IMAGE_MARKER
            });
        }

        const randomIndex = Math.floor(Math.random() * photoLibrary.length);
        const selectedPhoto = photoLibrary[randomIndex];

        if (!fs.existsSync(selectedPhoto.path)) {
            photoLibrary.splice(randomIndex, 1);
            photoPaths.delete(selectedPhoto.path);
            return res.status(500).json({ error: "File missing" });
        }

        let aiResponse: TextEntry;

        if (textLibrary[selectedPhoto.path]) {
            aiResponse = textLibrary[selectedPhoto.path];
        } else {
            const prompt = `
                You are a poetic assistant. Look at this image.
                Task: Generate EITHER a short, beautiful poem (max 4 lines) OR select a profound famous quote that matches the mood.
                Language: Randomly choose between Portuguese (European - PT-PT) or English.
                Output Format: JSON only.
                Structure: { "content": "The poem or quote text", "type": "poem" OR "quote", "author": "Author Name or null" }
            `;

            try {
                const imagePart = fileToGenerativePart(selectedPhoto.path, "image/jpeg");
                
                // CHANGE: Use the new retry helper instead of calling model directly
                const text = await generateWithRetry(prompt, imagePart);
                
                const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
                aiResponse = JSON.parse(cleanText);

                textLibrary[selectedPhoto.path] = aiResponse;
                saveTextsToDisk(); 

            } catch (aiError) {
                console.error("Gemini Final Error:", aiError);
                aiResponse = { content: "Memories are timeless treasures of the heart.", type: "poem", author: null };
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
    if (filePath === ERROR_IMAGE_MARKER) {
        const img = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==", 'base64');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
        return res.end(img);
    }
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Image not found');
    res.sendFile(filePath);
});

app.post('/api/exit', (req, res) => {
    res.json({ message: 'Shutting down...' });
    exec('killall chromium-browser', () => setTimeout(() => process.exit(0), 1000));
});

app.post('/api/reindex', (req, res) => {
    res.json({ message: 'Reindexing started...' });
    performIndexing(true);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    loadLibraries();
    if (photoLibrary.length === 0) {
        console.log("⚠️ Library empty. Starting First-Run Indexing.");
        performIndexing(true);
    }
});