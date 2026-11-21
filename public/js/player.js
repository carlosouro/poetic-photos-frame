import { api } from './api.js';

const HISTORY_LIMIT = 50;
const OFFLINE_BUFFER_CAP = 30;
const ERROR_IMAGE_MARKER = 'SYSTEM_ERROR_IMAGE';
const CROSSFADE_MS = 1200;

function formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function decodePath(memory) {
    if (!memory?.imagePathEncoded) return '';
    try {
        return decodeURIComponent(memory.imagePathEncoded);
    } catch {
        return memory.imagePathEncoded;
    }
}

export class MemoryPlayer {
    constructor({ slideshowIntervalMs = 20000, onFavoriteStateChange } = {}) {
        this.slideshowIntervalMs = slideshowIntervalMs;
        this.onFavoriteStateChange = onFavoriteStateChange || (() => {});

        this.layers = [0, 1].map((idx) => ({
            container: document.getElementById(`layer-${idx}`),
            backdrop: document.querySelector(`#layer-${idx} .layer-video-backdrop`),
            photo: document.querySelector(`#layer-${idx} .layer-photo`),
            video: document.querySelector(`#layer-${idx} .layer-video`)
        }));

        this.poemEl = document.getElementById('poem-text');
        this.authorEl = document.getElementById('author-text');
        this.dateEl = document.getElementById('date-display');
        this.videoIndicatorEl = document.getElementById('video-indicator');
        this.videoStatusIcon = document.getElementById('video-status-icon');
        this.videoTimeText = document.getElementById('video-time-text');
        this.loaderOverlay = document.getElementById('loader-overlay');
        this.loaderText = document.getElementById('loader-text');

        this.activeLayerIdx = 0;
        this.currentMemory = null;
        this.backStack = [];
        this.forwardStack = [];
        this.offlineBuffer = [];

        this.transitionId = 0;
        this.activeAbortController = null;
        this.isPaused = false;
        this.videoEndedTriggered = false;
        this.decodedFrameCheckDone = false;
        this.lastActivityTimestamp = Date.now();

        this.displayTimer = null;
        this.textFadeTimer = null;
        this.cleanupTimer = null;
        this.loaderTimer = null;

        this.attachMediaListeners();
    }

    getActiveLayer() {
        return this.layers[this.activeLayerIdx];
    }

    getStagingLayer() {
        return this.layers[1 - this.activeLayerIdx];
    }

    getCurrentMemory() {
        return this.currentMemory;
    }

    getCurrentPath() {
        return decodePath(this.currentMemory);
    }

    canGoBack() {
        return this.backStack.length > 0;
    }

    setIntervalMs(ms) {
        if (typeof ms === 'number' && ms >= 5000) {
            this.slideshowIntervalMs = ms;
        }
    }

    showLoader(message = 'Loading...', force = false) {
        if (!force && this.currentMemory) return;
        if (this.loaderTimer) clearTimeout(this.loaderTimer);
        this.loaderText.textContent = message;
        this.loaderOverlay.classList.add('visible');
        this.loaderTimer = setTimeout(() => this.hideLoader(), 12000);
    }

    hideLoader() {
        if (this.loaderTimer) {
            clearTimeout(this.loaderTimer);
            this.loaderTimer = null;
        }
        this.loaderOverlay.classList.remove('visible');
    }

