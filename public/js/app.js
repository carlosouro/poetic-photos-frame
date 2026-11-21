import { api } from './api.js';
import { MemoryPlayer } from './player.js';
import { initControls } from './controls.js';
import { initWeatherWidget } from './weather.js';

let controlsApi = null;

const player = new MemoryPlayer({
    slideshowIntervalMs: 20000,
    onFavoriteStateChange(isFavorite, isAlert) {
        controlsApi?.updateFavoriteIndicator(isFavorite, isAlert);
    }
});

controlsApi = initControls(player);
initWeatherWidget();

// Auto-hide cursor on Wayland/X11 kiosk after 2s of inactivity
let cursorTimer = null;
document.addEventListener('mousemove', () => {
    document.body.classList.remove('hide-cursor');
    if (cursorTimer) clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
        if (!controlsApi.isAnyDialogOpen()) {
            document.body.classList.add('hide-cursor');
        }
    }, 2000);
});

// Pause-aware self-healing watchdog (never fires while Control Panel or modals are open)
setInterval(() => {
    player.checkWatchdog();
}, 15000);

// Fetch server-configured defaults (SLIDESHOW_INTERVAL_SECONDS from .env) then boot slideshow
(async () => {
    try {
        const cfg = await api.getConfig();
        if (cfg?.slideshowIntervalMs) {
            player.setIntervalMs(cfg.slideshowIntervalMs);
        }
    } catch {
        // Default 20s already configured
    }
    player.next(false);
})();
