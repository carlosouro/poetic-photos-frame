import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import Database from 'better-sqlite3';

async function waitForServer(baseUrl, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${baseUrl}/api/config`);
            if (res.ok) return;
        } catch {}
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('Test server failed to boot in time');
}

test('End-to-end HTTP API: Pre-warm queue, 1280x800 WebP serving, rotate, favorite/restore, omit, and path security', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poetic-e2e-'));
    const nasDir = path.join(tmpDir, 'nas');
    const albumDir = path.join(nasDir, '2024-Lisbon');
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(albumDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });

    const photoA = path.join(albumDir, 'portrait.jpg');
    const photoB = path.join(albumDir, 'landscape.jpg');

    await sharp({
        create: { width: 600, height: 900, channels: 3, background: { r: 180, g: 90, b: 60 } }
    }).jpeg().toFile(photoA);

    await sharp({
        create: { width: 1280, height: 800, channels: 3, background: { r: 40, g: 120, b: 180 } }
    }).jpeg().toFile(photoB);

    // Seed DB with cached quotes so Gemini API isn't called during test
    const dbPath = path.join(cacheDir, 'memories.db');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            created TEXT NOT NULL,
            media_type TEXT DEFAULT 'image',
            hash TEXT,
            month INTEGER NOT NULL,
            day INTEGER NOT NULL,
            is_favorite INTEGER DEFAULT 0
        );
        CREATE TABLE quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            photo_path TEXT UNIQUE NOT NULL REFERENCES photos(path) ON DELETE CASCADE,
            content TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'quote',
            author TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
    db.prepare(`INSERT INTO photos (path, created, media_type, month, day, is_favorite) VALUES (?, ?, 'image', 11, 21, 0)`)
        .run(photoA, '2024-11-21T10:00:00.000Z');
    db.prepare(`INSERT INTO photos (path, created, media_type, month, day, is_favorite) VALUES (?, ?, 'image', 11, 21, 0)`)
        .run(photoB, '2024-11-21T11:00:00.000Z');
    db.prepare(`INSERT INTO quotes (photo_path, content, type, author) VALUES (?, ?, 'quote', ?)`)
        .run(photoA, 'Tudo vale a pena se a alma não é pequena.', 'Fernando Pessoa');
    db.prepare(`INSERT INTO quotes (photo_path, content, type, author) VALUES (?, ?, 'quote', ?)`)
        .run(photoB, 'Light reveals what silence holds.', 'Anonymous');
    db.close();

    const port = 3450 + Math.floor(Math.random() * 400);
    const baseUrl = `http://127.0.0.1:${port}`;
    const serverProc = spawn(process.execPath, ['dist/server.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(port),
            NAS_ROOT_PATH: nasDir,
            CACHE_DIR: cacheDir,
            DB_PATH: dbPath,
            VIDEO_CACHE_DIR: path.join(cacheDir, 'transcoded'),
            IMAGE_CACHE_DIR: path.join(cacheDir, 'images'),
            SLIDESHOW_INTERVAL_SECONDS: '20',
            GEMINI_API_KEY: ''
        },
        stdio: 'pipe'
    });

    try {
        await waitForServer(baseUrl);

        // 1. Config endpoint exposes 20s default
        const cfg = await (await fetch(`${baseUrl}/api/config`)).json();
        assert.equal(cfg.slideshowIntervalMs, 20000);
        assert.equal(cfg.screenWidth, 1280);
        assert.equal(cfg.screenHeight, 800);

        // 2. Status endpoint reports library stats & NAS OK
        const status = await (await fetch(`${baseUrl}/api/status`)).json();
        assert.equal(status.totalPhotos, 2);
        assert.equal(status.totalQuotes, 2);
        assert.equal(status.nasOnline, true);

        // 3. Next-memory returns valid payload & serves 1280x800 WebP image
        const mem1 = await (await fetch(`${baseUrl}/api/next-memory`)).json();
        assert.equal(mem1.isVideo, false);
        assert.equal(mem1.type, 'quote');
        assert.ok(mem1.mediaUrl.startsWith('/api/image?path='));

        const imgRes = await fetch(`${baseUrl}${mem1.mediaUrl}`);
        assert.equal(imgRes.status, 200);
        assert.equal(imgRes.headers.get('content-type'), 'image/webp');
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        const imgMeta = await sharp(imgBuf).metadata();
        assert.equal(imgMeta.width, 1280);
        assert.equal(imgMeta.height, 800);

        // 4. Path traversal is blocked with 403
        const traversalRes = await fetch(`${baseUrl}/api/image?path=${encodeURIComponent('/etc/passwd')}`);
        assert.equal(traversalRes.status, 403);

        // 5. Rotate right (+90) persists rotation & returns cache-busted URL
        const targetPath = decodeURIComponent(mem1.imagePathEncoded);
        const rotRes = await (await fetch(`${baseUrl}/api/rotate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath: targetPath, delta: 90 })
        })).json();
        assert.equal(rotRes.success, true);
        assert.equal(rotRes.rotation, 90);
        assert.ok(rotRes.mediaUrl.includes('&r=90'));

        const rotImgRes = await fetch(`${baseUrl}${rotRes.mediaUrl}`);
        assert.equal(rotImgRes.status, 200);

        // 6. Favorite moves photo into _photoframe_defaults, then Unfavorite restores it to 2024-Lisbon!
        const favRes = await (await fetch(`${baseUrl}/api/favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath: targetPath })
        })).json();
        assert.equal(favRes.success, true);
        assert.equal(favRes.isFavorite, true);
        assert.ok(favRes.newPath.includes('_photoframe_defaults'));
        assert.equal(fs.existsSync(favRes.newPath), true);

        const unfavRes = await (await fetch(`${baseUrl}/api/favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath: favRes.newPath })
        })).json();
        assert.equal(unfavRes.success, true);
        assert.equal(unfavRes.isFavorite, false);
        assert.equal(unfavRes.newPath, targetPath, 'Unfavoriting should restore photo back to its original album!');
        assert.equal(fs.existsSync(targetPath), true);

        // 7. Omit moves photo to _photoframe_omitted and removes from DB
        const omitRes = await (await fetch(`${baseUrl}/api/omit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath: targetPath })
        })).json();
        assert.equal(omitRes.success, true);
        assert.ok(omitRes.newPath.includes('_photoframe_omitted'));
        const statusAfterOmit = await (await fetch(`${baseUrl}/api/status`)).json();
        assert.equal(statusAfterOmit.totalPhotos, 1);
    } finally {
        serverProc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 300));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
