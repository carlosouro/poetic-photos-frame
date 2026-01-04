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

// Default to the latest Flash model for cost efficiency
const modelName = process.env.GEMINI_MODEL || "gemini-flash-latest";

// We use 'v1beta' to ensure access to the latest model aliases
const model = genAI.getGenerativeModel({ 
    model: modelName,
    apiVersion: 'v1beta' 
} as any);

const NAS_ROOT_PATH = process.env.NAS_ROOT_PATH;
const DEFAULTS_FOLDER_NAME = '_photoframe_defaults';
const OMITTED_FOLDER_NAME = '_photoframe_omitted';
const UNFAVORITED_FOLDER_NAME = '_photoframe_unfavorited';
const ERROR_IMAGE_MARKER = 'SYSTEM_ERROR_IMAGE';

// --- CACHE SETUP ---
const CACHE_DIR = './cache';
const PHOTOS_JSON_PATH = path.join(CACHE_DIR, 'photos.json');
const TEXTS_JSON_PATH = path.join(CACHE_DIR, 'texts.json');

// Ensure cache directory exists immediately
if (!fs.existsSync(CACHE_DIR)) {
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

// --- SMART PHOTO SELECTION ---

function selectSmartPhoto(): Photo | null {
    if (photoLibrary.length === 0) return null;

    const now = new Date();
    const msPerDay = 1000 * 60 * 60 * 24;

    // 1. Identify Favorites (Photos located in the defaults folder)
    const favorites = photoLibrary.filter(p => p.path.includes(DEFAULTS_FOLDER_NAME));

    // 2. Identify Smart Candidates (Recent 30 Days + On This Day)
    const smartCandidates = photoLibrary.filter(photo => {
        const pDate = new Date(photo.created);
        if (isNaN(pDate.getTime())) return false;

        // A. Recent check (last 30 days)
        const diffTime = now.getTime() - pDate.getTime();
        const diffDays = diffTime / msPerDay;
        if (diffDays >= 0 && diffDays <= 30) return true;

        // B. "On This Day" check (ignoring year, +/- 10 days)
        const pDateCurrentYear = new Date(pDate);
        pDateCurrentYear.setFullYear(now.getFullYear());
        
        const timeDiff = Math.abs(now.getTime() - pDateCurrentYear.getTime());
        const dayDiff = Math.ceil(timeDiff / msPerDay);

        return dayDiff <= 10;
    });

    // 3. Weighted Selection Logic
    const roll = Math.random(); 

    // 80% Chance: Try Smart Candidates
    if (roll < 0.8) {
        if (smartCandidates.length > 0) {
            return smartCandidates[Math.floor(Math.random() * smartCandidates.length)];
        }
        // Fallback: If no smart matches, try favorites
        if (favorites.length > 0) {
            return favorites[Math.floor(Math.random() * favorites.length)];
        }
    } 
    
    // 10% Chance: Try Favorites (Roll 0.8 to 0.9)
    if (roll < 0.9) {
        if (favorites.length > 0) {
            return favorites[Math.floor(Math.random() * favorites.length)];
        }
    }

    // 10% Chance (Roll 0.9 to 1.0) OR Fallback: Random Library
    return photoLibrary[Math.floor(Math.random() * photoLibrary.length)];
}

// --- INDEXING LOGIC ---

const runIndexer = (mode: 'defaults' | 'full'): Promise<void> => {
    return new Promise((resolve, reject) => {
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
            if (code === 0) resolve();
            else reject(new Error(`Indexer failed with code ${code}`));
        });
    });
};

const performIndexing = async (clearCache: boolean) => {
    if (NAS_ROOT_PATH && !fs.existsSync(NAS_ROOT_PATH)) {
        isIndexing = false;
        return; 
    }

    isIndexing = true;

    if (clearCache) {
        photoLibrary = [];
        photoPaths.clear();
        isDirtyPhotos = true; 
        try { await runIndexer('defaults'); } catch (e) { console.error("Defaults load failed"); }
    }

    runIndexer('full')
        .then(() => {
            savePhotosToDisk(); 
        })
        .catch(err => console.error("❌ Background index failed:", err))
        .finally(() => isIndexing = false);
};

