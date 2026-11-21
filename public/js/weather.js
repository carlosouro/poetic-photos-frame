import { api } from './api.js';

const WEATHER_ICONS = {
    sunny: `<svg viewBox="0 0 24 24" fill="none" stroke="#f5af19" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5" fill="#f5af19" fill-opacity="0.3"/>
        <line x1="12" y1="1" x2="12" y2="3"/>
        <line x1="12" y1="21" x2="12" y2="23"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
        <line x1="1" y1="12" x2="3" y2="12"/>
        <line x1="21" y1="12" x2="23" y2="12"/>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>`,
    'partly-cloudy': `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2v2" stroke="#f5af19"/>
        <path d="M4.93 4.93l1.41 1.41" stroke="#f5af19"/>
        <path d="M20 12h2" stroke="#f5af19"/>
        <path d="M19.07 4.93l-1.41 1.41" stroke="#f5af19"/>
        <path d="M15.5 8.5A4.5 4.5 0 0 0 8 11a4 4 0 0 0 .5 8h9a3.5 3.5 0 0 0 0-7c-.3 0-.6.04-.88.11" fill="#fff" fill-opacity="0.2" stroke="#fff"/>
    </svg>`,
    cloudy: `<svg viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" fill="#fff" fill-opacity="0.2"/>
    </svg>`,
    rainy: `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" stroke="#ccc" fill="#fff" fill-opacity="0.1"/>
        <line x1="8" y1="19" x2="8" y2="21" stroke="#4fc3f7"/>
        <line x1="12" y1="17" x2="12" y2="21" stroke="#4fc3f7"/>
        <line x1="16" y1="19" x2="16" y2="21" stroke="#4fc3f7"/>
    </svg>`,
    snowy: `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25" stroke="#ccc" fill="#fff" fill-opacity="0.1"/>
        <circle cx="8" cy="20" r="1" fill="#fff"/>
        <circle cx="12" cy="19" r="1" fill="#fff"/>
        <circle cx="16" cy="20" r="1" fill="#fff"/>
    </svg>`,
    thunderstorm: `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 16.9A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" stroke="#ccc" fill="#fff" fill-opacity="0.1"/>
        <polygon points="13 11 9 17 14 17 11 23 18 15 13 15 15 11" fill="#ffd166" stroke="#ffd166"/>
    </svg>`,
    foggy: `<svg viewBox="0 0 24 24" fill="none" stroke="#bbb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="4" y1="7" x2="20" y2="7"/>
        <line x1="6" y1="11" x2="18" y2="11"/>
        <line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="7" y1="19" x2="17" y2="19"/>
    </svg>`
};

export function initWeatherWidget() {
    const widget = document.getElementById('weather-widget');
    const timeA = document.getElementById('weather-time-a');
    const dayA = document.getElementById('weather-day-a');
    const iconA = document.getElementById('weather-icon-a');
    const tempA = document.getElementById('weather-temp-a');
    const timeB = document.getElementById('weather-time-b');
    const dayB = document.getElementById('weather-day-b');
    const iconB = document.getElementById('weather-icon-b');
    const tempB = document.getElementById('weather-temp-b');

    async function refresh() {
        try {
            const data = await api.getWeather();
            if (!data?.slotA || !data?.slotB) return;

            timeA.textContent = data.slotA.timeLabel || '8am';
            dayA.textContent = data.slotA.dayLabel;
            iconA.innerHTML = WEATHER_ICONS[data.slotA.symbol] || WEATHER_ICONS['partly-cloudy'];
            tempA.textContent = String(data.slotA.temp);

            timeB.textContent = data.slotB.timeLabel || '4pm';
            dayB.textContent = data.slotB.dayLabel;
            iconB.innerHTML = WEATHER_ICONS[data.slotB.symbol] || WEATHER_ICONS['partly-cloudy'];
            tempB.textContent = String(data.slotB.temp);

            widget.classList.add('visible');
        } catch {
            // Retain last valid display on transient network failure
        }
    }

    refresh();
    setInterval(refresh, 10 * 60 * 1000);
}
