import path from 'path';
import { config, isVideoFile, normalizeRotation } from './config';
import {
    getPhotoByHash,
    getPhotoCount,
    getRandomPhoto,
    removePhoto,
    selectSmartPhoto,
    updatePhotoHash
} from './db';
import { computeFileSha256, determineSurvivor, quarantineDuplicate } from './dedup';
import { rememberDisplayedQuote, resolveQuoteForPhoto } from './ai';
import { ensureDisplayImage, ensureOptimizedVideo } from './media';
import { checkNasConnection, isNasOffline, safeStat } from './nas';
import { MemoryPayload, PhotoRecord, RotationDegrees } from './types';

interface QueuedEntry {
    filePath: string;
    payload: MemoryPayload;
}

export function buildImageMediaUrl(filePath: string, rotation: RotationDegrees = 0): string {
    return `/api/image?path=${encodeURIComponent(filePath)}&r=${normalizeRotation(rotation)}`;
}

export function buildVideoMediaUrl(filePath: string): string {
    return `/api/media?path=${encodeURIComponent(filePath)}`;
}

export function buildSystemAlertPayload(text: string): MemoryPayload {
    return {
        text,
        type: 'quote',
        author: 'System Alert',
        date: new Date().toISOString(),
        imagePathEncoded: encodeURIComponent(config.errorImageMarker),
        mediaUrl: `/api/image?path=${encodeURIComponent(config.errorImageMarker)}`,
        isVideo: false,
        isFavorite: false,
        rotation: 0,
        isSystemAlert: true
    };
}

export class MemoryQueue {
    private targetSize: number;
    private ready: QueuedEntry[] = [];
    private recentPaths: string[] = [];
    private readonly recentLimit = 25;
    private invalidatedInFlight = new Set<string>();
    private activeInFlightPath: string | null = null;

    private workerRunning = false;
    private stopped = false;
    private waiters: Array<() => void> = [];

    constructor(targetSize = config.prewarmQueueSize) {
        this.targetSize = Math.max(1, targetSize);
    }

    public start(): void {
        this.stopped = false;
        this.scheduleRefill();
    }

    public stop(): void {
        this.stopped = true;
        this.notifyWaiters();
    }

    public getDepth(): number {
        return this.ready.length;
    }

    public clear(): void {
        this.ready = [];
        if (this.activeInFlightPath) {
            this.invalidatedInFlight.add(this.activeInFlightPath);
        }
        this.scheduleRefill();
    }

    public invalidatePath(filePath: string): void {
        this.ready = this.ready.filter(entry => entry.filePath !== filePath);
        if (this.activeInFlightPath === filePath) {
            this.invalidatedInFlight.add(filePath);
        }
        this.scheduleRefill();
    }

    private rememberPath(filePath: string): void {
        const idx = this.recentPaths.indexOf(filePath);
        if (idx !== -1) this.recentPaths.splice(idx, 1);
        this.recentPaths.push(filePath);
        if (this.recentPaths.length > this.recentLimit) {
            this.recentPaths.shift();
        }
    }

    private getExcludedPaths(extraExclude?: string): string[] {
        const set = new Set<string>(this.recentPaths);
        for (const entry of this.ready) set.add(entry.filePath);
        if (this.activeInFlightPath) set.add(this.activeInFlightPath);
        if (extraExclude) set.add(extraExclude);
        return Array.from(set);
    }

    private notifyWaiters(): void {
        const pending = this.waiters.splice(0, this.waiters.length);
        for (const wake of pending) wake();
    }

