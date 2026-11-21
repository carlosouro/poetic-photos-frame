import { api } from './api.js';

function decodePath(memory) {
    if (!memory?.imagePathEncoded) return '';
    try {
        return decodeURIComponent(memory.imagePathEncoded);
    } catch {
        return memory.imagePathEncoded;
    }
}

/**
 * Light-dismiss fallback for browsers without native <dialog closedby="any"> support.
 */
function installClosedByFallback(dialog) {
    if ('closedBy' in HTMLDialogElement.prototype) return;

    const isOutside = (e) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };

    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
        pressedOutside = isOutside(e);
    });
    dialog.addEventListener('pointerup', (e) => {
        if (pressedOutside && isOutside(e)) {
            dialog.close('');
        }
        pressedOutside = false;
    });
}

export function initControls(player) {
    const quickFavBtn = document.getElementById('quick-fav');
    const zoneLeft = document.getElementById('zone-left');
    const zoneCenter = document.getElementById('zone-center');
    const zoneRight = document.getElementById('zone-right');
    const tapFeedbackLeft = document.getElementById('tap-feedback-left');
    const tapFeedbackRight = document.getElementById('tap-feedback-right');

    const menuDialog = document.getElementById('menu-dialog');
    const deleteDialog = document.getElementById('delete-dialog');
    const confirmDialog = document.getElementById('confirm-dialog');

    const btnRotateLeft = document.getElementById('btn-rotate-left');
    const btnRotateRight = document.getElementById('btn-rotate-right');
    const btnOmit = document.getElementById('btn-omit');
    const btnDelete = document.getElementById('btn-delete');
    const btnReload = document.getElementById('btn-reload');
    const btnReboot = document.getElementById('btn-reboot');
    const btnExit = document.getElementById('btn-exit');
    const statusFooter = document.getElementById('status-footer');

    const deletePreviewImg = document.getElementById('delete-preview-img');
    const deletePreviewVideo = document.getElementById('delete-preview-video');

    const confirmTitle = document.getElementById('confirm-dialog-title');
    const confirmMessage = document.getElementById('confirm-dialog-message');
    const confirmAcceptBtn = document.getElementById('confirm-dialog-accept');

    const toastEl = document.getElementById('toast');
    const toastMessageEl = document.getElementById('toast-message');
    const srAnnouncements = document.getElementById('sr-announcements');

    installClosedByFallback(menuDialog);

    let actionBusy = false;
    let toastTimer = null;
    let pendingDeleteMemory = null;
    let pendingConfirmAction = null;

    function isAnyDialogOpen() {
        return menuDialog.open || deleteDialog.open || confirmDialog.open;
    }

    function flashTapFeedback(el) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 260);
    }

    function showToast(message, { isError = false, durationMs = 2600 } = {}) {
        // Never surface toast notifications behind an open modal dialog
        if (isAnyDialogOpen()) return;

        if (toastTimer) clearTimeout(toastTimer);
        toastMessageEl.textContent = message;
        toastEl.classList.toggle('toast-error', isError);

        if (typeof toastEl.showPopover === 'function') {
            try {
                if (toastEl.matches(':popover-open')) toastEl.hidePopover();
                toastEl.showPopover();
            } catch {}
        } else {
            toastEl.classList.add(':popover-open');
        }

        if (typeof document.ariaNotify === 'function') {
            try { document.ariaNotify(message); } catch {}
        } else {
            srAnnouncements.textContent = message;
        }

        toastTimer = setTimeout(() => {
            // Do not dismiss if focus is currently on the dismiss control
            if (toastEl.contains(document.activeElement)) return;
            if (typeof toastEl.hidePopover === 'function') {
                try { toastEl.hidePopover(); } catch {}
            } else {
                toastEl.classList.remove(':popover-open');
            }
        }, durationMs);
    }

    async function refreshStatusFooter() {
        try {
            const st = await api.getStatus();
            const photosFmt = st.totalPhotos.toLocaleString('en-US');
            const quotesFmt = st.totalQuotes.toLocaleString('en-US');
            const nasState = st.nasOnline ? 'NAS OK' : 'NAS OFFLINE';
            const indexTag = st.isIndexing ? ' · Indexing…' : '';
            statusFooter.textContent = `${photosFmt} memories · ${quotesFmt} quotes · ${nasState}${indexTag}`;
            statusFooter.classList.toggle('offline', !st.nasOnline);
        } catch {
            statusFooter.textContent = 'Status unavailable';
            statusFooter.classList.add('offline');
        }
    }

    function syncMenuButtonsState() {
        const mem = player.getCurrentMemory();
        const hasRealMedia = Boolean(mem && !mem.isSystemAlert);
        const canRotate = hasRealMedia && !mem.isVideo;

        btnRotateLeft.disabled = !canRotate || actionBusy;
        btnRotateRight.disabled = !canRotate || actionBusy;
        btnOmit.disabled = !hasRealMedia || actionBusy;
        btnDelete.disabled = !hasRealMedia || actionBusy;
    }

    function teardownDeletePreview() {
        try { deletePreviewVideo.pause(); } catch {}
        deletePreviewVideo.removeAttribute('src');
        deletePreviewVideo.load();
        deletePreviewVideo.style.display = 'none';
        deletePreviewImg.removeAttribute('src');
        deletePreviewImg.style.display = 'none';
    }

    function openControlPanel() {
        if (isAnyDialogOpen()) return;
        player.pause();
        syncMenuButtonsState();
        refreshStatusFooter();
        menuDialog.showModal();
    }

    // Resume playback whenever the last open dialog closes
    function handleDialogClosed() {
        if (!isAnyDialogOpen() && !actionBusy) {
            player.resume();
        }
    }

    menuDialog.addEventListener('close', () => {
        menuDialog.returnValue = '';
        handleDialogClosed();
    });

    deleteDialog.addEventListener('close', async () => {
        const decision = deleteDialog.returnValue;
        deleteDialog.returnValue = '';
        teardownDeletePreview();

        const targetMem = pendingDeleteMemory;
        pendingDeleteMemory = null;

        if (decision === 'confirm' && targetMem) {
            await performDelete(targetMem);
        } else {
            handleDialogClosed();
        }
    });

    confirmDialog.addEventListener('close', async () => {
        const decision = confirmDialog.returnValue;
        confirmDialog.returnValue = '';

        const action = pendingConfirmAction;
        pendingConfirmAction = null;

        if (decision === 'confirm' && action) {
            await action();
        } else {
            handleDialogClosed();
        }
    });

    // --- 3-ZONE TOUCH NAVIGATION ---
    zoneLeft.addEventListener('click', () => {
        if (isAnyDialogOpen() || actionBusy) return;
        if (!player.canGoBack()) return;
        flashTapFeedback(tapFeedbackLeft);
        player.previous();
    });

    zoneCenter.addEventListener('click', () => {
        if (isAnyDialogOpen() || actionBusy) return;
        openControlPanel();
    });

    zoneRight.addEventListener('click', () => {
        if (isAnyDialogOpen() || actionBusy) return;
        flashTapFeedback(tapFeedbackRight);
        player.next(true);
    });

    // --- QUICK FAVORITE ---
    quickFavBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mem = player.getCurrentMemory();
        if (!mem || mem.isSystemAlert || actionBusy || isAnyDialogOpen()) return;

        const currentPath = decodePath(mem);
        actionBusy = true;
        quickFavBtn.classList.remove('pulse');
        void quickFavBtn.offsetWidth;
        quickFavBtn.classList.add('pulse');

        try {
            const res = await api.toggleFavorite(currentPath);
            if (res.success) {
                player.updateCurrentPath(currentPath, res);
                quickFavBtn.classList.toggle('active', Boolean(res.isFavorite));
                showToast(res.isFavorite ? 'Added to favorites' : 'Removed from favorites');
            }
        } catch (err) {
            showToast(`Favorite failed: ${err.message}`, { isError: true });
        } finally {
            actionBusy = false;
        }
    });

    // --- ROTATE LEFT / RIGHT ---
    async function handleRotate(delta) {
        const mem = player.getCurrentMemory();
        if (!mem || mem.isVideo || mem.isSystemAlert || actionBusy) return;

        const currentPath = decodePath(mem);
        actionBusy = true;
        syncMenuButtonsState();

        try {
            const res = await api.rotatePhoto(currentPath, delta);
            if (res.success) {
                await player.refreshCurrentImage(res.mediaUrl, res.rotation);
            }
        } catch (err) {
            menuDialog.close();
            showToast(`Rotate failed: ${err.message}`, { isError: true });
        } finally {
            actionBusy = false;
            syncMenuButtonsState();
        }
    }

    btnRotateLeft.addEventListener('click', () => handleRotate(-90));
    btnRotateRight.addEventListener('click', () => handleRotate(90));

    // --- OMIT PHOTO ---
    btnOmit.addEventListener('click', async () => {
        const mem = player.getCurrentMemory();
        if (!mem || mem.isSystemAlert || actionBusy) return;

        const targetPath = decodePath(mem);
        actionBusy = true;
        menuDialog.close();
        player.showLoader('Omitting...', true);

        try {
            await api.omitPhoto(targetPath);
            actionBusy = false;
            player.resume();
            await player.skipAfterRemoval(targetPath);
            showToast('Memory omitted');
        } catch (err) {
            player.hideLoader();
            actionBusy = false;
            player.resume();
            showToast(`Omit failed: ${err.message}`, { isError: true });
        }
    });

    // --- DELETE PHOTO (LOCKED TO CAPTURED PREVIEW MEMORY) ---
    btnDelete.addEventListener('click', () => {
        const mem = player.getCurrentMemory();
        if (!mem || mem.isSystemAlert || actionBusy) return;

        // Capture snapshot strictly at modal open time so delete can NEVER target a different file
        pendingDeleteMemory = { ...mem };
        menuDialog.close();

        if (pendingDeleteMemory.isVideo) {
            deletePreviewImg.style.display = 'none';
            deletePreviewVideo.style.display = 'block';
            deletePreviewVideo.src = pendingDeleteMemory.mediaUrl;
        } else {
            deletePreviewVideo.style.display = 'none';
            deletePreviewImg.style.display = 'block';
            deletePreviewImg.src = pendingDeleteMemory.mediaUrl;
        }

        deleteDialog.showModal();
    });

    async function performDelete(targetMem) {
        const targetPath = decodePath(targetMem);
        actionBusy = true;
        player.showLoader('Deleting...', true);

        try {
            await api.deletePhoto(targetPath);
            actionBusy = false;
            player.resume();
            await player.skipAfterRemoval(targetPath);
            showToast('Memory deleted');
        } catch (err) {
            player.hideLoader();
            actionBusy = false;
            player.resume();
            showToast(`Delete failed: ${err.message}`, { isError: true });
        }
    }

    // --- RELOAD, RESTART, EXIT ---
    btnReload.addEventListener('click', () => {
        window.location.reload();
    });

    btnReboot.addEventListener('click', () => {
        menuDialog.close();
        confirmTitle.textContent = 'Restart Device?';
        confirmMessage.textContent = 'The Raspberry Pi will reboot and resume the photo frame automatically.';
        confirmAcceptBtn.textContent = 'Restart';
        pendingConfirmAction = async () => {
            player.showLoader('Restarting Device...', true);
            try {
                await api.reboot();
            } catch (err) {
                player.hideLoader();
                showToast(`Restart failed: ${err.message}`, { isError: true });
            }
        };
        confirmDialog.showModal();
    });

    btnExit.addEventListener('click', () => {
        menuDialog.close();
        confirmTitle.textContent = 'Exit App?';
        confirmMessage.textContent = 'This will close the kiosk display and stop the photo frame server.';
        confirmAcceptBtn.textContent = 'Exit App';
        pendingConfirmAction = async () => {
            player.showLoader('Shutting Down...', true);
            try {
                await api.exit();
            } catch {}
            setTimeout(() => {
                try { window.close(); } catch {}
                player.hideLoader();
            }, 2500);
        };
        confirmDialog.showModal();
    });

    return {
        isAnyDialogOpen,
        updateFavoriteIndicator(isFavorite, isAlert) {
            quickFavBtn.classList.toggle('active', Boolean(isFavorite));
            quickFavBtn.style.visibility = isAlert ? 'hidden' : 'visible';
        }
    };
}
