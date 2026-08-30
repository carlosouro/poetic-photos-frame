import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { promises as fsPromises } from 'fs'; // Async File System API
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { exec, fork } from 'child_process';

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
const ERROR_IMAGE_MARKER = 'SYSTEM_ERROR_IMAGE';

// --- CACHE SETUP ---
const CACHE_DIR = './cache';
const PHOTOS_JSON_PATH = path.join(CACHE_DIR, 'photos.json');
const TEXTS_JSON_PATH = path.join(CACHE_DIR, 'texts.json');

// Boot-time sync directory creation is fine
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
let isGeneratingAI = false;
let isSavingPhotos = false;
let isSavingTexts = false;

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

const savePhotosToDisk = async () => {
    if (!isDirtyPhotos || isSavingPhotos) return;
    isSavingPhotos = true;
    try {
        await fsPromises.writeFile(PHOTOS_JSON_PATH, JSON.stringify(photoLibrary, null, 2));
        console.log(`💾 Persisted ${photoLibrary.length} photos to cache.`);
        isDirtyPhotos = false;
    } catch (e) { console.error("Error saving photos:", e); }
    finally { isSavingPhotos = false; }
};

const saveTextsToDisk = async () => {
    if (isSavingTexts) return;
    isSavingTexts = true;
    try {
        await fsPromises.writeFile(TEXTS_JSON_PATH, JSON.stringify(textLibrary, null, 2));
    } catch (e) { console.error("Error saving texts:", e); }
    finally { isSavingTexts = false; }
};

// --- SMART PHOTO SELECTION ---

function selectSmartPhoto(): Photo | null {
    if (photoLibrary.length === 0) return null;

    const now = new Date();
    const msPerDay = 1000 * 60 * 60 * 24;

    const favorites = photoLibrary.filter(p => p.path.includes(DEFAULTS_FOLDER_NAME));

    const smartCandidates = photoLibrary.filter(photo => {
        const pDate = new Date(photo.created);
        if (isNaN(pDate.getTime())) return false;

        const diffTime = now.getTime() - pDate.getTime();
        const diffDays = diffTime / msPerDay;
        if (diffDays >= 0 && diffDays <= 30) return true;

        const pDateCurrentYear = new Date(pDate);
        pDateCurrentYear.setFullYear(now.getFullYear());
        
        const timeDiff = Math.abs(now.getTime() - pDateCurrentYear.getTime());
        const dayDiff = Math.ceil(timeDiff / msPerDay);

        return dayDiff <= 10;
    });

    const roll = Math.random(); 

    if (roll < 0.8) {
        if (smartCandidates.length > 0) {
            return smartCandidates[Math.floor(Math.random() * smartCandidates.length)];
        }
        if (favorites.length > 0) {
            return favorites[Math.floor(Math.random() * favorites.length)];
        }
    } 
    
    if (roll < 0.9) {
        if (favorites.length > 0) {
            return favorites[Math.floor(Math.random() * favorites.length)];
        }
    }

    return photoLibrary[Math.floor(Math.random() * photoLibrary.length)];
}

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
    if (NAS_ROOT_PATH && !(await checkNasConnection())) {
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
setInterval(() => savePhotosToDisk(), 30 * 1000);
setInterval(() => {
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() === 0) {
        performIndexing(false); 
        trimLogFile(10000);
    }
}, 60 * 1000);

// --- API LOGIC ---

async function fileToGenerativePart(filePath: string, mimeType = "image/jpeg") {
    try {
        // Downscale image to max 1024x1024 to drop base64 payload from 15MB+ to ~150KB
        const resizedBuffer = await sharp(filePath)
            .rotate() // preserve EXIF orientation
            .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

        return {
            data: resizedBuffer.toString("base64"),
            mimeType: "image/jpeg"
        };
    } catch (sharpError) {
        console.warn(`⚠️ Sharp resizing failed for ${path.basename(filePath)}, using raw file fallback:`, sharpError);
        const data = await fsPromises.readFile(filePath);
        return {
            data: data.toString("base64"),
            mimeType
        };
    }
}

