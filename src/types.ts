export type RotationDegrees = 0 | 90 | 180 | 270;

export interface PhotoRecord {
    id?: number;
    path: string;
    created: string;
    mediaType: 'image' | 'video';
    hash?: string | null;
    isFavorite?: boolean;
    originalPath?: string | null;
    rotation: RotationDegrees;
}

export interface ScannedPhoto {
    path: string;
    created: string;
    mediaType: 'image' | 'video';
    hash?: string;
}

export interface QuoteEntry {
    content: string;
    type: 'quote';
    author: string;
}

export interface DbStats {
    totalPhotos: number;
    totalQuotes: number;
    indexedHashes: number;
    favoritesCount: number;
}

export interface MemoryPayload {
    text: string;
    type: 'quote' | 'video';
    author: string | null;
    date: string;
    imagePathEncoded: string;
    mediaUrl: string;
    isVideo: boolean;
    isFavorite: boolean;
    rotation: RotationDegrees;
    isSystemAlert?: boolean;
}

export interface SystemStatus extends DbStats {
    queueDepth: number;
    isIndexing: boolean;
    nasOnline: boolean;
    uptimeSeconds: number;
}
