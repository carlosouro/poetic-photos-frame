import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';

import {
    initDatabase,
    closeDatabase,
    getDbStats,
    getPhotoByPath,
    getQuote,
    setQuote,
    renamePhoto,
    setPhotoRotation,
    insertPhotosBatch,
    upsertScannedBatch,
    pruneUnseenPhotos,
    selectSmartPhoto
} from '../dist/db.js';
import { assertInsideNas, PathSecurityError } from '../dist/nas.js';
import { quarantineDuplicate, determineSurvivor } from '../dist/dedup.js';
import { renderDisplayImageBuffer } from '../dist/media.js';
import { WeatherService } from '../dist/weather.js';

function makeTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `poetic-test-${prefix}-`));
}

test('SQLite v0 live-Pi schema migrates safely with backup and preserves 100% of data', () => {
    const tmpDir = makeTmpDir('db-migration');
    const dbPath = path.join(tmpDir, 'memories.db');

    // Seed an exact replica of the Pi v0 database created by scripts/migrate_to_sqlite.mjs
    // (Notice: NO ON UPDATE CASCADE on quotes, NO original_path/rotation/last_seen_scan, user_version=0)
    const legacyDb = new Database(dbPath);
    legacyDb.pragma('journal_mode = WAL');
    legacyDb.pragma('foreign_keys = ON');
    legacyDb.exec(`
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
        CREATE UNIQUE INDEX idx_photos_path ON photos(path);
        CREATE TABLE quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            photo_path TEXT UNIQUE NOT NULL REFERENCES photos(path) ON DELETE CASCADE,
            content TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'quote',
            author TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX idx_quotes_path ON quotes(photo_path);
    `);

    legacyDb.prepare(
        `INSERT INTO photos (path, created, media_type, hash, month, day, is_favorite) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('/nas/2020/beach.jpg', '2020-07-15T12:00:00.000Z', 'image', 'abc123hash', 7, 15, 0);

    legacyDb.prepare(
        `INSERT INTO quotes (photo_path, content, type, author) VALUES (?, ?, ?, ?)`
    ).run('/nas/2020/beach.jpg', 'The sea remembers.', 'quote', 'Sophia de Mello Breyner');
    legacyDb.close();

    try {
        const migrated = initDatabase(dbPath);

        // 1. Pre-migration backup was created
        const files = fs.readdirSync(tmpDir);
        assert.ok(files.some(f => f.startsWith('memories.db.bak.')), 'Expected pre-migration backup file');

        // 2. Schema version bumped & redundant indexes dropped
        assert.equal(migrated.pragma('user_version', { simple: true }), 1);
        const indexes = migrated.pragma('index_list(photos)').map(i => i.name);
        assert.ok(!indexes.includes('idx_photos_path'), 'Redundant idx_photos_path should be dropped');

        // 3. Existing photo, hash, and quote 100% preserved
        const photo = getPhotoByPath('/nas/2020/beach.jpg');
        assert.ok(photo);
        assert.equal(photo.hash, 'abc123hash');
        assert.equal(photo.rotation, 0);
        assert.equal(photo.originalPath, null);

        const quote = getQuote('/nas/2020/beach.jpg');
        assert.equal(quote?.content, 'The sea remembers.');
        assert.equal(quote?.author, 'Sophia de Mello Breyner');

        // 4. Rotation persistence works
        setPhotoRotation('/nas/2020/beach.jpg', 90);
        assert.equal(getPhotoByPath('/nas/2020/beach.jpg')?.rotation, 90);

        // 5. Favoriting via renamePhoto works EVEN on legacy FK without ON UPDATE CASCADE
        renamePhoto('/nas/2020/beach.jpg', '/nas/_photoframe_defaults/beach.jpg', '/nas/2020/beach.jpg');
        const favPhoto = getPhotoByPath('/nas/_photoframe_defaults/beach.jpg');
        assert.ok(favPhoto);
        assert.equal(favPhoto.isFavorite, true);
        assert.equal(favPhoto.originalPath, '/nas/2020/beach.jpg');
        assert.equal(favPhoto.rotation, 90);
        assert.equal(getQuote('/nas/_photoframe_defaults/beach.jpg')?.content, 'The sea remembers.');
    } finally {
        closeDatabase();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Anniversary selector includes 1-year-ago +1..+10 day memories', () => {
    const tmpDir = makeTmpDir('anniversary');
    const dbPath = path.join(tmpDir, 'memories.db');

    try {
        initDatabase(dbPath);
        insertPhotosBatch([
            // Exactly 1 year ago + 4 days from Nov 21, 2026 -> Nov 25, 2025
            { path: '/nas/2025/nov25.jpg', created: '2025-11-25T15:00:00.000Z', mediaType: 'image' },
            // Unrelated month photo
            { path: '/nas/2022/may10.jpg', created: '2022-05-10T10:00:00.000Z', mediaType: 'image' }
        ]);

        const refDate = new Date('2026-11-21T12:00:00.000Z');
        let nov25Hits = 0;
        for (let i = 0; i < 60; i++) {
            const picked = selectSmartPhoto([], refDate);
            if (picked?.path === '/nas/2025/nov25.jpg') nov25Hits++;
        }
        // Smart selector gives 80%+ chance to anniversary candidate
        assert.ok(nov25Hits >= 35, `Expected strong anniversary bias for Nov 25, 2025, got ${nov25Hits}/60`);
    } finally {
        closeDatabase();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('quarantineDuplicate migrates quote to survivor BEFORE deleting duplicate photo row', async () => {
    const tmpDir = makeTmpDir('dedup');
    const nasRoot = path.join(tmpDir, 'nas');
    const dbPath = path.join(tmpDir, 'memories.db');

    const survivorDir = path.join(nasRoot, '2023-Summer');
    const dupDir = path.join(nasRoot, 'MobileBackup');
    fs.mkdirSync(survivorDir, { recursive: true });
    fs.mkdirSync(dupDir, { recursive: true });

    const survivorPath = path.join(survivorDir, 'sunset.jpg');
    const dupPath = path.join(dupDir, 'sunset (1).jpg');
    fs.writeFileSync(survivorPath, Buffer.from('same-bytes'));
    fs.writeFileSync(dupPath, Buffer.from('same-bytes'));

    try {
        initDatabase(dbPath);
        insertPhotosBatch([
            { path: survivorPath, created: '2023-08-01T18:00:00.000Z', mediaType: 'image', hash: 'h1' },
            { path: dupPath, created: '2023-08-02T18:00:00.000Z', mediaType: 'image', hash: 'h1' }
        ]);

        // Put quote ONLY on duplicate to verify migration preserves it
        setQuote(dupPath, { content: 'Golden hour light.', type: 'quote', author: 'Fernando Pessoa' });

        const { survivor, duplicate } = determineSurvivor(dupPath, survivorPath);
        assert.equal(survivor, survivorPath);
        assert.equal(duplicate, dupPath);

        const ok = await quarantineDuplicate(dupPath, survivorPath, nasRoot);
        assert.equal(ok, true);

        // Duplicate moved to _photoframe_duplicates/MobileBackup/sunset (1).jpg
        assert.equal(fs.existsSync(dupPath), false);
        assert.equal(fs.existsSync(path.join(nasRoot, '_photoframe_duplicates', 'MobileBackup', 'sunset (1).jpg')), true);

        // Duplicate row deleted from DB, survivor keeps migrated quote!
        assert.equal(getPhotoByPath(dupPath), undefined);
        const migratedQuote = getQuote(survivorPath);
        assert.equal(migratedQuote?.content, 'Golden hour light.');
        assert.equal(migratedQuote?.author, 'Fernando Pessoa');
    } finally {
        closeDatabase();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Safe pruning removes deleted files on healthy scan but refuses >50% partial-mount drops', () => {
    const tmpDir = makeTmpDir('prune');
    const dbPath = path.join(tmpDir, 'memories.db');

    try {
        initDatabase(dbPath);
        const batch = Array.from({ length: 120 }, (_, i) => ({
            path: `/nas/img_${i}.jpg`,
            created: '2024-01-01T00:00:00.000Z',
            mediaType: 'image'
        }));
        insertPhotosBatch(batch);

        // Simulate partial mount glitch returning only 20 of 120 files -> MUST refuse prune
        upsertScannedBatch(batch.slice(0, 20), 1001);
        const glitchResult = pruneUnseenPhotos(1001, 20);
        assert.equal(glitchResult.pruned, 0);
        assert.ok(glitchResult.skippedReason);
        assert.equal(getDbStats().totalPhotos, 120);

        // Simulate healthy scan where 5 files were genuinely deleted on NAS (115/120 remain)
        upsertScannedBatch(batch.slice(0, 115), 1002);
        const healthyResult = pruneUnseenPhotos(1002, 115);
        assert.equal(healthyResult.pruned, 5);
        assert.equal(getDbStats().totalPhotos, 115);
    } finally {
        closeDatabase();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('assertInsideNas blocks traversal and sibling prefix bypasses', () => {
    const root = '/mnt/nas/photos';
    assert.equal(assertInsideNas('/mnt/nas/photos/2024/a.jpg', root), '/mnt/nas/photos/2024/a.jpg');
    assert.throws(() => assertInsideNas('/mnt/nas/photos/../../etc/passwd', root), PathSecurityError);
    assert.throws(() => assertInsideNas('/mnt/nas/photos-other/a.jpg', root), PathSecurityError);
    assert.throws(() => assertInsideNas('/etc/hosts', root), PathSecurityError);
});

test('renderDisplayImageBuffer creates 1280x800 WebP with blurred backdrop for portrait photos and supports rotation', async () => {
    // Bright orange portrait image (600x900)
    const portraitPng = await sharp({
        create: { width: 600, height: 900, channels: 3, background: { r: 220, g: 120, b: 40 } }
    }).png().toBuffer();

    const webp0 = await renderDisplayImageBuffer(portraitPng, 0, 1280, 800);
    const meta0 = await sharp(webp0).metadata();
    assert.equal(meta0.format, 'webp');
    assert.equal(meta0.width, 1280);
    assert.equal(meta0.height, 800);

    // Left pillar area (x=40, y=400) should be darkened blurred orange, NOT pure black (0,0,0)
    const { data: leftPixel } = await sharp(webp0)
        .extract({ left: 40, top: 400, width: 1, height: 1 })
        .raw()
        .toBuffer({ resolveWithObject: true });
    assert.ok(leftPixel[0] > 20, `Expected warm blurred backdrop on pillar, got R=${leftPixel[0]}`);
    assert.ok(leftPixel[0] < 130, `Expected darkened backdrop (not full brightness), got R=${leftPixel[0]}`);

    // Rotating portrait 90° makes it 900x600 landscape (1.5 aspect -> close to 1.6, still composited/fitted to <=1280x800)
    const webp90 = await renderDisplayImageBuffer(portraitPng, 90, 1280, 800);
    const meta90 = await sharp(webp90).metadata();
    assert.equal(meta90.format, 'webp');
    assert.ok(meta90.width <= 1280 && meta90.height <= 800);
});

test('WeatherService returns null instead of fabricating 0° Sunny when forecast slots are missing', () => {
    const ws = new WeatherService({ timezone: 'Europe/Lisbon' });
    const stalePayload = {
        hourly: {
            time: ['2025-01-01T08:00', '2025-01-01T16:00'],
            temperature_2m: [10, 16],
            weather_code: [1, 2]
        },
        daily: {
            time: ['2025-01-01'],
            temperature_2m_max: [17]
        }
    };

    const result = ws.computeSlots(new Date('2026-11-21T10:00:00Z'), stalePayload);
    assert.equal(result, null, 'Stale/missing forecast dates should return null, never 0° Sunny');

    const validPayload = {
        hourly: {
            time: ['2026-11-21T08:00', '2026-11-21T16:00', '2026-11-22T08:00', '2026-11-22T16:00'],
            temperature_2m: [11.4, 19.2, 9.6, 17.8],
            weather_code: [1, 2, 61, 3]
        },
        daily: {
            time: ['2026-11-21', '2026-11-22'],
            temperature_2m_max: [20.4, 18.1]
        }
    };

    // At 15:00 Lisbon -> Slot A (8am) should be tomorrow (9.6 -> 10, rainy), Slot B (4pm) should be today (daily max 20, partly-cloudy)
    const computed = ws.computeSlots(new Date('2026-11-21T15:00:00Z'), validPayload);
    assert.ok(computed);
    assert.equal(computed.slotA.dayLabel, 'tmrw');
    assert.equal(computed.slotA.temp, 10);
    assert.equal(computed.slotA.symbol, 'rainy');
    assert.equal(computed.slotB.dayLabel, 'today');
    assert.equal(computed.slotB.temp, 20);
    assert.equal(computed.slotB.symbol, 'partly-cloudy');
});