    clearTimers() {
        if (this.displayTimer) {
            clearTimeout(this.displayTimer);
            this.displayTimer = null;
        }
        if (this.textFadeTimer) {
            clearTimeout(this.textFadeTimer);
            this.textFadeTimer = null;
        }
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    resetLayerMedia(layer) {
        try { layer.video.pause(); } catch {}
        layer.video.removeAttribute('src');
        layer.video.load();
        layer.video.style.display = 'none';
        layer.backdrop.style.display = 'none';
        layer.photo.removeAttribute('src');
        layer.photo.style.display = 'none';
    }

    attachMediaListeners() {
        this.layers.forEach((layer, idx) => {
            layer.photo.addEventListener('error', () => {
                if (idx !== this.activeLayerIdx || !this.currentMemory || this.isPaused) return;
                if (!layer.photo.getAttribute('src')) return;
                console.warn(`Active layer ${idx} photo error; advancing.`);
                this.scheduleAdvance(500);
            });

            const vid = layer.video;
            vid.addEventListener('ended', () => {
                if (idx !== this.activeLayerIdx || !this.currentMemory?.isVideo) return;
                if (this.currentMemory.isLivePhoto) {
                    try { vid.pause(); } catch {}
                    return;
                }
                this.handleVideoEnd();
            });

            vid.addEventListener('playing', () => {
                if (idx !== this.activeLayerIdx) return;
                this.decodedFrameCheckDone = false;
            });

            vid.addEventListener('timeupdate', () => {
                if (idx !== this.activeLayerIdx || !this.currentMemory?.isVideo) return;
                const cur = vid.currentTime;
                const dur = vid.duration;

                if (!this.currentMemory.isLivePhoto) {
                    this.videoTimeText.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
                }

                // Skip unsupported video codec (audio/time advances with 0 decoded frames)
                if (!this.decodedFrameCheckDone && cur > 1.5) {
                    this.decodedFrameCheckDone = true;
                    if (typeof vid.webkitDecodedFrameCount === 'number' && vid.webkitDecodedFrameCount === 0) {
                        console.warn('Skipping video with 0 decoded frames.');
                        this.handleVideoEnd();
                        return;
                    }
                }

                // Near-end guard for codecs that stall right before firing native 'ended'
                if (dur > 0 && cur >= dur - 0.25) {
                    if (this.currentMemory.isLivePhoto) {
                        try { vid.pause(); } catch {}
                    } else {
                        this.handleVideoEnd();
                    }
                }
            });

            vid.addEventListener('error', () => {
                if (idx !== this.activeLayerIdx || !this.currentMemory?.isVideo || this.isPaused) return;
                if (!vid.currentSrc && !vid.getAttribute('src')) return;
                console.warn('Active video error; advancing.');
                this.scheduleAdvance(1000);
            });
        });
    }

    paintVideoBackdrop(layer) {
        const vid = layer.video;
        const canvas = layer.backdrop;
        const vw = vid.videoWidth;
        const vh = vid.videoHeight;
        if (!vw || !vh) {
            canvas.style.display = 'none';
            return;
        }

        const videoAspect = vw / vh;
        const screenAspect = window.innerWidth / window.innerHeight;
        if (Math.abs(videoAspect - screenAspect) <= 0.08) {
            canvas.style.display = 'none';
            return;
        }

        try {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
                canvas.style.display = 'block';
            }
        } catch {
            canvas.style.display = 'none';
        }
    }

    scheduleAdvance(delayMs) {
        if (this.displayTimer) clearTimeout(this.displayTimer);
        if (this.isPaused) return;
        this.displayTimer = setTimeout(() => {
            this.displayTimer = null;
            this.next(false);
        }, delayMs);
    }

    scheduleCurrentMediaTimer() {
        if (this.isPaused || !this.currentMemory) return;

        if (!this.currentMemory.isVideo || this.currentMemory.isLivePhoto) {
            this.scheduleAdvance(this.slideshowIntervalMs);
            return;
        }

        const vid = this.getActiveLayer().video;
        const dur = vid.duration;
        const cur = vid.currentTime || 0;
        const safeRemainingMs =
            dur && isFinite(dur) && dur > 0
                ? Math.max((dur - cur + 3) * 1000, 5000)
                : 35000;

        if (this.displayTimer) clearTimeout(this.displayTimer);
        this.displayTimer = setTimeout(() => {
            this.displayTimer = null;
            this.handleVideoEnd();
        }, safeRemainingMs);
    }

    handleVideoEnd() {
        if (!this.currentMemory?.isVideo || this.currentMemory.isLivePhoto || this.videoEndedTriggered || this.isPaused) {
            return;
        }
        this.videoEndedTriggered = true;
        this.scheduleAdvance(350);
    }