// --- SCHEDULING ---
setInterval(() => savePhotosToDisk(), 30 * 1000);
setInterval(() => {
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() === 0) performIndexing(false); 
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

async function generateWithRetry(prompt: string, imagePart: any, retries = 3, delay = 1000): Promise<string> {
    try {
        const result = await model.generateContent([prompt, imagePart]);
        return result.response.text();
    } catch (error: any) {
        if (error.message?.includes('404')) throw error;

        if (retries > 0 && (error.message?.includes('503') || error.message?.includes('overloaded'))) {
            await new Promise(r => setTimeout(r, delay));
            return generateWithRetry(prompt, imagePart, retries - 1, delay * 2);
        }
        throw error;
    }
}

app.get('/api/next-memory', async (req, res) => {
    try {
        if (NAS_ROOT_PATH && !fs.existsSync(NAS_ROOT_PATH)) {
            return res.json({
                text: "⚠️ System Alert: Storage not accessible.",
                type: 'quote',
                author: "System Alert",
                date: new Date().toISOString(),
                imagePathEncoded: ERROR_IMAGE_MARKER
            });
        }

        if (photoLibrary.length === 0) {
            return res.status(503).json({ error: "Library empty or indexing..." });
        }

        // 1. SELECT PHOTO
        let selectedPhoto = selectSmartPhoto();
        if (!selectedPhoto) {
             selectedPhoto = photoLibrary[Math.floor(Math.random() * photoLibrary.length)];
        }

        if (!fs.existsSync(selectedPhoto.path)) {
            photoLibrary = photoLibrary.filter(p => p.path !== selectedPhoto!.path);
            photoPaths.delete(selectedPhoto.path);
            return res.status(500).json({ error: "File missing" });
        }

        const isFavorite = selectedPhoto.path.includes(DEFAULTS_FOLDER_NAME);
        let aiResponse: TextEntry | null = null;
        let duplicateDetected = false;
        let textToExclude = "";

        // 2. CHECK CACHE & DETECT DUPLICATES
        if (textLibrary[selectedPhoto.path]) {
            aiResponse = textLibrary[selectedPhoto.path];
            
            // Iterate text library to find if this content is used elsewhere
            for (const [otherPath, entry] of Object.entries(textLibrary)) {
                if (otherPath !== selectedPhoto.path && entry.content === aiResponse.content) {
                    duplicateDetected = true;
                    textToExclude = aiResponse.content;
                    console.log(`♻️  Duplicate content detected for ${path.basename(selectedPhoto.path)}. Refreshing...`);
                    break;
                }
            }
        }

        // 3. GENERATE (If missing OR Duplicate detected)
        if (!aiResponse || duplicateDetected) {
            const roll = Math.random();
            const preferredType = roll < 0.3 ? "poem" : "quote"; // 70% Quote bias
            
            let exclusionInstruction = "";
            if (duplicateDetected && textToExclude) {
                exclusionInstruction = `IMPORTANT: The following text was already used. Do NOT use it again: "${textToExclude}". Find something different.`;
            }

            const prompt = `
                You are a poetic assistant for a digital photo frame. Look at this image.
                
                Goal: Generate text that matches the mood, location, or emotion of the photo.
                
                Preference: I am leaning towards a **${preferredType.toUpperCase()}** for this specific image. 
                However, please override this preference if the image content clearly suits the other format much better.
                
                ${exclusionInstruction}

                Definitions:
                - Quote: A profound, existing famous quote.
                - Poem: A short, beautiful poem (max 4 lines).
                
                Language: Randomly choose between Portuguese (European - PT-PT) or English.
                
                Output Format: JSON only.
                Structure: { "content": "The text", "type": "quote" OR "poem", "author": "Author Name (if quote) or null (if poem)" }
            `;

            try {
                const imagePart = fileToGenerativePart(selectedPhoto.path, "image/jpeg");
                const text = await generateWithRetry(prompt, imagePart);
                
                const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
                aiResponse = JSON.parse(cleanText);
                
                // Save to cache
                textLibrary[selectedPhoto.path] = aiResponse!;
                saveTextsToDisk(); 
            } catch (aiError) {
                console.error("Gemini Final Error:", aiError);
                // If this was a refresh that failed, stick with the old one if available
                if (!aiResponse) {
                    aiResponse = { content: "Memories are timeless treasures.", type: "poem", author: null };
                }
            }
        }

        res.json({
            text: aiResponse!.content,
            type: aiResponse!.type,
            author: aiResponse!.author,
            date: selectedPhoto.created,
            imagePathEncoded: encodeURIComponent(selectedPhoto.path),
            isFavorite: isFavorite 
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

// --- MANAGEMENT ENDPOINTS ---

app.post('/api/favorite', (req, res) => {
    try {
        const { currentPath } = req.body;
        if (!currentPath || !fs.existsSync(currentPath)) return res.status(404).json({error: "File not found"});
        if (!NAS_ROOT_PATH) return res.status(500).json({error: "NAS Root not configured"});

        // Determine Action: Toggle Favorite
        const isCurrentlyFavorite = currentPath.includes(DEFAULTS_FOLDER_NAME);
        const targetFolderName = isCurrentlyFavorite ? UNFAVORITED_FOLDER_NAME : DEFAULTS_FOLDER_NAME;

        const targetDir = path.join(NAS_ROOT_PATH, targetFolderName);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, {recursive: true});

        let fileName = path.basename(currentPath);
        let newPath = path.join(targetDir, fileName);

        if (currentPath === newPath) return res.json({message: "No change needed", isFavorite: isCurrentlyFavorite});
        
        // Handle name collisions
        if (fs.existsSync(newPath)) {
             const timestamp = Date.now();
             const ext = path.extname(fileName);
             const name = path.basename(fileName, ext);
             newPath = path.join(targetDir, `${name}_${timestamp}${ext}`);
        }

        // Move file
        fs.renameSync(currentPath, newPath);

        // Update In-Memory Data
        const photoEntry = photoLibrary.find(p => p.path === currentPath);
        if (photoEntry) photoEntry.path = newPath;
        
        photoPaths.delete(currentPath);
        photoPaths.add(newPath);

        // Update Text Cache Key
        if (textLibrary[currentPath]) {
            textLibrary[newPath] = textLibrary[currentPath];
            delete textLibrary[currentPath];
            saveTextsToDisk();
        }

        isDirtyPhotos = true;
        savePhotosToDisk();

        const isNowFavorite = !isCurrentlyFavorite;
        res.json({ success: true, newPath, isFavorite: isNowFavorite });

    } catch(e: any) {
        console.error("Favorite Error:", e);
        res.status(500).json({error: e.message});
    }
});

// OMIT PHOTO
app.post('/api/omit', (req, res) => {
    try {
        const { currentPath } = req.body;
        if (!currentPath || !fs.existsSync(currentPath)) return res.status(404).json({error: "File not found"});
        if (!NAS_ROOT_PATH) return res.status(500).json({error: "NAS Root not configured"});

        const omittedDir = path.join(NAS_ROOT_PATH, OMITTED_FOLDER_NAME);
        if (!fs.existsSync(omittedDir)) fs.mkdirSync(omittedDir, {recursive: true});

        let fileName = path.basename(currentPath);
        let newPath = path.join(omittedDir, fileName);

        if (currentPath === newPath) return res.json({message: "Already omitted"});
        
        if (fs.existsSync(newPath)) {
             const timestamp = Date.now();
             const ext = path.extname(fileName);
             const name = path.basename(fileName, ext);
             newPath = path.join(omittedDir, `${name}_${timestamp}${ext}`);
        }

        fs.renameSync(currentPath, newPath);

        photoLibrary = photoLibrary.filter(p => p.path !== currentPath);
        photoPaths.delete(currentPath);

        if (textLibrary[currentPath]) {
            delete textLibrary[currentPath];
            saveTextsToDisk();
        }

        isDirtyPhotos = true;
        savePhotosToDisk();

        res.json({ success: true, newPath });
    } catch(e: any) {
        console.error("Omit Error:", e);
        res.status(500).json({error: e.message});
    }
});

app.delete('/api/photo', (req, res) => {
    try {
        const { currentPath } = req.body;
        if (!currentPath || !fs.existsSync(currentPath)) return res.status(404).json({error: "File not found"});

        fs.unlinkSync(currentPath);

        photoLibrary = photoLibrary.filter(p => p.path !== currentPath);
        photoPaths.delete(currentPath);
        
        if (textLibrary[currentPath]) {
            delete textLibrary[currentPath];
            saveTextsToDisk();
        }

        isDirtyPhotos = true;
        savePhotosToDisk();

        res.json({ success: true });
    } catch(e: any) {
        console.error("Delete Error:", e);
        res.status(500).json({error: e.message});
    }
});

app.post('/api/exit', (req, res) => {
    res.json({ message: 'Shutting down...' });
    exec('killall chromium-browser', () => {}); 
    exec('killall chromium', () => {});
    setTimeout(() => process.exit(0), 1000);
});

app.post('/api/reindex', (req, res) => {
    res.json({ message: 'Reindexing started...' });
    performIndexing(true);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    loadLibraries();
    if (photoLibrary.length === 0) performIndexing(true);
});