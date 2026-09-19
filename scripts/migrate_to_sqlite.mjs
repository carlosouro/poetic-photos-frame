#!/usr/bin/env node

/**
 * Migration Utility: Migrate photos.json & texts.json to SQLite memories.db
 * 
 * Usage:
 *   node scripts/migrate_to_sqlite.mjs [cacheDir]
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const CACHE_DIR = process.argv[2] || path.join(process.cwd(), 'cache');
const PHOTOS_JSON = path.join(CACHE_DIR, 'photos.json');
const TEXTS_JSON = path.join(CACHE_DIR, 'texts.json');
const DB_PATH = path.join(CACHE_DIR, 'memories.db');

console.log('==================================================');
console.log('   Poetic Memories -> SQLite Migration Utility    ');
console.log('==================================================');
console.log(`Cache directory: ${CACHE_DIR}`);

if (!fs.existsSync(CACHE_DIR)) {
    console.error(`❌ Cache directory does not exist: ${CACHE_DIR}`);
    process.exit(1);
}

// 1. Back up existing DB if it already exists
if (fs.existsSync(DB_PATH)) {
    const backupDb = `${DB_PATH}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    console.log(`⚠️ Existing memories.db found. Creating backup: ${path.basename(backupDb)}`);
    fs.copyFileSync(DB_PATH, backupDb);
    // Remove old DB so we have a clean migration
    fs.unlinkSync(DB_PATH);
    if (fs.existsSync(`${DB_PATH}-wal`)) fs.unlinkSync(`${DB_PATH}-wal`);
    if (fs.existsSync(`${DB_PATH}-shm`)) fs.unlinkSync(`${DB_PATH}-shm`);
}

// 2. Initialize Database & Schema
console.log(`🔨 Creating SQLite database: ${DB_PATH}`);
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -64000'); // 64MB cache

db.exec(`
    CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        created TEXT NOT NULL,
        media_type TEXT DEFAULT 'image',
        hash TEXT,
        month INTEGER NOT NULL,
        day INTEGER NOT NULL,
        is_favorite INTEGER DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_path ON photos(path);
    CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(hash);
    CREATE INDEX IF NOT EXISTS idx_photos_anniversary ON photos(month, day);
    CREATE INDEX IF NOT EXISTS idx_photos_created ON photos(created);
    CREATE INDEX IF NOT EXISTS idx_photos_favorite ON photos(is_favorite);

    CREATE TABLE IF NOT EXISTS quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        photo_path TEXT UNIQUE NOT NULL REFERENCES photos(path) ON DELETE CASCADE,
        content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'quote',
        author TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_path ON quotes(photo_path);
    CREATE INDEX IF NOT EXISTS idx_quotes_content ON quotes(content);
`);

const insertPhotoStmt = db.prepare(`
    INSERT OR IGNORE INTO photos (path, created, media_type, hash, month, day, is_favorite)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertQuoteStmt = db.prepare(`
    INSERT OR REPLACE INTO quotes (photo_path, content, type, author)
    VALUES (?, ?, ?, ?)
`);

const startTime = Date.now();

// Helper to extract date parts
function parseDateParts(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return { month: 1, day: 1 };
    return { month: d.getMonth() + 1, day: d.getDate() };
}

function checkIsFavorite(filePath) {
    return (filePath.includes('/_photoframe_defaults/') || filePath.includes('\\_photoframe_defaults\\')) ? 1 : 0;
}

// 3. Migrate Photos
let photoCount = 0;
if (fs.existsSync(PHOTOS_JSON)) {
    console.log(`📖 Reading ${PHOTOS_JSON}...`);
    const rawPhotos = JSON.parse(fs.readFileSync(PHOTOS_JSON, 'utf-8'));
    console.log(`Found ${rawPhotos.length} photos to migrate.`);

    const insertManyPhotos = db.transaction((batch) => {
        for (const p of batch) {
            const { month, day } = parseDateParts(p.created);
            const isFav = checkIsFavorite(p.path);
            const mediaType = p.mediaType || 'image';
            insertPhotoStmt.run(p.path, p.created, mediaType, p.hash || null, month, day, isFav);
        }
    });

    const CHUNK_SIZE = 5000;
    for (let i = 0; i < rawPhotos.length; i += CHUNK_SIZE) {
        const chunk = rawPhotos.slice(i, i + CHUNK_SIZE);
        insertManyPhotos(chunk);
        photoCount += chunk.length;
        process.stdout.write(`\r📸 Migrated photos: ${photoCount} / ${rawPhotos.length}...`);
    }
    console.log(`\n✅ Photos migration completed: ${photoCount} records.`);
} else {
    console.warn(`⚠️ ${PHOTOS_JSON} not found. Skipping photos.`);
}

// 4. Migrate Quotes
let quoteCount = 0;
let purgedCount = 0;
if (fs.existsSync(TEXTS_JSON)) {
    console.log(`📖 Reading ${TEXTS_JSON}...`);
    const rawTexts = JSON.parse(fs.readFileSync(TEXTS_JSON, 'utf-8'));
    const entries = Object.entries(rawTexts);
    console.log(`Found ${entries.length} text entries to evaluate.`);

    const checkPhotoExistsStmt = db.prepare(`SELECT 1 FROM photos WHERE path = ? LIMIT 1`);

    const insertManyQuotes = db.transaction((batch) => {
        for (const [photoPath, item] of batch) {
            if (item && item.type === 'quote' && item.author && item.author.trim() && item.content && item.content.trim()) {
                if (checkPhotoExistsStmt.get(photoPath)) {
                    insertQuoteStmt.run(photoPath, item.content.trim(), 'quote', item.author.trim());
                    quoteCount++;
                } else {
                    purgedCount++;
                }
            } else {
                purgedCount++;
            }
        }
    });

    const CHUNK_SIZE = 5000;
    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const chunk = entries.slice(i, i + CHUNK_SIZE);
        insertManyQuotes(chunk);
    }
    console.log(`✅ Quotes migration completed: ${quoteCount} valid quotes kept (${purgedCount} non-quotes/poems skipped).`);
} else {
    console.warn(`⚠️ ${TEXTS_JSON} not found. Skipping texts.`);
}

// 5. Integrity Check
console.log('🔍 Running PRAGMA integrity_check...');
const check = db.pragma('integrity_check');
console.log('Integrity check result:', check);

// 6. Final Stats
const totalPhotos = db.prepare('SELECT COUNT(*) as count FROM photos').get().count;
const totalQuotes = db.prepare('SELECT COUNT(*) as count FROM quotes').get().count;
const totalHashes = db.prepare('SELECT COUNT(*) as count FROM photos WHERE hash IS NOT NULL').get().count;
const totalFavorites = db.prepare('SELECT COUNT(*) as count FROM photos WHERE is_favorite = 1').get().count;

const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
const dbSizeMb = (fs.statSync(DB_PATH).size / (1024 * 1024)).toFixed(2);

console.log('--------------------------------------------------');
console.log(`🎉 Migration successfully finished in ${elapsedSec}s!`);
console.log(`📊 Final SQLite Stats:`);
console.log(`   - Database size:    ${dbSizeMb} MB`);
console.log(`   - Total photos:     ${totalPhotos}`);
console.log(`   - Total quotes:     ${totalQuotes}`);
console.log(`   - Indexed hashes:   ${totalHashes}`);
console.log(`   - Curated favorites: ${totalFavorites}`);
console.log('--------------------------------------------------');

db.close();
