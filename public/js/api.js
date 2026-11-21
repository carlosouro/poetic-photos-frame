async function requestJson(url, options = {}) {
    const res = await fetch(url, options);
    let body = null;
    try {
        body = await res.json();
    } catch {}
    if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
    }
    return body;
}

export const api = {
    getConfig() {
        return requestJson('/api/config');
    },

    getStatus() {
        return requestJson('/api/status');
    },

    getNextMemory(currentPathEncoded, signal) {
        const query = currentPathEncoded
            ? `?current=${encodeURIComponent(currentPathEncoded)}`
            : '';
        return requestJson(`/api/next-memory${query}`, { signal });
    },

    toggleFavorite(currentPath) {
        return requestJson('/api/favorite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath })
        });
    },

    rotatePhoto(currentPath, delta) {
        return requestJson('/api/rotate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath, delta })
        });
    },

    omitPhoto(currentPath) {
        return requestJson('/api/omit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath })
        });
    },

    deletePhoto(currentPath) {
        return requestJson('/api/photo', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath })
        });
    },

    getWeather() {
        return requestJson('/api/weather');
    },

    reboot() {
        return requestJson('/api/reboot', { method: 'POST' });
    },

    exit() {
        return requestJson('/api/exit', { method: 'POST' });
    }
};
