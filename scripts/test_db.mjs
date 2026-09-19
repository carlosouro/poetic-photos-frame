import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

const TEST_DB = path.join(process.cwd(), 'cache', 'test_memories.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

console.log('🧪 Starting SQLite DB Layer Test...');

const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

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

const now = new Date();
const todayMonth = now.getMonth() + 1;
const todayDay = now.getDate();

const testPhotos = [
    {
        path: '/photos/recent.jpg',
        created: new Date(now.getTime() - 2 * 86400000).toISOString(),
        mediaType: 'image',
        hash: 'hash_recent'
    },
    {
        path: '/photos/anniversary.jpg',
        created: new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()).toISOString(),
        mediaType: 'image',
        hash: 'hash_anniversary'
    },
    {
        path: '/photos/_photoframe_defaults/favorite.jpg',
        created: '2020-01-01T12:00:00.000Z',
        mediaType: 'image',
        hash: 'hash_favorite'
    },
    {
        path: '/photos/old_random.jpg',
        created: '2015-05-15T12:00:00.000Z',
        mediaType: 'image',
        hash: 'hash_duplicate_1'
    },
    {
        path: '/photos/downloads/old_random_copy.jpg',
        created: '2015-05-15T12:00:00.000Z',
        mediaType: 'image',
        hash: 'hash_duplicate_1' // Same hash!
    }
];

const insertPhotoStmt = db.prepare(`
    INSERT OR IGNORE INTO photos (path, created, media_type, hash, month, day, is_favorite)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function parseDateParts(dateStr) {
    const d = new Date(dateStr);
    return { month: d.getMonth() + 1, day: d.getDate() };
}

function checkIsFavorite(p) {
    return p.includes('_photoframe_defaults') ? 1 : 0;
}

// 1. Batch Insert Test
const insertBatch = db.transaction((items) => {
    for (const p of items) {
        const { month, day } = parseDateParts(p.created);
        const isFav = checkIsFavorite(p.path);
        insertPhotoStmt.run(p.path, p.created, p.mediaType, p.hash, month, day, isFav);
    }
});

insertBatch(testPhotos);

const total = db.prepare('SELECT COUNT(*) as c FROM photos').get().c;
console.log(`✅ Batch insert successful. Total rows: ${total} (expected 5)`);
if (total !== 5) throw new Error('Batch insert count mismatch');

// 2. Hash Collision Test
const dup = db.prepare('SELECT path FROM photos WHERE hash = ? AND path != ?').get('hash_duplicate_1', '/photos/old_random.jpg');
console.log(`✅ Duplicate hash collision detected: ${dup.path}`);
if (dup.path !== '/photos/downloads/old_random_copy.jpg') throw new Error('Duplicate hash lookup failed');

// 3. Quotes and Cascading Foreign Key Test
db.prepare('INSERT INTO quotes (photo_path, content, type, author) VALUES (?, ?, ?, ?)').run(
    '/photos/old_random.jpg',
    'Life is what happens while you are busy making other plans.',
    'quote',
    'John Lennon'
);

const quote = db.prepare('SELECT * FROM quotes WHERE photo_path = ?').get('/photos/old_random.jpg');
console.log(`✅ Quote insert verified: "${quote.content}" by ${quote.author}`);
if (!quote || quote.author !== 'John Lennon') throw new Error('Quote insert failed');

// 4. Duplicate Quote Content Test
const hasDupQuote = db.prepare('SELECT 1 FROM quotes WHERE content = ? AND photo_path != ?').get(
    'Life is what happens while you are busy making other plans.',
    '/photos/other.jpg'
);
console.log(`✅ Duplicate quote content detected:`, !!hasDupQuote);
if (!hasDupQuote) throw new Error('Duplicate quote detection failed');

// 5. Cascade Delete Test
db.prepare('DELETE FROM photos WHERE path = ?').run('/photos/old_random.jpg');
const orphanQuote = db.prepare('SELECT * FROM quotes WHERE photo_path = ?').get('/photos/old_random.jpg');
console.log(`✅ Cascade delete verified. Orphan quote exists:`, !!orphanQuote);
if (orphanQuote) throw new Error('Cascade delete failed');

// 6. Clean up
db.close();
fs.unlinkSync(TEST_DB);
if (fs.existsSync(`${TEST_DB}-wal`)) fs.unlinkSync(`${TEST_DB}-wal`);
if (fs.existsSync(`${TEST_DB}-shm`)) fs.unlinkSync(`${TEST_DB}-shm`);

console.log('🎉 ALL DATABASE TESTS PASSED!');