    pause() {
        if (this.isPaused) return;
        this.isPaused = true;
        if (this.displayTimer) {
            clearTimeout(this.displayTimer);
            this.displayTimer = null;
        }
        if (this.currentMemory?.isVideo) {
            try { this.getActiveLayer().video.pause(); } catch {}
            if (!this.currentMemory.isLivePhoto) {
                this.videoStatusIcon.textContent = '⏸';
            }
        }
    }

    resume() {
        if (!this.isPaused) return;
        this.isPaused = false;
        this.lastActivityTimestamp = Date.now();
        if (this.currentMemory?.isVideo && !this.currentMemory.isLivePhoto) {
            this.videoStatusIcon.textContent = '▶';
            this.getActiveLayer().video.play().catch(() => {});
        }
        this.scheduleCurrentMediaTimer();
    }

    async prepareLayer(targetLayer, memoryData, signal) {
        if (!memoryData || signal.aborted) return null;

        this.resetLayerMedia(targetLayer);

        if (memoryData.isVideo) {
            const vid = targetLayer.video;
            vid.muted = true;
            vid.preload = 'auto';
            vid.style.display = 'block';
            vid.src = memoryData.mediaUrl || `/api/media?path=${memoryData.imagePathEncoded}`;
            vid.load();

            const ready = await new Promise((resolve) => {
                if (signal.aborted) return resolve(false);
                if (vid.readyState >= 2) return resolve(true);

                let settled = false;
                const finish = (ok) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    vid.removeEventListener('canplay', onReady);
                    vid.removeEventListener('loadeddata', onReady);
                    vid.removeEventListener('error', onErr);
                    signal.removeEventListener('abort', onAbort);
                    resolve(ok);
                };
                const onReady = () => finish(true);
                const onErr = () => finish(false);
                const onAbort = () => finish(false);
                const timer = setTimeout(() => finish(false), 35000);

                vid.addEventListener('canplay', onReady);
                vid.addEventListener('loadeddata', onReady);
                vid.addEventListener('error', onErr);
                signal.addEventListener('abort', onAbort, { once: true });
            });

            if (!ready || signal.aborted) {
                this.resetLayerMedia(targetLayer);
                return null;
            }

            this.paintVideoBackdrop(targetLayer);
            const dur = vid.duration;
            const isLivePhoto = Boolean(dur && isFinite(dur) && dur > 0 && dur < 5.0);
            return { ...memoryData, isVideo: true, isLivePhoto };
        }

        // Image path
        const img = targetLayer.photo;
        const imgSrc = memoryData.mediaUrl || `/api/image?path=${memoryData.imagePathEncoded}`;

