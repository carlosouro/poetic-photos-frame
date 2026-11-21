import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import { config } from './config';

export class PathSecurityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PathSecurityError';
    }
}

/**
 * Ensures a filesystem path resides strictly within NAS_ROOT_PATH.
 * Prevents directory traversal or accidental mutations outside the photo share.
 */
export function assertInsideNas(targetPath: string, rootOverride?: string): string {
    const root = path.resolve(rootOverride || config.nasRootPath);
    if (!root || !targetPath) {
        throw new PathSecurityError('NAS root or target path is empty');
    }
    const resolved = path.resolve(targetPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new PathSecurityError(`Path outside NAS root: ${targetPath}`);
    }
    return resolved;
}

/**
 * Helper to race a promise against a timeout while ALWAYS clearing the timer.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms (${label})`)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// --- SINGLE-FLIGHT NAS CIRCUIT BREAKER ---
const COOLDOWN_MS = 60_000;
let nasOffline = false;
let nasRetryTimestamp = 0;
let inFlightCheck: Promise<boolean> | null = null;

export function isNasOffline(): boolean {
    return nasOffline && Date.now() < nasRetryTimestamp;
}

export function resetNasBreaker(): void {
    nasOffline = false;
    nasRetryTimestamp = 0;
    inFlightCheck = null;
}

export async function checkNasConnection(): Promise<boolean> {
    if (!config.nasRootPath) return false;

    if (nasOffline && Date.now() < nasRetryTimestamp) {
        return false;
    }

    if (inFlightCheck) {
        return inFlightCheck;
    }

    inFlightCheck = (async () => {
        try {
            await withTimeout(fsPromises.access(config.nasRootPath), 3000, 'nas-access');
            if (nasOffline) {
                console.log('✅ NAS connection restored.');
            }
            nasOffline = false;
            return true;
        } catch {
            if (!nasOffline) {
                console.error('⚠️ NAS Circuit Breaker Tripped! Cooldown active for 60s.');
            }
            nasOffline = true;
            nasRetryTimestamp = Date.now() + COOLDOWN_MS;
            return false;
        } finally {
            inFlightCheck = null;
        }
    })();

    return inFlightCheck;
}

export async function safeAccess(targetPath: string, timeoutMs = 3000): Promise<boolean> {
    try {
        await withTimeout(fsPromises.access(targetPath), timeoutMs, 'fs-access');
        return true;
    } catch {
        return false;
    }
}

export async function safeStat(targetPath: string, timeoutMs = 3000): Promise<fs.Stats | null> {
    try {
        return await withTimeout(fsPromises.stat(targetPath), timeoutMs, 'fs-stat');
    } catch {
        return null;
    }
}

export async function safeReadFile(targetPath: string, timeoutMs = 15000): Promise<Buffer> {
    return withTimeout(fsPromises.readFile(targetPath), timeoutMs, `fs-read:${path.basename(targetPath)}`);
}

/**
 * Moves a file into targetDir atomically (server-side SMB rename), avoiding filename collisions.
 */
export async function atomicMoveToDir(srcPath: string, targetDir: string, preferredFileName?: string): Promise<string> {
    await fsPromises.mkdir(targetDir, { recursive: true });

    const fileName = preferredFileName || path.basename(srcPath);
    let destPath = path.join(targetDir, fileName);

    if (path.resolve(srcPath) === path.resolve(destPath)) {
        return destPath;
    }

    if (await safeAccess(destPath)) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        destPath = path.join(targetDir, `${base}_${Date.now()}${ext}`);
    }

    await fsPromises.rename(srcPath, destPath);
    return destPath;
}
