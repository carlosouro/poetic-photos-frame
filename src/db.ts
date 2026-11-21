import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config, normalizeRotation } from './config';
import { DbStats, PhotoRecord, QuoteEntry, RotationDegrees, ScannedPhoto } from './types';

const CURRENT_SCHEMA_VERSION = 1;

let db: Database.Database | null = null;

// Prepared statements (compiled once at init)
let insertPhotoStmt: Database.Statement;
let upsertScannedPhotoStmt: Database.Statement;
let updateHashStmt: Database.Statement;
let updateRotationStmt: Database.Statement;
let deletePhotoStmt: Database.Statement;
let getPhotoByPathStmt: Database.Statement;
let getPhotoByHashStmt: Database.Statement;
let renamePhotoStmt: Database.Statement;
let renamePhotoWithOriginalStmt: Database.Statement;
let renameQuoteStmt: Database.Statement;
let countPhotosStmt: Database.Statement;
let countQuotesStmt: Database.Statement;
let countHashesStmt: Database.Statement;
let countFavoritesStmt: Database.Statement;
let minMaxIdStmt: Database.Statement;
let randomPhotoGeStmt: Database.Statement;
let randomPhotoLtStmt: Database.Statement;
let favoritePhotosSampleStmt: Database.Statement;
let cachedQuoteSampleStmt: Database.Statement;

let getQuoteStmt: Database.Statement;
let insertQuoteStmt: Database.Statement;
let deleteQuoteStmt: Database.Statement;
let hasDuplicateQuoteStmt: Database.Statement;
let countDuplicateQuoteStmt: Database.Statement;
let pruneUnseenStmt: Database.Statement;

function rowToPhoto(row: any): PhotoRecord | undefined {
    if (!row) return undefined;
    return {
        id: row.id,
        path: row.path,
        created: row.created,
        mediaType: row.mediaType === 'video' ? 'video' : 'image',
        hash: row.hash ?? null,
        isFavorite: Boolean(row.isFavorite),
        originalPath: row.originalPath ?? null,
        rotation: normalizeRotation(row.rotation ?? 0)
    };
}