async function generateWithRetry(prompt: string, imagePart: { data: string; mimeType: string }, retries = 3, delay = 1000): Promise<TextEntry> {
    try {
        // Enforce a strict 20-second timeout on Gemini API calls so network drops don't hang the app forever
        const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error("Gemini API Timeout")), 20000)
        );

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
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'OBJECT',
                    properties: {
                        content: { type: 'STRING', description: 'A short 2-4 line poem or profound quote matching the photo' },
                        type: { type: 'STRING', enum: ['quote', 'poem'], description: 'Whether the text is a quote or a poem' },
                        author: { type: 'STRING', nullable: true, description: 'Author name if quote, null if poem' }
                    },
                    required: ['content', 'type']
                }
            } as any
        });

        const result = await Promise.race([apiCall, timeoutPromise]) as any;
        const text = typeof result.text === 'function'
            ? result.text()
            : (typeof result.text === 'string' ? result.text : (result.candidates?.[0]?.content?.parts?.[0]?.text || ''));
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanText) as TextEntry;
        return parsed;
    } catch (error: any) {
        if (error.message?.includes('404')) throw error;

        // Catch timeouts and fetch failures to trigger retries cleanly
        if (retries > 0 && (error.message?.includes('503') || error.message?.includes('overloaded') || error.message?.includes('Timeout') || error.message?.includes('fetch failed'))) {
            console.log(`⚠️ Gemini API failed (${error.message}). Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            return generateWithRetry(prompt, imagePart, retries - 1, delay * 2);
        }
        throw error;
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
                    imagePathEncoded: ERROR_IMAGE_MARKER,
                    isFavorite: false
                });
            }
        }

        if (photoLibrary.length === 0) {
            return res.status(503).json({ error: "Library empty or indexing..." });
        }

        // 1. SELECT PHOTO
        let selectedPhoto = selectSmartPhoto();
        if (!selectedPhoto) {
             selectedPhoto = photoLibrary[Math.floor(Math.random() * photoLibrary.length)];
        }

        // ASYNC: Check if chosen photo still exists
        const photoExists = await fileExists(selectedPhoto.path);
        if (!photoExists) {
            // CRITICAL FIX: Only purge the memory if we KNOW the NAS is online (meaning it was actually deleted).
            if (!isNasOffline) {
                photoLibrary = photoLibrary.filter(p => p.path !== selectedPhoto!.path);
                photoPaths.delete(selectedPhoto!.path);
                isDirtyPhotos = true;
            }
            return res.status(500).json({ error: "File missing or NAS unreachable" });
        }

        let isFavorite = selectedPhoto.path.includes(DEFAULTS_FOLDER_NAME);
        let aiResponse: TextEntry | null = null;
        let duplicateDetected = false;
        let textToExclude = "";

        // 2. CHECK CACHE & DETECT DUPLICATES
        if (textLibrary[selectedPhoto.path]) {
            aiResponse = textLibrary[selectedPhoto.path];
            
            for (const [otherPath, entry] of Object.entries(textLibrary)) {
                if (otherPath !== selectedPhoto.path && entry.content === aiResponse.content) {
                    duplicateDetected = true;
                    textToExclude = aiResponse.content;
                    console.log(`♻️  Duplicate content detected for ${path.basename(selectedPhoto.path)}. Refreshing...`);
                    break;
                }
            }
        }

        // 3. GENERATE OR FALLBACK
        if (!aiResponse || duplicateDetected) {
            
            if (isGeneratingAI) {
                console.log("⚠️ Backend is busy. Forcing a cached fallback memory.");
                const cachedPaths = Object.keys(textLibrary);
                const availableCachedPhotos = photoLibrary.filter(p => cachedPaths.includes(p.path));
                
                if (availableCachedPhotos.length > 0) {
                    selectedPhoto = availableCachedPhotos[Math.floor(Math.random() * availableCachedPhotos.length)];
                    aiResponse = textLibrary[selectedPhoto.path];
                    isFavorite = selectedPhoto.path.includes(DEFAULTS_FOLDER_NAME);
                } else {
                    aiResponse = { content: "Memories are timeless treasures.", type: "poem", author: null };
                }
            } else {
                isGeneratingAI = true; 
                
                const roll = Math.random();
                const preferredType = roll < 0.3 ? "poem" : "quote";
                
                let exclusionInstruction = "";
                if (duplicateDetected && textToExclude) {
                    exclusionInstruction = `IMPORTANT: The following text was already used. Do NOT use it again: "${textToExclude}". Find something different.`;
                }

                const photoDate = new Date(selectedPhoto.created);
                const now = new Date();
                const yearsAgo = now.getFullYear() - photoDate.getFullYear();
                let temporalContext = "";
                if (yearsAgo > 0 && Math.abs(now.getMonth() - photoDate.getMonth()) <= 1) {
                    temporalContext = `Context: This memory is an anniversary memory from ${yearsAgo} ${yearsAgo === 1 ? 'year' : 'years'} ago (${photoDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}).`;
                }

                const prompt = `
                    You are a poetic assistant for a digital photo frame. Look at this image.
                    
                    Goal: Generate text that matches the mood, location, and emotional resonance of the photo.
                    ${temporalContext ? `${temporalContext}\n` : ''}
                    Preference: I am leaning towards a **${preferredType.toUpperCase()}** for this specific image. 
                    However, please override this preference if the image content clearly suits the other format much better.
                    
                    ${exclusionInstruction}

                    Definitions:
                    - Quote: A profound, existing famous quote.
                    - Poem: A short, beautiful poem (max 4 lines).
                    
                    Language: Randomly choose between Portuguese (European - PT-PT) or English.
                `;

                try {
                    const imagePart = await fileToGenerativePart(selectedPhoto.path, "image/jpeg");
                    aiResponse = await generateWithRetry(prompt, imagePart);
                    
                    textLibrary[selectedPhoto.path] = aiResponse;
                    saveTextsToDisk(); 
                } catch (aiError) {
                    console.error("Gemini Final Error:", aiError);
                    if (!aiResponse) {
                        aiResponse = { content: "Memories are timeless treasures.", type: "poem", author: null };
                    }
                } finally {
                    isGeneratingAI = false; 
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

app.get('/api/image', async (req, res) => {
    const filePath = decodeURIComponent(req.query.path as string);
    if (filePath === ERROR_IMAGE_MARKER) {
        const img = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==", 'base64');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': img.length });
        return res.end(img);
    }
    
    const exists = await fileExists(filePath);
    if (!exists) return res.status(404).send('Image not found');
    res.sendFile(filePath);
});

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

        const photoEntry = photoLibrary.find(p => p.path === currentPath);
        if (photoEntry) photoEntry.path = newPath;
        
        photoPaths.delete(currentPath);
        photoPaths.add(newPath);

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

app.delete('/api/photo', async (req, res) => {
    try {
        const { currentPath } = req.body;
        if (!currentPath || !(await fileExists(currentPath))) return res.status(404).json({error: "File not found"});

        await fsPromises.unlink(currentPath);

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