import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { config } from './config';
import { getDuplicateQuoteCount, getQuote, setQuote } from './db';
import { prepareImageForAI } from './media';
import { PhotoRecord, QuoteEntry } from './types';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

const RECENT_QUOTES_LIMIT = 50;
const OVERUSED_QUOTE_THRESHOLD = 5;
const FALLBACK_QUOTE: QuoteEntry = {
    content: 'O valor das coisas não está no tempo que elas duram, mas na intensidade com que acontecem.',
    type: 'quote',
    author: 'Fernando Pessoa'
};

const recentDisplayedQuotes: string[] = [];

export function rememberDisplayedQuote(content: string): void {
    const trimmed = content?.trim();
    if (!trimmed) return;
    const existingIdx = recentDisplayedQuotes.indexOf(trimmed);
    if (existingIdx !== -1) {
        recentDisplayedQuotes.splice(existingIdx, 1);
    }
    recentDisplayedQuotes.push(trimmed);
    if (recentDisplayedQuotes.length > RECENT_QUOTES_LIMIT) {
        recentDisplayedQuotes.shift();
    }
}

async function generateWithRetry(
    prompt: string,
    imagePart: { data: string; mimeType: string },
    retries = 3,
    delay = 1000
): Promise<QuoteEntry> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('Gemini API Timeout')), 25000);
        });

        const apiCall = ai.models.generateContent({
            model: config.geminiModel,
            contents: [
                { text: prompt },
                {
                    inlineData: {
                        mimeType: imagePart.mimeType,
                        data: imagePart.data
                    }
                }
            ],
            config: {
                thinkingConfig: {
                    thinkingBudget: 0
                },
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'OBJECT',
                    properties: {
                        content: {
                            type: 'STRING',
                            description: 'A meaningful, profound existing quote matching the photo. Can be famous or lesser-known if it fits the scene and emotional resonance.'
                        },
                        type: {
                            type: 'STRING',
                            enum: ['quote'],
                            description: 'Must always be quote'
                        },
                        author: {
                            type: 'STRING',
                            description: 'The author, thinker, poet, writer, or figure who wrote/said the quote. For folk wisdom use Anonymous, Unknown, Proverb, or Provérbio Popular / Anónimo. Never null.'
                        }
                    },
                    required: ['content', 'type', 'author']
                }
            } as any
        });

        // Prevent unhandled rejection if apiCall rejects after timeoutPromise already settled
        apiCall.catch(() => {});

        const result = (await Promise.race([apiCall, timeoutPromise])) as any;
        const rawText =
            typeof result.text === 'function'
                ? result.text()
                : typeof result.text === 'string'
                    ? result.text
                    : result.candidates?.[0]?.content?.parts?.[0]?.text || '';

        const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        if (!cleanText) {
            const finishReason = result.candidates?.[0]?.finishReason || 'EMPTY_RESPONSE';
            throw new Error(`Gemini returned empty response (${finishReason})`);
        }

        const parsed = JSON.parse(cleanText) as QuoteEntry;
        if (!parsed?.content?.trim() || !parsed?.author?.trim()) {
            throw new Error('Gemini returned incomplete quote payload');
        }

        return {
            content: parsed.content.trim(),
            type: 'quote',
            author: parsed.author.trim()
        };
    } catch (error: any) {
        if (error?.message?.includes('404') || error?.status === 400) {
            throw error;
        }
        const retryable =
            error?.message?.includes('503') ||
            error?.message?.includes('overloaded') ||
            error?.message?.includes('Timeout') ||
            error?.message?.includes('fetch failed');
        if (retries > 0 && retryable) {
            console.log(`⚠️ Gemini API failed (${error.message}). Retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            return generateWithRetry(prompt, imagePart, retries - 1, delay * 2);
        }
        throw error;
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
}

/**
 * Resolves a cached or freshly generated quote for the given photo.
 * Explicit 50/50 PT-PT / English selection in code avoids LLM language bias.
 */
export async function resolveQuoteForPhoto(photo: PhotoRecord): Promise<QuoteEntry> {
    const cachedEntry = getQuote(photo.path);
    let needsRefresh = false;
    let textToExclude = '';

    if (cachedEntry) {
        const recentlyShown = recentDisplayedQuotes.includes(cachedEntry.content.trim());
        const duplicateCount = getDuplicateQuoteCount(cachedEntry.content, photo.path);
        if (recentlyShown || duplicateCount >= OVERUSED_QUOTE_THRESHOLD) {
            needsRefresh = true;
            textToExclude = cachedEntry.content;
            console.log(
                `♻️ Refreshing ${recentlyShown ? 'recently shown' : `overused (${duplicateCount + 1}x)`} quote for ${path.basename(photo.path)}...`
            );
        } else {
            return cachedEntry;
        }
    }

    if (!config.geminiApiKey) {
        return cachedEntry || FALLBACK_QUOTE;
    }

    const excludedQuotes = new Set<string>();
    if (needsRefresh && textToExclude) excludedQuotes.add(textToExclude);
    for (const q of recentDisplayedQuotes.slice(-5)) excludedQuotes.add(q);

    const exclusionInstruction =
        excludedQuotes.size > 0
            ? `IMPORTANT: Do NOT use any of these recently/overused quotes: ${Array.from(excludedQuotes).map(q => `"${q}"`).join('; ')}. Choose a distinct, less clichéd quote.`
            : '';

    const photoDate = new Date(photo.created);
    const now = new Date();
    const yearsAgo = now.getFullYear() - photoDate.getFullYear();
    let temporalContext = '';
    if (yearsAgo > 0 && Math.abs(now.getMonth() - photoDate.getMonth()) <= 1) {
        temporalContext = `Context: This memory is an anniversary memory from ${yearsAgo} ${yearsAgo === 1 ? 'year' : 'years'} ago (${photoDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}).`;
    }

    const chosenLanguage = Math.random() < 0.5
        ? 'European Portuguese (PT-PT) — quotes from Portuguese/Lusophone writers or well-known translated quotes/proverbs are welcomed'
        : 'English';

    const prompt = `
You are a literary curator for a digital photo frame. Look closely at this image.

Goal: Select a profound, meaningful, and poignant existing quote that reflects the scene, mood, location, activity, or emotional resonance of the photo.
${temporalContext ? `${temporalContext}\n` : ''}
${exclusionInstruction}

Directives:
- Only real, authentic, existing quotes. Can be widely famous or lesser-known if it captures the moment better.
- Avoid overly clichéd quotes; favor fresh, evocative literary quotes matching visual details of the scene.
- DO NOT compose your own poem, rhymes, or AI-generated prose.
- Provide the author in the 'author' field. If traditional/folk wisdom, set author to "Anonymous", "Unknown", "Proverb", or "Provérbio Popular" / "Anónimo".
- Language: ${chosenLanguage}.
    `.trim();

    try {
        const imagePart = await prepareImageForAI(photo.path, photo.rotation);
        const generated = await generateWithRetry(prompt, imagePart);
        setQuote(photo.path, generated);
        return generated;
    } catch (err: any) {
        console.error('Gemini quote generation error:', err?.message || err);
        return cachedEntry || FALLBACK_QUOTE;
    }
}