    private waitForItem(timeoutMs: number): Promise<void> {
        return new Promise((resolve) => {
            let done = false;
            const onWake = () => {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    resolve();
                }
            };
            const timer = setTimeout(() => {
                if (!done) {
                    done = true;
                    const idx = this.waiters.indexOf(onWake);
                    if (idx !== -1) this.waiters.splice(idx, 1);
                    resolve();
                }
            }, timeoutMs);
            this.waiters.push(onWake);
        });
    }

    public scheduleRefill(): void {
        if (this.stopped || this.workerRunning) return;
        if (this.ready.length >= this.targetSize) return;
        this.runWorker().catch(err => {
            console.error('❌ MemoryQueue worker error:', err);
        });
    }

    private async runWorker(): Promise<void> {
        this.workerRunning = true;
        let consecutiveFailures = 0;

        try {
            while (!this.stopped && this.ready.length < this.targetSize) {
                if (getPhotoCount() === 0) break;
                if (config.nasRootPath && !(await checkNasConnection())) break;

                const entry = await this.prepareOne();
                if (entry) {
                    consecutiveFailures = 0;
                    if (!this.invalidatedInFlight.has(entry.filePath)) {
                        this.ready.push(entry);
                        this.notifyWaiters();
                    }
                    this.invalidatedInFlight.delete(entry.filePath);
                } else {
                    consecutiveFailures++;
                    this.notifyWaiters();
                    if (consecutiveFailures >= 5) {
                        // Back off briefly if storage or files are repeatedly failing
                        await new Promise(r => setTimeout(r, 3000));
                        break;
                    }
                }
            }
        } finally {
            this.activeInFlightPath = null;
            this.workerRunning = false;
            this.notifyWaiters();
        }
    }

    private async selectValidCandidate(): Promise<PhotoRecord | null> {
        const excluded = this.getExcludedPaths();

        for (let attempt = 0; attempt < 12; attempt++) {
            const candidate =
                selectSmartPhoto(excluded) ||
                getRandomPhoto(excluded) ||
                getRandomPhoto();

            if (!candidate) return null;

            const stat = await safeStat(candidate.path);
            if (!stat || stat.size <= 0) {
                if (!isNasOffline()) {
                    removePhoto(candidate.path);
                }
                excluded.push(candidate.path);
                continue;
            }

            const isVideo = candidate.mediaType === 'video' || isVideoFile(candidate.path);
            const maxSize = isVideo ? config.maxVideoSizeBytes : config.maxImageSizeBytes;
            if (stat.size > maxSize) {
                console.warn(
                    `⚠️ Skipping oversized media (${(stat.size / (1024 * 1024)).toFixed(1)}MB): ${path.basename(candidate.path)}`
                );
                excluded.push(candidate.path);
                continue;
            }

            // On-the-fly streaming SHA-256 deduplication
            let hash = candidate.hash;
            if (!hash) {
                try {
                    hash = await computeFileSha256(candidate.path);
                    updatePhotoHash(candidate.path, hash);
                    candidate.hash = hash;
                } catch (hashErr: any) {
                    console.warn(`⚠️ Hash failed for ${path.basename(candidate.path)}:`, hashErr?.message || hashErr);
                }
            }

            if (hash) {
                const existing = getPhotoByHash(hash, candidate.path);
                if (existing) {
                    const { survivor, duplicate } = determineSurvivor(
                        candidate.path,
                        existing.path,
                        candidate.created,
                        existing.created
                    );

                    if (duplicate === candidate.path) {
                        await quarantineDuplicate(candidate.path, survivor);
                        excluded.push(candidate.path);
                        continue;
                    } else {
                        await quarantineDuplicate(existing.path, candidate.path);
                        updatePhotoHash(candidate.path, hash);
                    }
                }
            }

            return candidate;
        }

        return null;
    }

    private async prepareOne(): Promise<QueuedEntry | null> {
        const candidate = await this.selectValidCandidate();
        if (!candidate) return null;

        this.activeInFlightPath = candidate.path;
        this.invalidatedInFlight.delete(candidate.path);

        try {
            const isFavorite = candidate.path.includes(config.defaultsFolder);
            const isVideo = candidate.mediaType === 'video' || isVideoFile(candidate.path);

            if (isVideo) {
                // Pre-transcode in serial queue so playback starts immediately when popped
                await ensureOptimizedVideo(candidate.path);
                return {
                    filePath: candidate.path,
                    payload: {
                        text: '',
                        type: 'video',
                        author: null,
                        date: candidate.created,
                        imagePathEncoded: encodeURIComponent(candidate.path),
                        mediaUrl: buildVideoMediaUrl(candidate.path),
                        isVideo: true,
                        isFavorite,
                        rotation: 0
                    }
                };
            }

            // Image: pre-render 1280x800 WebP (with blurred backdrop if portrait) + resolve quote in parallel
            const [, quote] = await Promise.all([
                ensureDisplayImage(candidate.path, candidate.rotation),
                resolveQuoteForPhoto(candidate)
            ]);

            return {
                filePath: candidate.path,
                payload: {
                    text: quote.content,
                    type: 'quote',
                    author: quote.author,
                    date: candidate.created,
                    imagePathEncoded: encodeURIComponent(candidate.path),
                    mediaUrl: buildImageMediaUrl(candidate.path, candidate.rotation),
                    isVideo: false,
                    isFavorite,
                    rotation: normalizeRotation(candidate.rotation)
                }
            };
        } catch (err: any) {
            console.warn(`⚠️ Failed to pre-warm ${path.basename(candidate.path)}:`, err?.message || err);
            return null;
        } finally {
            this.activeInFlightPath = null;
        }
    }

    public async popNext(excludePath?: string): Promise<MemoryPayload> {
        if (config.nasRootPath) {
            const nasOnline = await checkNasConnection();
            if (!nasOnline) {
                return buildSystemAlertPayload('Storage not accessible. Retrying shortly...');
            }
        }

        if (getPhotoCount() === 0) {
            return {
                ...buildSystemAlertPayload('Loading memories from storage...'),
                author: 'Poetic Memories'
            };
        }

        // Fast path: return a pre-warmed memory immediately (<5ms)
        const takeReady = (): QueuedEntry | undefined => {
            const idx = this.ready.findIndex(e => !excludePath || e.filePath !== excludePath);
            if (idx !== -1) {
                return this.ready.splice(idx, 1)[0];
            }
            return undefined;
        };

        let entry = takeReady();
        if (!entry) {
            this.scheduleRefill();
            // Wait up to 25s for the background worker to deliver an item
            const deadline = Date.now() + 25000;
            while (!entry && Date.now() < deadline && !this.stopped) {
                await this.waitForItem(Math.min(5000, Math.max(100, deadline - Date.now())));
                entry = takeReady();
                if (!entry && !this.workerRunning) {
                    // Worker stopped without producing an item
                    break;
                }
            }
        }

        this.scheduleRefill();

        if (!entry) {
            return buildSystemAlertPayload(
                isNasOffline() ? 'Waiting for storage connection...' : 'Finding your next memory...'
            );
        }

        this.rememberPath(entry.filePath);
        if (!entry.payload.isVideo && entry.payload.text) {
            rememberDisplayedQuote(entry.payload.text);
        }
        return entry.payload;
    }
}

export const memoryQueue = new MemoryQueue();
