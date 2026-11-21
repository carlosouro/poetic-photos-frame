import { config } from './config';

export interface WeatherSlot {
    timeLabel: string;
    dayLabel: 'today' | 'tmrw';
    targetIso: string;
    symbol: 'sunny' | 'partly-cloudy' | 'cloudy' | 'rainy' | 'snowy' | 'thunderstorm' | 'foggy';
    temp: number;
    weatherCode: number;
}

export interface WeatherResponse {
    location: string;
    updatedAt: string;
    slotA: WeatherSlot;
    slotB: WeatherSlot;
}

export function weatherCodeToSymbol(code: number): WeatherSlot['symbol'] {
    if (code === 0 || code === 1) return 'sunny';
    if (code === 2) return 'partly-cloudy';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'foggy';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rainy';
    if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return 'snowy';
    if (code >= 95 && code <= 99) return 'thunderstorm';
    return 'partly-cloudy';
}

export class WeatherService {
    private locationName: string;
    private latitude: number;
    private longitude: number;
    private timezone: string;
    private cacheTtlMs: number;

    private cachedRawData: any = null;
    private lastFetchTime = 0;
    private inFlightFetch: Promise<any> | null = null;

    constructor(opts?: {
        locationName?: string;
        latitude?: number;
        longitude?: number;
        timezone?: string;
        cacheTtlMs?: number;
    }) {
        this.locationName = opts?.locationName || config.weatherLocation;
        this.latitude = opts?.latitude ?? config.weatherLatitude;
        this.longitude = opts?.longitude ?? config.weatherLongitude;
        this.timezone = opts?.timezone || config.weatherTimezone;
        this.cacheTtlMs = opts?.cacheTtlMs ?? config.weatherCacheTtlMs;
    }

    private getZonedParts(date: Date): { year: number; month: number; day: number; dateStr: string; hour: number } {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: this.timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: 'numeric',
            hourCycle: 'h23'
        })
            .formatToParts(date)
            .reduce<Record<string, string>>((acc, p) => {
                acc[p.type] = p.value;
                return acc;
            }, {});

        const year = parseInt(parts.year, 10);
        const month = parseInt(parts.month, 10);
        const day = parseInt(parts.day, 10);
        const hour = parseInt(parts.hour, 10);
        return { year, month, day, dateStr: `${parts.year}-${parts.month}-${parts.day}`, hour };
    }

    private getNextDayStr(year: number, month: number, day: number): string {
        const next = new Date(Date.UTC(year, month - 1, day + 1));
        const y = next.getUTCFullYear();
        const m = String(next.getUTCMonth() + 1).padStart(2, '0');
        const d = String(next.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    /**
     * Single-flight fetch coalescing: concurrent callers await the same in-flight promise.
     */
    public async fetchForecast(): Promise<any> {
        if (this.inFlightFetch) {
            return this.inFlightFetch;
        }

        const url = `https://api.open-meteo.com/v1/forecast?latitude=${this.latitude}&longitude=${this.longitude}&hourly=temperature_2m,weather_code&daily=temperature_2m_max&timezone=${encodeURIComponent(this.timezone)}&forecast_days=3`;

        this.inFlightFetch = (async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            try {
                const response = await fetch(url, { signal: controller.signal });
                if (!response.ok) {
                    throw new Error(`Open-Meteo returned HTTP ${response.status}`);
                }
                const data = await response.json();
                this.cachedRawData = data;
                this.lastFetchTime = Date.now();
                return data;
            } finally {
                clearTimeout(timeoutId);
                this.inFlightFetch = null;
            }
        })();

        return this.inFlightFetch;
    }

    /**
     * Computes 8am and 4pm slots. Returns null if required forecast data is missing
     * (e.g. stale multi-day outage cache) instead of fabricating "0° Sunny".
     */
    public computeSlots(now: Date, rawData: any): WeatherResponse | null {
        if (!rawData?.hourly?.time || !rawData?.hourly?.temperature_2m || !rawData?.hourly?.weather_code || !rawData?.daily?.time || !rawData?.daily?.temperature_2m_max) {
            return null;
        }

        const { dateStr: todayStr, year, month, day, hour: currentHour } = this.getZonedParts(now);
        const tomorrowStr = this.getNextDayStr(year, month, day);

        // Slot A (8am): Today if hour < 12, Tomorrow if hour >= 12
        const slotAIsTomorrow = currentHour >= 12;
        const slotADate = slotAIsTomorrow ? tomorrowStr : todayStr;
        const slotADayLabel: 'today' | 'tmrw' = slotAIsTomorrow ? 'tmrw' : 'today';
        const slotATargetIso = `${slotADate}T08:00`;

        const idxA = rawData.hourly.time.indexOf(slotATargetIso);
        if (idxA === -1) return null;

        const rawTempA = rawData.hourly.temperature_2m[idxA];
        const rawCodeA = rawData.hourly.weather_code[idxA];
        if (typeof rawTempA !== 'number' || typeof rawCodeA !== 'number') return null;

        // Slot B (4pm): Today if hour < 19, Tomorrow if hour >= 19
        const slotBIsTomorrow = currentHour >= 19;
        const slotBDate = slotBIsTomorrow ? tomorrowStr : todayStr;
        const slotBDayLabel: 'today' | 'tmrw' = slotBIsTomorrow ? 'tmrw' : 'today';
        const slotBTargetIso = `${slotBDate}T16:00`;

        const idxB = rawData.hourly.time.indexOf(slotBTargetIso);
        const dailyIdxB = rawData.daily.time.indexOf(slotBDate);
        if (idxB === -1 || dailyIdxB === -1) return null;

        const rawCodeB = rawData.hourly.weather_code[idxB];
        const rawTempB = rawData.daily.temperature_2m_max[dailyIdxB];
        if (typeof rawTempB !== 'number' || typeof rawCodeB !== 'number') return null;

        return {
            location: this.locationName,
            updatedAt: new Date(this.lastFetchTime || now.getTime()).toISOString(),
            slotA: {
                timeLabel: '8am',
                dayLabel: slotADayLabel,
                targetIso: slotATargetIso,
                symbol: weatherCodeToSymbol(rawCodeA),
                temp: Math.round(rawTempA),
                weatherCode: rawCodeA
            },
            slotB: {
                timeLabel: '4pm',
                dayLabel: slotBDayLabel,
                targetIso: slotBTargetIso,
                symbol: weatherCodeToSymbol(rawCodeB),
                temp: Math.round(rawTempB),
                weatherCode: rawCodeB
            }
        };
    }

    public async getWeather(): Promise<WeatherResponse | null> {
        const now = Date.now();
        if (!this.cachedRawData || now - this.lastFetchTime > this.cacheTtlMs) {
            try {
                await this.fetchForecast();
            } catch (err: any) {
                console.warn(`[WeatherService] Forecast fetch failed: ${err?.message || err}. Using cache if available.`);
            }
        }

        if (!this.cachedRawData) return null;
        return this.computeSlots(new Date(), this.cachedRawData);
    }
}

export const weatherService = new WeatherService();
