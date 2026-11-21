import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function parsePositiveInt(val: string | undefined, fallback: number): number {
    const parsed = parseInt(val || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');

export const config = {
    port: parsePositiveInt(process.env.PORT, 3000),
    nasRootPath: process.env.NAS_ROOT_PATH ? path.resolve(process.env.NAS_ROOT_PATH) : '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',

    // Folder curation conventions on NAS
    defaultsFolder: '_photoframe_defaults',
    omittedFolder: '_photoframe_omitted',
    unfavoritedFolder: '_photoframe_unfavorited',
    duplicatesFolder: '_photoframe_duplicates',

    errorImageMarker: 'SYSTEM_ERROR_IMAGE',
    exitSentinelPath: '/tmp/poetic-frame.exit',

    // Size guardrails
    maxVideoSizeMb: parsePositiveInt(process.env.MAX_VIDEO_SIZE_MB, 50),
    maxImageSizeMb: parsePositiveInt(process.env.MAX_IMAGE_SIZE_MB, 25),
    get maxVideoSizeBytes() {
        return this.maxVideoSizeMb * 1024 * 1024;
    },
    get maxImageSizeBytes() {
        return this.maxImageSizeMb * 1024 * 1024;
    },

    // Display & timing (tailored for Waveshare 10.1" 1280x800 LCD)
    screenWidth: parsePositiveInt(process.env.FRAME_SCREEN_WIDTH, 1280),
    screenHeight: parsePositiveInt(process.env.FRAME_SCREEN_HEIGHT, 800),
    slideshowIntervalSeconds: parsePositiveInt(process.env.SLIDESHOW_INTERVAL_SECONDS, 20),
    maxVideoDurationSeconds: parsePositiveInt(process.env.MAX_VIDEO_DURATION_SECONDS, 20),

    // Caches & DB
    cacheDir: CACHE_DIR,
    dbPath: path.resolve(process.env.DB_PATH || path.join(CACHE_DIR, 'memories.db')),
    videoCacheDir: path.resolve(process.env.VIDEO_CACHE_DIR || path.join(CACHE_DIR, 'transcoded')),
    imageCacheDir: path.resolve(process.env.IMAGE_CACHE_DIR || path.join(CACHE_DIR, 'images')),
    videoCacheMaxFiles: parsePositiveInt(process.env.VIDEO_CACHE_MAX_FILES, 1500),
    videoCacheMaxSizeBytes: parsePositiveInt(process.env.VIDEO_CACHE_MAX_SIZE_GB, 10) * 1024 * 1024 * 1024,
    imageCacheMaxFiles: parsePositiveInt(process.env.IMAGE_CACHE_MAX_FILES, 500),
    imageCacheMaxSizeBytes: parsePositiveInt(process.env.IMAGE_CACHE_MAX_SIZE_MB, 256) * 1024 * 1024,

    // Pre-warm queue
    prewarmQueueSize: parsePositiveInt(process.env.PREWARM_QUEUE_SIZE, 3),

    // Weather
    weatherLocation: process.env.WEATHER_LOCATION || 'Santarem, Portugal',
    weatherLatitude: parseFloat(process.env.WEATHER_LATITUDE || '39.2338'),
    weatherLongitude: parseFloat(process.env.WEATHER_LONGITUDE || '-8.6862'),
    weatherTimezone: process.env.WEATHER_TIMEZONE || 'Europe/Lisbon',
    weatherCacheTtlMs: parsePositiveInt(process.env.WEATHER_CACHE_TTL_MS, 30 * 60 * 1000)
};

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
export const ALL_MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);

export function isVideoFile(filePath: string): boolean {
    return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function normalizeRotation(deg: number): 0 | 90 | 180 | 270 {
    const normalized = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
    if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
    return 0;
}