export function parseDateParts(dateStr: string): { month: number; day: number } {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return { month: 1, day: 1 };
    return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function checkIsFavorite(filePath: string): number {
    const seg = `/${config.defaultsFolder}/`;
    const winSeg = `\\${config.defaultsFolder}\\`;
    return (filePath.includes(seg) || filePath.includes(winSeg)) ? 1 : 0;
}

function getDb(): Database.Database {
    if (!db) {
        throw new Error('Database not initialized. Call initDatabase() first.');
    }
    return db;
}

function createPreMigrationBackup(database: Database.Database, resolvedPath: string): void {
    try {
        database.pragma('wal_checkpoint(TRUNCATE)');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${resolvedPath}.bak.${stamp}`;
        fs.copyFileSync(resolvedPath, backupPath);
        console.log(`💾 Created pre-migration database backup: ${path.basename(backupPath)}`);
    } catch (err) {
        console.error('⚠️ Failed to create pre-migration backup:', err);
        throw err;
    }
}

function runMigrations(database: Database.Database, resolvedPath: string, dbExisted: boolean): void {
    const currentVersion = database.pragma('user_version', { simple: true }) as number;

    // Ensure base tables exist for brand-new databases
    database.exec(`
        CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            created TEXT NOT NULL,
            media_type TEXT DEFAULT 'image',
            hash TEXT,
            month INTEGER NOT NULL,
            day INTEGER NOT NULL,
            is_favorite INTEGER DEFAULT 0,
            original_path TEXT,
            rotation INTEGER NOT NULL DEFAULT 0,
            last_seen_scan INTEGER
        );

        CREATE TABLE IF NOT EXISTS quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            photo_path TEXT UNIQUE NOT NULL REFERENCES photos(path) ON DELETE CASCADE ON UPDATE CASCADE,
            content TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'quote',
            author TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    if (currentVersion < 1) {
        const existingColumns = new Set(
            (database.pragma('table_info(photos)') as Array<{ name: string }>).map(c => c.name)
        );
        const needsAlter =
            !existingColumns.has('original_path') ||
            !existingColumns.has('rotation') ||
            !existingColumns.has('last_seen_scan');

        if (dbExisted && needsAlter) {
            createPreMigrationBackup(database, resolvedPath);
        }

        database.transaction(() => {
            if (!existingColumns.has('original_path')) {
                database.exec('ALTER TABLE photos ADD COLUMN original_path TEXT');
            }
            if (!existingColumns.has('rotation')) {
                database.exec('ALTER TABLE photos ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0');
            }
            if (!existingColumns.has('last_seen_scan')) {
                database.exec('ALTER TABLE photos ADD COLUMN last_seen_scan INTEGER');
            }

            // Drop redundant unique indexes (UNIQUE constraint already provides sqlite_autoindex)
            database.exec('DROP INDEX IF EXISTS idx_photos_path');
            database.exec('DROP INDEX IF EXISTS idx_quotes_path');

            // Ensure required secondary indexes exist
            database.exec(`
                CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(hash);
                CREATE INDEX IF NOT EXISTS idx_photos_anniversary ON photos(month, day);
                CREATE INDEX IF NOT EXISTS idx_photos_created ON photos(created);
                CREATE INDEX IF NOT EXISTS idx_photos_favorite ON photos(is_favorite);
                CREATE INDEX IF NOT EXISTS idx_quotes_content ON quotes(content);
            `);

            database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
        })();

        if (dbExisted && needsAlter) {
            console.log(`✅ Migrated memories.db safely to schema v${CURRENT_SCHEMA_VERSION}.`);
        }
    }
}

function prepareStatements(database: Database.Database): void {
    const PHOTO_COLS = `id, path, created, media_type AS mediaType, hash, is_favorite AS isFavorite, original_path AS originalPath, rotation`;

    insertPhotoStmt = database.prepare(`
        INSERT OR IGNORE INTO photos (path, created, media_type, hash, month, day, is_favorite)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    upsertScannedPhotoStmt = database.prepare(`
        INSERT INTO photos (path, created, media_type, hash, month, day, is_favorite, last_seen_scan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            media_type = excluded.media_type,
            is_favorite = excluded.is_favorite,
            last_seen_scan = excluded.last_seen_scan
    `);

    updateHashStmt = database.prepare(`UPDATE photos SET hash = ? WHERE path = ?`);
    updateRotationStmt = database.prepare(`UPDATE photos SET rotation = ? WHERE path = ?`);
    deletePhotoStmt = database.prepare(`DELETE FROM photos WHERE path = ?`);
    getPhotoByPathStmt = database.prepare(`SELECT ${PHOTO_COLS} FROM photos WHERE path = ?`);
    getPhotoByHashStmt = database.prepare(`SELECT ${PHOTO_COLS} FROM photos WHERE hash = ? AND path != ? LIMIT 1`);

    renamePhotoStmt = database.prepare(`UPDATE photos SET path = ?, is_favorite = ? WHERE path = ?`);
    renamePhotoWithOriginalStmt = database.prepare(`UPDATE photos SET path = ?, is_favorite = ?, original_path = ? WHERE path = ?`);
    renameQuoteStmt = database.prepare(`UPDATE quotes SET photo_path = ? WHERE photo_path = ?`);

    countPhotosStmt = database.prepare(`SELECT COUNT(*) as count FROM photos`);
    countQuotesStmt = database.prepare(`SELECT COUNT(*) as count FROM quotes`);
    countHashesStmt = database.prepare(`SELECT COUNT(*) as count FROM photos WHERE hash IS NOT NULL`);
    countFavoritesStmt = database.prepare(`SELECT COUNT(*) as count FROM photos WHERE is_favorite = 1`);

    minMaxIdStmt = database.prepare(`SELECT MIN(id) AS minId, MAX(id) AS maxId FROM photos`);
    randomPhotoGeStmt = database.prepare(`SELECT ${PHOTO_COLS} FROM photos WHERE id >= ? ORDER BY id ASC LIMIT 12`);
    randomPhotoLtStmt = database.prepare(`SELECT ${PHOTO_COLS} FROM photos WHERE id < ? ORDER BY id ASC LIMIT 12`);

    favoritePhotosSampleStmt = database.prepare(`
        SELECT ${PHOTO_COLS} FROM photos WHERE is_favorite = 1 ORDER BY RANDOM() LIMIT 12
    `);

    cachedQuoteSampleStmt = database.prepare(`
        SELECT p.id, p.path, p.created, p.media_type AS mediaType, p.hash,
               p.is_favorite AS isFavorite, p.original_path AS originalPath, p.rotation
        FROM photos p
        JOIN quotes q ON p.path = q.photo_path
        ORDER BY RANDOM()
        LIMIT 12
    `);

    getQuoteStmt = database.prepare(`SELECT content, type, author FROM quotes WHERE photo_path = ?`);
    insertQuoteStmt = database.prepare(`
        INSERT INTO quotes (photo_path, content, type, author)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(photo_path) DO UPDATE SET content = excluded.content, author = excluded.author
    `);
    deleteQuoteStmt = database.prepare(`DELETE FROM quotes WHERE photo_path = ?`);
    hasDuplicateQuoteStmt = database.prepare(`SELECT 1 FROM quotes WHERE content = ? AND photo_path != ? LIMIT 1`);
    countDuplicateQuoteStmt = database.prepare(`SELECT COUNT(*) as count FROM quotes WHERE content = ? AND photo_path != ?`);
    pruneUnseenStmt = database.prepare(`DELETE FROM photos WHERE last_seen_scan IS NULL OR last_seen_scan != ?`);
}

function autoSeedFromCacheIfEmpty(database: Database.Database, dir: string): void {
    const existingCount = (countPhotosStmt.get() as { count: number }).count;
    if (existingCount > 0) return;

    const photosJsonPath = path.join(dir, 'photos.json');
    const textsJsonPath = path.join(dir, 'texts.json');

    if (fs.existsSync(photosJsonPath)) {
        try {
            console.log(`📦 Auto-migrating ${photosJsonPath} into SQLite...`);
            const rawPhotos = JSON.parse(fs.readFileSync(photosJsonPath, 'utf-8'));
            insertPhotosBatch(rawPhotos);
            console.log(`✅ Loaded ${rawPhotos.length} photos into database.`);
        } catch (e) {
            console.error('⚠️ Failed to auto-migrate photos.json:', e);
        }
    }

    if (fs.existsSync(textsJsonPath)) {
        try {
            console.log(`📦 Auto-migrating ${textsJsonPath} into SQLite...`);
            const rawTexts = JSON.parse(fs.readFileSync(textsJsonPath, 'utf-8'));
            let qCount = 0;
            const insertManyQuotes = database.transaction((entries: [string, any][]) => {
                for (const [p, item] of entries) {
                    if (item && item.type === 'quote' && item.author?.trim() && item.content?.trim()) {
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
            console.error('⚠️ Failed to auto-migrate texts.json:', e);
        }
    }
}

export function initDatabase(dbPath?: string): Database.Database {
    const resolvedPath = dbPath ? path.resolve(dbPath) : config.dbPath;
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const dbExisted = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).size > 0;
    const database = new Database(resolvedPath);

    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    database.pragma('cache_size = -64000');

    runMigrations(database, resolvedPath, dbExisted);
    prepareStatements(database);
    db = database;

    autoSeedFromCacheIfEmpty(database, dir);
    return database;
}

export function closeDatabase(): void {
    if (db) {
        try {
            db.pragma('wal_checkpoint(PASSIVE)');
            db.close();
        } catch (err) {
            console.warn('⚠️ Error closing database:', err);
        } finally {
            db = null;
        }
    }
}

export function getDbStats(): DbStats {
    const totalPhotos = (countPhotosStmt.get() as { count: number }).count;
    const totalQuotes = (countQuotesStmt.get() as { count: number }).count;
    const indexedHashes = (countHashesStmt.get() as { count: number }).count;
    const favoritesCount = (countFavoritesStmt.get() as { count: number }).count;
    return { totalPhotos, totalQuotes, indexedHashes, favoritesCount };
}

export function getPhotoCount(): number {
    return (countPhotosStmt.get() as { count: number }).count;
}

export function insertPhotosBatch(photos: ScannedPhoto[]): number {
    if (!photos || photos.length === 0) return 0;
    const database = getDb();
    let added = 0;
    const insertMany = database.transaction((items: ScannedPhoto[]) => {
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

export function upsertScannedBatch(photos: ScannedPhoto[], scanId: number): number {
    if (!photos || photos.length === 0) return 0;
    const database = getDb();
    let processed = 0;
    const upsertMany = database.transaction((items: ScannedPhoto[]) => {
        for (const p of items) {
            const { month, day } = parseDateParts(p.created);
            const isFav = checkIsFavorite(p.path);
            const mediaType = p.mediaType || 'image';
            upsertScannedPhotoStmt.run(p.path, p.created, mediaType, p.hash || null, month, day, isFav, scanId);
            processed++;
        }
    });
    upsertMany(photos);
    return processed;
}

/**
 * Safely prunes photos not seen in the completed full scan.
 * Refuses to prune if scannedCount dropped >50% below existing DB size (protects against partial NAS mounts).
 */
export function pruneUnseenPhotos(scanId: number, scannedCount: number): { pruned: number; skippedReason?: string } {
    const existingCount = getPhotoCount();
    if (scannedCount <= 0) {
        return { pruned: 0, skippedReason: 'Scan returned 0 files' };
    }
    if (existingCount > 100 && scannedCount < existingCount * 0.5) {
        return {
            pruned: 0,
            skippedReason: `Safety guard: scanned ${scannedCount} < 50% of existing ${existingCount} items`
        };
    }
    const info = pruneUnseenStmt.run(scanId);
    return { pruned: info.changes };
}

export function getPhotoByPath(filePath: string): PhotoRecord | undefined {
    return rowToPhoto(getPhotoByPathStmt.get(filePath));
}

export function getPhotoByHash(hash: string, excludePath: string = ''): PhotoRecord | undefined {
    return rowToPhoto(getPhotoByHashStmt.get(hash, excludePath));
}

export function updatePhotoHash(filePath: string, hash: string): void {
    updateHashStmt.run(hash, filePath);
}

export function setPhotoRotation(filePath: string, rotation: RotationDegrees): void {
    updateRotationStmt.run(normalizeRotation(rotation), filePath);
}

export function removePhoto(filePath: string): void {
    deletePhotoStmt.run(filePath);
}

export function renamePhoto(
    oldPath: string,
    newPath: string,
    originalPathUpdate?: string | null
): void {
    const database = getDb();
    const isFav = checkIsFavorite(newPath);
    database.transaction(() => {
        // defer_foreign_keys handles live Pi databases whose quotes FK lacks ON UPDATE CASCADE
        database.pragma('defer_foreign_keys = ON');
        if (originalPathUpdate !== undefined) {
            renamePhotoWithOriginalStmt.run(newPath, isFav, originalPathUpdate, oldPath);
        } else {
            renamePhotoStmt.run(newPath, isFav, oldPath);
        }
        renameQuoteStmt.run(newPath, oldPath);
    })();
}

export function getQuote(photoPath: string): QuoteEntry | undefined {
    const row = getQuoteStmt.get(photoPath) as QuoteEntry | undefined;
    if (!row || row.type !== 'quote' || !row.content?.trim() || !row.author?.trim()) {
        return undefined;
    }
    return row;
}

export function setQuote(photoPath: string, quote: QuoteEntry): void {
    insertQuoteStmt.run(photoPath, quote.content.trim(), 'quote', quote.author.trim());
}

export function deleteQuote(photoPath: string): void {
    deleteQuoteStmt.run(photoPath);
}

export function hasDuplicateQuote(content: string, excludePath: string = ''): boolean {
    return !!hasDuplicateQuoteStmt.get(content, excludePath);
}

export function getDuplicateQuoteCount(content: string, excludePath: string = ''): number {
    const res = countDuplicateQuoteStmt.get(content, excludePath) as { count: number } | undefined;
    return res ? res.count : 0;
}

export function migrateQuote(duplicatePath: string, survivorPath: string): void {
    const database = getDb();
    database.transaction(() => {
        const dupQuote = getQuote(duplicatePath);
        const survQuote = getQuote(survivorPath);
        if (dupQuote && !survQuote) {
            renameQuoteStmt.run(survivorPath, duplicatePath);
        } else {
            deleteQuoteStmt.run(duplicatePath);
        }
    })();
}

function pickFirstNotExcluded(rows: any[], excluded: Set<string>): PhotoRecord | null {
    for (const row of rows) {
        if (!excluded.has(row.path)) {
            return rowToPhoto(row) || null;
        }
    }
    return null;
}

/**
 * O(log N) random photo lookup via primary key range sampling (avoids O(N) OFFSET scans on 94k+ rows).
 */
export function getRandomPhoto(excludePaths: string | string[] = []): PhotoRecord | null {
    const excluded = new Set(Array.isArray(excludePaths) ? excludePaths : (excludePaths ? [excludePaths] : []));
    const bounds = minMaxIdStmt.get() as { minId: number | null; maxId: number | null };
    if (bounds.minId === null || bounds.maxId === null) return null;

    const targetId = bounds.minId + Math.floor(Math.random() * (bounds.maxId - bounds.minId + 1));
    const upper = randomPhotoGeStmt.all(targetId);
    const match = pickFirstNotExcluded(upper, excluded);
    if (match) return match;

    const lower = randomPhotoLtStmt.all(targetId);
    return pickFirstNotExcluded(lower, excluded);
}

export function getRandomCachedQuotePhoto(excludePaths: string | string[] = []): PhotoRecord | null {
    const excluded = new Set(Array.isArray(excludePaths) ? excludePaths : (excludePaths ? [excludePaths] : []));
    const rows = cachedQuoteSampleStmt.all();
    return pickFirstNotExcluded(rows, excluded);
}

function getFavoritePhoto(excluded: Set<string>): PhotoRecord | null {
    const rows = favoritePhotosSampleStmt.all();
    return pickFirstNotExcluded(rows, excluded);
}

/**
 * Smart Memory Selector:
 *  - 80% Chance: Recent (last 30d) + Anniversaries (same month/day ±10d from prior years). Fallback -> Favorites.
 *  - 10% Chance: Favorites (_photoframe_defaults).
 *  - 10% Chance: Completely random photo.
 *
 * Anniversary cutoff uses `created < now - 300 days` so photos from 1 year ago +1..+10 days
 * are accurately included across year boundaries.
 */
export function selectSmartPhoto(excludePaths: string | string[] = [], referenceDate: Date = new Date()): PhotoRecord | null {
    if (getPhotoCount() === 0) return null;
    const database = getDb();
    const excluded = new Set(Array.isArray(excludePaths) ? excludePaths : (excludePaths ? [excludePaths] : []));

    const daysByMonth: Record<number, number[]> = {};
    for (let offset = -10; offset <= 10; offset++) {
        const d = new Date(referenceDate.getTime() + offset * 86400000);
        const m = d.getUTCMonth() + 1;
        const day = d.getUTCDate();
        if (!daysByMonth[m]) daysByMonth[m] = [];
        daysByMonth[m].push(day);
    }

    const dateConditions: string[] = [];
    const params: any[] = [];
    for (const [mStr, days] of Object.entries(daysByMonth)) {
        const m = parseInt(mStr, 10);
        dateConditions.push(`(month = ? AND day BETWEEN ? AND ?)`);
        params.push(m, Math.min(...days), Math.max(...days));
    }

    const anniversaryCutoffIso = new Date(referenceDate.getTime() - 300 * 86400000).toISOString();
    const thirtyDaysAgoIso = new Date(referenceDate.getTime() - 30 * 86400000).toISOString();
    const nowIso = referenceDate.toISOString();

    const roll = Math.random();

    if (roll < 0.8) {
        const smartSql = `
            SELECT id, path, created, media_type AS mediaType, hash,
                   is_favorite AS isFavorite, original_path AS originalPath, rotation
            FROM photos
            WHERE (
                ((${dateConditions.join(' OR ')}) AND created < ?)
                OR (created >= ? AND created <= ?)
            )
            ORDER BY RANDOM()
            LIMIT 12
        `;
        const rows = database.prepare(smartSql).all(...params, anniversaryCutoffIso, thirtyDaysAgoIso, nowIso);
        const smartMatch = pickFirstNotExcluded(rows, excluded);
        if (smartMatch) return smartMatch;

        const favMatch = getFavoritePhoto(excluded);
        if (favMatch) return favMatch;
    }

    if (roll < 0.9) {
        const favMatch = getFavoritePhoto(excluded);
        if (favMatch) return favMatch;
    }

    return getRandomPhoto(Array.from(excluded));
}
