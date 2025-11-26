import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { exec, spawn } from 'child_process';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const model = genAI.getGenerativeModel({ model: modelName });

interface Photo {
    path: string;
    created: string;
}

let photoLibrary: Photo[] = [];
const PHOTOS_JSON_PATH = process.env.PHOTOS_JSON_PATH || './photos.json';

// --- HELPER FUNCTIONS ---

const loadPhotoLibrary = () => {
    try {
        if (fs.existsSync(PHOTOS_JSON_PATH)) {
            const data = fs.readFileSync(PHOTOS_JSON_PATH, 'utf-8');
            photoLibrary = JSON.parse(data);
            console.log(`📚 Memory updated. Loaded ${photoLibrary.length} photos.`);
        } else {
            console.warn(`Warning: ${PHOTOS_JSON_PATH} not found.`);
        }
    } catch (error) {
        console.error("Error loading library:", error);
    }
};

const runIndexer = (mode: 'defaults' | 'full'): Promise<void> => {
    return new Promise((resolve, reject) => {
        const indexerProcess = spawn('npx', ['ts-node', 'src/indexer.ts', `--mode=${mode}`], {
            stdio: 'inherit',
            shell: true
        });

        indexerProcess.on('close', (code) => {
            if (code === 0) {
                loadPhotoLibrary();
                resolve();
            } else {
                reject();
            }
        });
    });
};

const initializeServer = async () => {
    if (!fs.existsSync(PHOTOS_JSON_PATH)) {
        console.log("⚠️ Starting First-Run Sequence.");
        try { await runIndexer('defaults'); } catch (e) { console.error("Defaults load failed"); }
        runIndexer('full').catch(err => console.error("Background index failed"));
    } else {
        loadPhotoLibrary();
    }
};

function fileToGenerativePart(filePath: string, mimeType: string) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
            mimeType
        },
    };
}

// --- API ENDPOINTS ---

app.get('/api/next-memory', async (req, res) => {
    try {
        if (photoLibrary.length === 0) {
            loadPhotoLibrary();
            if (photoLibrary.length === 0) return res.status(503).json({ error: "Indexing..." });
        }

        const randomIndex = Math.floor(Math.random() * photoLibrary.length);
        const selectedPhoto = photoLibrary[randomIndex];

        if (!fs.existsSync(selectedPhoto.path)) {
            photoLibrary.splice(randomIndex, 1);
            return res.status(500).json({ error: "File not found" });
        }

        // UPDATED PROMPT: Request JSON format
        const prompt = `
            You are a poetic assistant for a family photo frame. Look at this image.
            Task: Generate EITHER a short, beautiful poem (max 4 lines) OR select a profound famous quote that matches the mood.
            Language: Randomly choose between Portuguese (European - PT-PT) or English.
            Output Format: JSON only. DO NOT include markdown code blocks.
            Structure: { "content": "The poem or quote text", "type": "poem" OR "quote", "author": "Author Name or null" }
        `;

        let aiResponse = { content: "...", type: "poem", author: null };
        
        try {
            const imagePart = fileToGenerativePart(selectedPhoto.path, "image/jpeg");
            const result = await model.generateContent([prompt, imagePart]);
            const response = await result.response;
            const text = response.text();
            
            // Clean up code blocks if Gemini adds them
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            aiResponse = JSON.parse(cleanText);
            
        } catch (aiError) {
            console.error("Gemini/JSON Error:", aiError);
            aiResponse = { content: "Memories are timeless treasures.", type: "poem", author: null };
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
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Image not found');
    res.sendFile(filePath);
});

app.post('/api/exit', (req, res) => {
    res.json({ message: 'Shutting down...' });
    exec('killall chromium-browser', () => setTimeout(() => process.exit(0), 1000));
});

app.post('/api/reindex', (req, res) => {
    res.json({ message: 'Reindexing started...' });
    runIndexer('full');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    initializeServer();
});