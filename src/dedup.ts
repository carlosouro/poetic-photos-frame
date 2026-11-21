import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config';
import { migrateQuote, removePhoto } from './db';
import { atomicMoveToDir } from './nas';

export function computeFileSha256(filePath: string, timeoutMs = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                stream.destroy();
                reject(new Error(`SHA-256 hash timed out for ${path.basename(filePath)}`));
            }
        }, timeoutMs);

        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(hash.digest('hex'));
            }
        });
        stream.on('error', (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        });
    });
}

export function scorePathForSurvival(filePath: string): number {
    let score = 0;
    const base = path.basename(filePath);
    const lowerPath = filePath.toLowerCase();

    // 1. Favorites folder always takes absolute priority
    if (filePath.includes(config.defaultsFolder)) {
        score += 10000;
    }

    // 2. Penalize copy/duplicate filename suffixes (e.g. " (1)", "_1", " - Copy")
    const dupSuffixRegex = /([_\s-](copy|\(\d+\)|\d{1,2}))\.[a-z0-9]+$/i;
    if (dupSuffixRegex.test(base)) {
        score -= 500;
    }

    // 3. Penalize generic dump/backup/messenger folders
    const dumpFolderRegex = /\/(mobilebackup|downloads|whatsapp|staging|temp|tmp|camera\s*roll)\//i;
    if (dumpFolderRegex.test(lowerPath)) {
        score -= 200;
    }

    // 4. Shorter directory depth indicates more curated placement
    const depth = filePath.split(path.sep).length;
    score -= depth * 5;

    return score;
}

export function determineSurvivor(
    pathA: string,
    pathB: string,
    createdA?: string,
    createdB?: string
): { survivor: string; duplicate: string } {
    const scoreA = scorePathForSurvival(pathA);
    const scoreB = scorePathForSurvival(pathB);

    if (scoreA !== scoreB) {
        return scoreA > scoreB
            ? { survivor: pathA, duplicate: pathB }
            : { survivor: pathB, duplicate: pathA };
    }

    if (createdA && createdB) {
        const timeA = new Date(createdA).getTime();
        const timeB = new Date(createdB).getTime();
        if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
            return timeA < timeB
                ? { survivor: pathA, duplicate: pathB }
                : { survivor: pathB, duplicate: pathA };
        }
    }

    return pathA.localeCompare(pathB) <= 0
        ? { survivor: pathA, duplicate: pathB }
        : { survivor: pathB, duplicate: pathA };
}

/**
 * Moves duplicate into _photoframe_duplicates preserving relative hierarchy,
 * migrates quote to survivor BEFORE deleting duplicate photo row (avoiding ON DELETE CASCADE quote loss).
 */
export async function quarantineDuplicate(
    duplicatePath: string,
    survivorPath: string,
    nasRootOverride?: string
): Promise<boolean> {
    try {
        const nasRoot = nasRootOverride || config.nasRootPath;
        if (!nasRoot) return false;

        let relPath = path.relative(nasRoot, duplicatePath);
        if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
            relPath = path.basename(duplicatePath);
        }

        const targetDir = path.join(nasRoot, config.duplicatesFolder, path.dirname(relPath));
        await atomicMoveToDir(duplicatePath, targetDir, path.basename(relPath));

        // CRITICAL ORDER: migrate quote BEFORE removePhoto(), otherwise ON DELETE CASCADE wipes it!
        migrateQuote(duplicatePath, survivorPath);
        removePhoto(duplicatePath);

        console.log(
            `🗑️ Auto-quarantined duplicate: ${path.basename(duplicatePath)} -> ${config.duplicatesFolder}/${relPath} (Survivor: ${path.basename(survivorPath)})`
        );
        return true;
    } catch (err) {
        console.error(`❌ Failed to quarantine duplicate ${path.basename(duplicatePath)}:`, err);
        return false;
    }
}
