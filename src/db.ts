import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface Photo {
    path: string;
    created: string;
    mediaType?: 'image' | 'video';
    hash?: string;
}

export interface QuoteEntry {
    content: string;
    type: 'quote';
    author: string;
}

export interface DbStats {
    totalPhotos: number;
    totalQuotes: number;
    indexedHashes: number;
    favoritesCount: number;
}

let db: Database.Database;

// Prepared statements cache
let insertPhotoStmt: Database.Statement;
let updateHashStmt: Database.Statement;
let deletePhotoStmt: Database.Statement;
let getPhotoByPathStmt: Database.Statement;
let getPhotoByHashStmt: Database.Statement;
let renamePhotoStmt: Database.Statement;
let countPhotosStmt: Database.Statement;
let countQuotesStmt: Database.Statement;
let countHashesStmt: Database.Statement;
let countFavoritesStmt: Database.Statement;

let getQuoteStmt: Database.Statement;
let insertQuoteStmt: Database.Statement;
let deleteQuoteStmt: Database.Statement;
let hasDuplicateQuoteStmt: Database.Statement;

export function parseDateParts(dateStr: string): { month: number; day: number } {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return { month: 1, day: 1 };
    return { month: d.getMonth() + 1, day: d.getDate() };
}

export function checkIsFavorite(filePath: string): number {
    return (filePath.includes('/_photoframe_defaults/') || filePath.includes('\\_photoframe_defaults\\')) ? 1 : 0;
}