        const loaded = await new Promise((resolve) => {
            if (signal.aborted) return resolve(false);

            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                img.removeEventListener('load', onLoad);
                img.removeEventListener('error', onErr);
                signal.removeEventListener('abort', onAbort);
                resolve(ok);
            };
            const onLoad = () => finish(img.naturalWidth > 0);
            const onErr = () => finish(false);
            const onAbort = () => finish(false);
            const timer = setTimeout(() => finish(false), 15000);

            img.addEventListener('load', onLoad);
            img.addEventListener('error', onErr);
            signal.addEventListener('abort', onAbort, { once: true });

            img.src = imgSrc;
            if (img.complete && img.naturalWidth > 0) {
                onLoad();
            }
        });

        if (!loaded || signal.aborted) {
            this.resetLayerMedia(targetLayer);
            return null;
        }

        if (img.decode) {
            try {
                await Promise.race([
                    img.decode(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('decode-timeout')), 5000))
                ]);
            } catch {
                // Loaded image with naturalWidth > 0 can still paint cleanly
            }
        }

        if (signal.aborted) {
            this.resetLayerMedia(targetLayer);
            return null;
        }

        img.style.display = 'block';
        return { ...memoryData, isVideo: false, isLivePhoto: false };
    }

    async waitForVideoFrame(vid, signal) {
        if (!vid.paused && vid.currentTime > 0) return;
        await new Promise((resolve) => {
            if (signal.aborted) return resolve();
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                vid.removeEventListener('playing', finish);
                vid.removeEventListener('timeupdate', finish);
                signal.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, 300);
            vid.addEventListener('playing', finish);
            vid.addEventListener('timeupdate', finish);
            signal.addEventListener('abort', finish, { once: true });
        });
    }

    renderOverlay(memory) {
        if (!memory) return;

        const isAlert = Boolean(memory.isSystemAlert || memory.author === 'System Alert');

        if (memory.isVideo) {
            this.poemEl.textContent = '';
            this.poemEl.style.display = 'none';
            this.authorEl.style.display = 'none';
            this.poemEl.classList.remove('alert-text');
            this.authorEl.classList.remove('alert-text');

            if (memory.isLivePhoto) {
                this.videoIndicatorEl.classList.remove('visible');
            } else {
                const dur = this.getActiveLayer().video.duration;
                this.videoStatusIcon.textContent = this.isPaused ? '⏸' : '▶';
                this.videoTimeText.textContent = `0:00 / ${formatTime(dur)}`;
                this.videoIndicatorEl.classList.add('visible');
            }
        } else {
            this.videoIndicatorEl.classList.remove('visible');
            this.poemEl.textContent = memory.text ? `"${memory.text}"` : '';
            this.poemEl.style.display = memory.text ? 'block' : 'none';
            this.poemEl.classList.toggle('alert-text', isAlert);

            if (memory.type === 'quote' && memory.author) {
                this.authorEl.textContent = isAlert ? memory.author : `— ${memory.author}`;
                this.authorEl.style.display = 'block';
                this.authorEl.classList.toggle('alert-text', isAlert);
            } else {
                this.authorEl.style.display = 'none';
            }
        }

        this.onFavoriteStateChange(Boolean(memory.isFavorite), isAlert);

        const dateObj = new Date(memory.date);
        if (!isAlert && !isNaN(dateObj.getTime()) && dateObj.getFullYear() > 1980) {
            this.dateEl.textContent = dateObj
                .toLocaleDateString('pt-PT', { year: 'numeric', month: 'long', day: 'numeric' })
                .toUpperCase();
        } else {
            this.dateEl.textContent = '';
        }
    }

    addToOfflineBuffer(memory) {
        if (!memory?.imagePathEncoded) return;
        const decoded = decodePath(memory);
        if (memory.isSystemAlert || decoded === ERROR_IMAGE_MARKER) return;

        const idx = this.offlineBuffer.findIndex(m => decodePath(m) === decoded);
        if (idx !== -1) this.offlineBuffer.splice(idx, 1);
        this.offlineBuffer.push(memory);
        if (this.offlineBuffer.length > OFFLINE_BUFFER_CAP) {
            this.offlineBuffer.shift();
        }
    }

    pickOfflineFallback() {
        const currentDecoded = this.getCurrentPath();
        const candidates = this.offlineBuffer.filter(m => decodePath(m) !== currentDecoded);
        if (candidates.length === 0) return null;
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    /**
     * Core deterministic transition engine.
     * Cancels any superseded in-flight fetch, decode, text fade, or cleanup timer via transitionId + AbortController.
     */
    async transition({ direction = 'next', isUserTap = false, pushHistory = true } = {}) {
        const myId = ++this.transitionId;

        if (this.activeAbortController) {
            this.activeAbortController.abort();
        }
        const controller = new AbortController();
        this.activeAbortController = controller;
        const { signal } = controller;

        this.clearTimers();

        // Only show loader on initial bootstrap or if a user tap takes >250ms
        let slowTapLoaderTimer = null;
        if (!this.currentMemory) {
            this.showLoader('Loading memories...', true);
        } else if (isUserTap) {
            slowTapLoaderTimer = setTimeout(() => {
                if (this.transitionId === myId) {
                    this.showLoader(direction === 'back' ? 'Loading previous...' : 'Loading next...', true);
                }
            }, 250);
        }

        try {
            let candidate = null;
            const currentDecoded = this.getCurrentPath();

            if (direction === 'back') {
                if (this.backStack.length === 0) return;
                candidate = this.backStack.pop();
            } else if (direction === 'next' && this.forwardStack.length > 0) {
                candidate = this.forwardStack.pop();
            } else {
                try {
                    candidate = await api.getNextMemory(currentDecoded, signal);
                } catch (err) {
                    if (signal.aborted) return;
                    console.warn('Memory fetch failed:', err?.message || err);
                    candidate = this.pickOfflineFallback();
                }
            }

            if (signal.aborted || myId !== this.transitionId) return;

            const isFirstBoot = !this.currentMemory;
            const targetLayer = isFirstBoot ? this.getActiveLayer() : this.getStagingLayer();

            let prepared = await this.prepareLayer(targetLayer, candidate, signal);
            if (signal.aborted || myId !== this.transitionId) return;

            // If media preparation failed, attempt offline buffer fallback
            if (!prepared) {
                const fallback = this.pickOfflineFallback();
                if (fallback) {
                    prepared = await this.prepareLayer(targetLayer, fallback, signal);
                }
            }

            if (signal.aborted || myId !== this.transitionId) return;

            if (!prepared) {
                this.hideLoader();
                this.scheduleAdvance(2500);
                return;
            }

            // Commit history stacks cleanly (fixes back-button ping-pong bug!)
            if (!isFirstBoot && pushHistory && this.currentMemory) {
                const prevPath = decodePath(this.currentMemory);
                const nextPath = decodePath(prepared);
                if (prevPath && prevPath !== nextPath && !this.currentMemory.isSystemAlert) {
                    if (direction === 'back') {
                        this.forwardStack.push(this.currentMemory);
                        if (this.forwardStack.length > HISTORY_LIMIT) this.forwardStack.shift();
                    } else {
                        this.backStack.push(this.currentMemory);
                        if (this.backStack.length > HISTORY_LIMIT) this.backStack.shift();
                    }
                }
            }

            const outgoingLayer = isFirstBoot ? null : this.getActiveLayer();

            if (prepared.isVideo) {
                try {
                    await targetLayer.video.play();
                } catch {}
                await this.waitForVideoFrame(targetLayer.video, signal);
                if (signal.aborted || myId !== this.transitionId) return;
            }

            this.currentMemory = prepared;
            this.lastActivityTimestamp = Date.now();
            this.videoEndedTriggered = false;
            this.decodedFrameCheckDone = false;

            this.hideLoader();

            if (isFirstBoot) {
                this.renderOverlay(prepared);
                targetLayer.container.classList.add('active');
                if (!prepared.isVideo) {
                    this.poemEl.style.opacity = '1';
                    if (prepared.type === 'quote') this.authorEl.style.opacity = '1';
                }
                this.dateEl.style.opacity = '1';
            } else {
                // Fade overlay text out, swap text, fade back in
                this.poemEl.style.opacity = '0';
                this.authorEl.style.opacity = '0';
                this.dateEl.style.opacity = '0';

                targetLayer.container.classList.add('active');
                outgoingLayer.container.classList.remove('active');
                this.activeLayerIdx = 1 - this.activeLayerIdx;

                this.textFadeTimer = setTimeout(() => {
                    if (myId !== this.transitionId) return;
                    this.renderOverlay(prepared);
                    if (!prepared.isVideo) {
                        this.poemEl.style.opacity = '1';
                        if (prepared.type === 'quote') this.authorEl.style.opacity = '1';
                    }
                    this.dateEl.style.opacity = '1';
                }, 320);

                // Unload outgoing layer media cleanly AFTER crossfade completes
                const layerToClean = outgoingLayer;
                this.cleanupTimer = setTimeout(() => {
                    if (myId !== this.transitionId) return;
                    this.resetLayerMedia(layerToClean);
                }, CROSSFADE_MS + 100);
            }

            this.addToOfflineBuffer(prepared);
            this.scheduleCurrentMediaTimer();
        } catch (err) {
            if (signal.aborted || myId !== this.transitionId) return;
            console.error('Player transition error:', err);
            this.hideLoader();
            this.scheduleAdvance(3000);
        } finally {
            if (slowTapLoaderTimer) clearTimeout(slowTapLoaderTimer);
            if (this.activeAbortController === controller) {
                this.activeAbortController = null;
            }
        }
    }

    next(isUserTap = false) {
        return this.transition({ direction: 'next', isUserTap, pushHistory: true });
    }

    previous() {
        if (!this.canGoBack()) return Promise.resolve();
        return this.transition({ direction: 'back', isUserTap: true, pushHistory: true });
    }

    /**
     * Smoothly swaps the currently displayed photo in-place after Rotate Left / Rotate Right,
     * preserving the same quote, date, history, and paused menu state.
     */
    async refreshCurrentImage(newMediaUrl, newRotation) {
        if (!this.currentMemory || this.currentMemory.isVideo) return;

        const myId = ++this.transitionId;
        if (this.activeAbortController) this.activeAbortController.abort();
        const controller = new AbortController();
        this.activeAbortController = controller;

        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        const updatedMemory = {
            ...this.currentMemory,
            mediaUrl: newMediaUrl,
            rotation: newRotation
        };

        const staging = this.getStagingLayer();
        const outgoing = this.getActiveLayer();

        const prepared = await this.prepareLayer(staging, updatedMemory, controller.signal);
        if (!prepared || controller.signal.aborted || myId !== this.transitionId) return;

        this.currentMemory = prepared;
        this.updateBufferedPathMetadata(decodePath(prepared), {
            mediaUrl: newMediaUrl,
            rotation: newRotation
        });

        staging.container.classList.add('active');
        outgoing.container.classList.remove('active');
        this.activeLayerIdx = 1 - this.activeLayerIdx;

        this.cleanupTimer = setTimeout(() => {
            if (myId !== this.transitionId) return;
            this.resetLayerMedia(outgoing);
        }, CROSSFADE_MS + 100);
    }

    updateCurrentPath(oldPath, { newPath, imagePathEncoded, mediaUrl, isFavorite }) {
        const apply = (item) => {
            if (decodePath(item) === oldPath) {
                item.imagePathEncoded = imagePathEncoded;
                item.mediaUrl = mediaUrl;
                item.isFavorite = isFavorite;
            }
        };

        if (this.currentMemory) apply(this.currentMemory);
        this.backStack.forEach(apply);
        this.forwardStack.forEach(apply);
        this.offlineBuffer.forEach(apply);
    }

    updateBufferedPathMetadata(targetPath, patch) {
        const apply = (item) => {
            if (decodePath(item) === targetPath) {
                Object.assign(item, patch);
            }
        };
        this.backStack.forEach(apply);
        this.forwardStack.forEach(apply);
        this.offlineBuffer.forEach(apply);
    }

    purgePath(targetPath) {
        this.backStack = this.backStack.filter(m => decodePath(m) !== targetPath);
        this.forwardStack = this.forwardStack.filter(m => decodePath(m) !== targetPath);
        this.offlineBuffer = this.offlineBuffer.filter(m => decodePath(m) !== targetPath);
    }

    async skipAfterRemoval(removedPath) {
        this.purgePath(removedPath);
        // Do not push the deleted/omitted photo into backStack
        return this.transition({ direction: 'next', isUserTap: true, pushHistory: false });
    }

    checkWatchdog() {
        // NEVER trigger watchdog while Control Panel or confirmation dialogs are open!
        if (this.isPaused) return;
        const now = Date.now();
        const maxStallMs = Math.max(this.slideshowIntervalMs * 3, 90000);
        if (now - this.lastActivityTimestamp > maxStallMs) {
            console.warn('⚠️ Display watchdog: stalled for too long, advancing...');
            this.lastActivityTimestamp = now;
            this.hideLoader();
            this.next(false);
        }
    }
}