export function initDatabase(dbPath?: string): Database.Database {
    const resolvedPath = dbPath || path.join(process.cwd(), 'cache', 'memories.db');
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const dbExisted = fs.existsSync(resolvedPath);
    db = new Database(resolvedPath);

    // Performance & Durability PRAGMAs
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('cache_size = -64000'); // 64MB cache

    // Schema Initialization
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

    // Prepare reusable statements
    insertPhotoStmt = db.prepare(`
        INSERT OR IGNORE INTO photos (path, created, media_type, hash, month, day, is_favorite)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    updateHashStmt = db.prepare(`
        UPDATE photos SET hash = ? WHERE path = ?
    `);

    deletePhotoStmt = db.prepare(`
        DELETE FROM photos WHERE path = ?
    `);

    getPhotoByPathStmt = db.prepare(`
        SELECT path, created, media_type AS mediaType, hash FROM photos WHERE path = ?
    `);

    getPhotoByHashStmt = db.prepare(`
        SELECT path, created, media_type AS mediaType, hash FROM photos WHERE hash = ? AND path != ? LIMIT 1
    `);

    renamePhotoStmt = db.prepare(`
        UPDATE photos SET path = ?, is_favorite = ? WHERE path = ?
    `);

    countPhotosStmt = db.prepare(`
        SELECT COUNT(*) as count FROM photos
    `);

    countQuotesStmt = db.prepare(`
        SELECT COUNT(*) as count FROM quotes
    `);

    countHashesStmt = db.prepare(`
        SELECT COUNT(*) as count FROM photos WHERE hash IS NOT NULL
    `);

    countFavoritesStmt = db.prepare(`
        SELECT COUNT(*) as count FROM photos WHERE is_favorite = 1
    `);

    getQuoteStmt = db.prepare(`
        SELECT content, type, author FROM quotes WHERE photo_path = ?
    `);

    insertQuoteStmt = db.prepare(`
        INSERT INTO quotes (photo_path, content, type, author)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(photo_path) DO UPDATE SET content = excluded.content, author = excluded.author
    `);

    deleteQuoteStmt = db.prepare(`
        DELETE FROM quotes WHERE photo_path = ?
    `);

    hasDuplicateQuoteStmt = db.prepare(`
        SELECT 1 FROM quotes WHERE content = ? AND photo_path != ? LIMIT 1
    `);

    // Auto-seed from JSON cache files if database was newly created
    if (!dbExisted) {
        const photosJsonPath = path.join(dir, 'photos.json');
        const textsJsonPath = path.join(dir, 'texts.json');

        if (fs.existsSync(photosJsonPath)) {
            try {
                console.log(`📦 Auto-migrating ${photosJsonPath} into SQLite...`);
                const rawPhotos = JSON.parse(fs.readFileSync(photosJsonPath, 'utf-8'));
                insertPhotosBatch(rawPhotos);
                console.log(`✅ Loaded ${rawPhotos.length} photos into database.`);
            } catch (e) {
                console.error("⚠️ Failed to auto-migrate photos.json:", e);
            }
        }

        if (fs.existsSync(textsJsonPath)) {
            try {
                console.log(`📦 Auto-migrating ${textsJsonPath} into SQLite...`);
                const rawTexts = JSON.parse(fs.readFileSync(textsJsonPath, 'utf-8'));
                let qCount = 0;
                const insertManyQuotes = db.transaction((entries: [string, any][]) => {
                    for (const [p, item] of entries) {
                        if (item && item.type === 'quote' && item.author && item.author.trim() && item.content && item.content.trim()) {
                            if (getPhotoByPathStmt.get(p)) {
                                insertQuoteStmt.run(p, item.content.trim(), 'quote', item.author.trim());
                                qCount++;
                            }
                        }
                    }
                });
                insertManyQuotes(Object.entries(rawTexts));
                console.log(`✅ Loaded ${qCount} quotes into database.`);
            } catch (e) {
                console.error("⚠️ Failed to auto-migrate texts.json:", e);
            }
        }
    }

    return db;
}

export function getDbStats(): DbStats {
    const totalPhotos = (countPhotosStmt.get() as any).count;
    const totalQuotes = (countQuotesStmt.get() as any).count;
    const indexedHashes = (countHashesStmt.get() as any).count;
    const favoritesCount = (countFavoritesStmt.get() as any).count;
    return { totalPhotos, totalQuotes, indexedHashes, favoritesCount };
}

export function getPhotoCount(): number {
    return (countPhotosStmt.get() as any).count;
}

export function insertPhotosBatch(photos: Photo[]): number {
    if (!photos || photos.length === 0) return 0;
    let added = 0;
    const insertMany = db.transaction((items: Photo[]) => {
        for (const p of items) {
            const { month, day } = parseDateParts(p.created);
            const isFav = checkIsFavorite(p.path);
            const mediaType = p.mediaType || 'image';
            const info = insertPhotoStmt.run(p.path, p.created, mediaType, p.hash || null, month, day, isFav);
            if (info.changes > 0) added++;
        }
    });
    insertMany(photos);
    return added;
}

export function getPhotoByPath(filePath: string): Photo | undefined {
    return getPhotoByPathStmt.get(filePath) as Photo | undefined;
}

export function getPhotoByHash(hash: string, excludePath: string = ''): Photo | undefined {
    return getPhotoByHashStmt.get(hash, excludePath) as Photo | undefined;
}

export function updatePhotoHash(filePath: string, hash: string): void {
    updateHashStmt.run(hash, filePath);
}

export function removePhoto(filePath: string): void {
    deletePhotoStmt.run(filePath);
}

export function renamePhoto(oldPath: string, newPath: string): void {
    const isFav = checkIsFavorite(newPath);
    db.transaction(() => {
        renamePhotoStmt.run(newPath, isFav, oldPath);
        // Cascading update for quote if present
        db.prepare('UPDATE quotes SET photo_path = ? WHERE photo_path = ?').run(newPath, oldPath);
    })();
}

export function getQuote(photoPath: string): QuoteEntry | undefined {
    return getQuoteStmt.get(photoPath) as QuoteEntry | undefined;
}

export function setQuote(photoPath: string, quote: QuoteEntry): void {
    insertQuoteStmt.run(photoPath, quote.content, 'quote', quote.author);
}

export function deleteQuote(photoPath: string): void {
    deleteQuoteStmt.run(photoPath);
}

export function hasDuplicateQuote(content: string, excludePath: string = ''): boolean {
    const res = hasDuplicateQuoteStmt.get(content, excludePath);
    return !!res;
}

export function migrateQuote(duplicatePath: string, survivorPath: string): void {
    db.transaction(() => {
        const dupQuote = getQuote(duplicatePath);
        const survQuote = getQuote(survivorPath);
        if (dupQuote && !survQuote) {
            db.prepare('UPDATE quotes SET photo_path = ? WHERE photo_path = ?').run(survivorPath, duplicatePath);
        } else {
            deleteQuote(duplicatePath);
        }
    })();
}

export function getRandomPhoto(excludePath: string = ''): Photo | null {
    const total = excludePath
        ? (db.prepare('SELECT COUNT(*) as count FROM photos WHERE path != ?').get(excludePath) as any).count
        : getPhotoCount();

    if (total === 0) return null;
    const offset = Math.floor(Math.random() * total);

    const query = excludePath
        ? 'SELECT path, created, media_type AS mediaType, hash FROM photos WHERE path != ? LIMIT 1 OFFSET ?'
        : 'SELECT path, created, media_type AS mediaType, hash FROM photos LIMIT 1 OFFSET ?';

    const row = excludePath
        ? db.prepare(query).get(excludePath, offset)
        : db.prepare(query).get(offset);

    return (row as Photo) || null;
}

export function getRandomCachedQuotePhoto(excludePath: string = ''): Photo | null {
    const total = excludePath
        ? (db.prepare('SELECT COUNT(*) as count FROM photos p JOIN quotes q ON p.path = q.photo_path WHERE p.path != ?').get(excludePath) as any).count
        : (countQuotesStmt.get() as any).count;

    if (total === 0) return null;
    const offset = Math.floor(Math.random() * total);

    const query = excludePath
        ? `SELECT p.path, p.created, p.media_type AS mediaType, p.hash 
           FROM photos p JOIN quotes q ON p.path = q.photo_path 
           WHERE p.path != ? LIMIT 1 OFFSET ?`
        : `SELECT p.path, p.created, p.media_type AS mediaType, p.hash 
           FROM photos p JOIN quotes q ON p.path = q.photo_path 
           LIMIT 1 OFFSET ?`;

    const row = excludePath
        ? db.prepare(query).get(excludePath, offset)
        : db.prepare(query).get(offset);

    return (row as Photo) || null;
}

/**
 * Smart Memory Selector
 * 80% Chance: Pick from smart candidates (Recent [last 30d] + Anniversaries [same day/month +-10d]). Fallback to Favorites.
 * 10% Chance: Pick from Favorites (_photoframe_defaults).
 * 10% Chance: Pick completely random photo.
 */
export function selectSmartPhoto(excludePath: string = ''): Photo | null {
    const totalPhotos = getPhotoCount();
    if (totalPhotos === 0) return null;

    const now = new Date();
    const currentYear = now.getFullYear();

    // 1. Anniversary Date Window (+- 10 days)
    // Compute date pairs (month, day) for [now - 10d, now + 10d]
    const dateConditions: string[] = [];
    const params: any[] = [];

    // Group days by month to create clean SQL conditions
    const daysByMonth: Record<number, number[]> = {};
    for (let offset = -10; offset <= 10; offset++) {
        const d = new Date(now.getTime() + offset * 86400000);
        const m = d.getMonth() + 1;
        const day = d.getDate();
        if (!daysByMonth[m]) daysByMonth[m] = [];
        daysByMonth[m].push(day);
    }

    for (const [mStr, days] of Object.entries(daysByMonth)) {
        const m = parseInt(mStr, 10);
        const minDay = Math.min(...days);
        const maxDay = Math.max(...days);
        dateConditions.push(`(month = ? AND day BETWEEN ? AND ?)`);
        params.push(m, minDay, maxDay);
    }

    const anniversaryClause = `(${dateConditions.join(' OR ')}) AND created < ?`;
    const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString();
    params.push(oneYearAgo);

    // 2. Recent Date Window (last 30 days)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
    const nowIso = now.toISOString();

    const excludeClause = excludePath ? `AND path != ?` : '';
    const querySmartCandidates = `
        SELECT path, created, media_type AS mediaType, hash FROM photos
        WHERE (
            (${anniversaryClause})
            OR (created >= ? AND created <= ?)
        )
        ${excludeClause}
        ORDER BY RANDOM() LIMIT 1
    `;

    const smartParams = [...params, thirtyDaysAgo, nowIso];
    if (excludePath) smartParams.push(excludePath);

    const roll = Math.random();

    // 80% Smart Candidates
    if (roll < 0.8) {
        const smartMatch = db.prepare(querySmartCandidates).get(...smartParams) as Photo | undefined;
        if (smartMatch) return smartMatch;

        // Fallback to favorite if no smart match
        const favMatch = getFavoritePhoto(excludePath);
        if (favMatch) return favMatch;
    }

    // 10% Favorites
    if (roll < 0.9) {
        const favMatch = getFavoritePhoto(excludePath);
        if (favMatch) return favMatch;
    }

    // 10% Random Fallback
    return getRandomPhoto(excludePath);
}

function getFavoritePhoto(excludePath: string = ''): Photo | null {
    const excludeClause = excludePath ? `AND path != ?` : '';
    const query = `
        SELECT path, created, media_type AS mediaType, hash FROM photos
        WHERE is_favorite = 1 ${excludeClause}
        ORDER BY RANDOM() LIMIT 1
    `;
    const row = excludePath
        ? db.prepare(query).get(excludePath)
        : db.prepare(query).get();

    return (row as Photo) || null;
}
