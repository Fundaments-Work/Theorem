
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeTextForAudio } from "./text-normalization";

let _isAndroid: boolean | null = null;

function isAndroid(): boolean {
    if (_isAndroid !== null) return _isAndroid;
    try {
        _isAndroid = !!(window as any).__TAURI_INTERNALS__ &&
            navigator.userAgent.toLowerCase().includes('android');
    } catch { _isAndroid = false; }
    return _isAndroid;
}

function isTauri(): boolean {
    try { return !!(window as any).__TAURI_INTERNALS__; }
    catch { return false; }
}

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused';

export interface SentenceInfo {
    text: string;
    index: number;
    startChar: number;
    endChar: number;
}

export interface PlaybackCallbacks {
    onStateChange?: (state: PlaybackState) => void;
    /** Real playback position, reported while the neural buffer plays. */
    onProgress?: (elapsedSec: number, durationSec: number) => void;
    /** Emitted when the currently narrated sentence changes (or null on stop). */
    onSentenceChange?: (sentence: SentenceInfo | null, totalSentences: number) => void;
    /** Emitted when nearing the end of current page audio to prefetch the next. */
    onNearEnd?: () => void;
    onError?: (message: string) => void;
    onComplete?: () => void;
}

export function segmentSentences(text: string): SentenceInfo[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        try {
            const segmenter = new (Intl as any).Segmenter('en', { granularity: 'sentence' });
            const segments = Array.from(segmenter.segment(text)) as { segment: string; index: number }[];
            const result: SentenceInfo[] = [];
            let idx = 0;
            for (const s of segments) {
                const sText = s.segment.trim();
                if (!sText) continue;
                result.push({
                    text: sText,
                    index: idx++,
                    startChar: s.index,
                    endChar: s.index + s.segment.length,
                });
            }
            if (result.length > 0) return result;
        } catch { /* fallback to regex */ }
    }

    const sentenceRegex = /[^.!?\s][^.!?]*(?:[.!?]+['"”’)]?|\s*$)/g;
    const result: SentenceInfo[] = [];
    let match: RegExpExecArray | null;
    let idx = 0;
    while ((match = sentenceRegex.exec(text)) !== null) {
        const sText = match[0].trim();
        if (sText) {
            result.push({
                text: sText,
                index: idx++,
                startChar: match.index,
                endChar: match.index + match[0].length,
            });
        }
    }
    if (result.length === 0 && trimmed) {
        result.push({
            text: trimmed,
            index: 0,
            startChar: 0,
            endChar: text.length,
        });
    }
    return result;
}

export interface SpeakOptions {
    voice?: string | null;
    speed?: number;
    /** ISO language hint used by the Supertonic text wrapper (default "en"). */
    lang?: string;
}

export interface NeuralStatus {
    runtimeReady: boolean;
    modelsReady: boolean;
    engineLoaded: boolean;
    available: boolean;
}

export const NEURAL_VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const;
export type NeuralVoice = (typeof NEURAL_VOICES)[number];

export const NEURAL_VOICE_LABELS: Record<NeuralVoice, string> = {
    F1: "Female 1", F2: "Female 2", F3: "Female 3", F4: "Female 4", F5: "Female 5",
    M1: "Male 1", M2: "Male 2", M3: "Male 3", M4: "Male 4", M5: "Male 5",
};

/** Map a stored voice selection to an installed neural voice file. */
export function resolveNeuralVoice(voice: string | null | undefined): NeuralVoice {
    return (NEURAL_VOICES as readonly string[]).includes(voice ?? "")
        ? (voice as NeuralVoice)
        : "F1";
}

/** Availability of the desktop Supertonic engine. Never available on Android —
 *  there the neural voice comes from the companion TTS engine app instead. */
export async function getNeuralStatus(): Promise<NeuralStatus> {
    const unavailable: NeuralStatus = {
        runtimeReady: false, modelsReady: false, engineLoaded: false, available: false,
    };
    if (!isTauri() || isAndroid()) return unavailable;
    try {
        return await invoke<NeuralStatus>("tts_neural_status");
    } catch {
        return unavailable;
    }
}

// Fallback duration estimate for desktop OS voices, which report no completion.
const BASE_CHARS_PER_SEC = (158 * 5.1) / 60;

class ImmersionPlayer {
    private callbacks: PlaybackCallbacks = {};
    private _state: PlaybackState = 'idle';

    // ── Neural session (desktop Supertonic, native Rust playback) ───────────
    private nativeSession = false;
    private durationSec = 0;
    private lastPosSec = 0;
    private streamDone = false;
    private progressTimer: ReturnType<typeof setInterval> | null = null;
    private currentText = '';

    // ── Sentence tracking & prefetch coordination ───────────────────────────
    private activeChunks: string[] = [];
    private lastChunkIndex = -1;
    private platformSentences: SentenceInfo[] = [];
    private lastSentenceIndex = -1;
    private nearEndEmitted = false;
    private platformFallbackTimer: ReturnType<typeof setInterval> | null = null;

    // ── Platform session (Android engine app / desktop OS voice) ────────────
    private voice: string | null = null;
    private fullText = '';
    private fullWords: string[] = [];
    private lastRangeEnd = 0;
    private startTime = 0;
    private completeTimer: ReturnType<typeof setTimeout> | null = null;
    private platformEventsBound = false;

    private unloadTimer: ReturnType<typeof setTimeout> | null = null;

    get state(): PlaybackState { return this._state; }

    private setState(s: PlaybackState) {
        if (this._state === s) return;
        this._state = s;
        this.callbacks.onStateChange?.(s);
    }

    private scheduleEngineUnload() {
        this.cancelEngineUnload();
        this.unloadTimer = setTimeout(() => {
            this.unloadTimer = null;
            if (this._state === 'idle' && isTauri()) {
                invoke("tts_engine_unload").catch(() => {});
            }
        }, 60_000);
    }

    private cancelEngineUnload() {
        if (this.unloadTimer) {
            clearTimeout(this.unloadTimer);
            this.unloadTimer = null;
        }
    }

    init(callbacks: PlaybackCallbacks = {}) { this.callbacks = callbacks; }

    async speak(text: string, opts: SpeakOptions = {}) {
        this._clearAll();
        this.cancelEngineUnload();
        const trimmed = text.trim();
        if (!trimmed || !isTauri()) return;

        const normalized = normalizeTextForAudio(trimmed);
        this.currentText = normalized;
        const neural = await getNeuralStatus();
        // Superseded by a newer speak()/stop() while awaiting the status probe.
        if (normalized !== this.currentText) return;
        if (neural.available) {
            await this.speakNeural(normalized, opts);
        } else {
            await this.speakPlatform(normalized, opts.voice ?? null, opts.speed ?? 1);
        }
    }

    // ── Neural: synthesize to WAV, play through the native Rust player ──────

    private async speakNeural(text: string, opts: SpeakOptions) {
        const voice = resolveNeuralVoice(opts.voice);
        const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
        const lang = opts.lang || "en";
        this.setState('loading');
        try {
            // Streaming: synthesize only the first sentence chunk, start
            // playback, then synthesize and queue the rest while audio plays.
            const chunks = await invoke<string[]>("tts_text_chunks", { text, lang });
            if (text !== this.currentText) return;
            this.activeChunks = chunks;
            this.lastChunkIndex = 0;
            this.nearEndEmitted = false;

            const first = await invoke<{ path: string; duration_sec: number; cached: boolean }>(
                "tts_synthesize", { text: chunks[0], voice, speed, lang },
            );
            if (text !== this.currentText || this._state !== 'loading') return;
            // Native playback (rodio/cpal in Rust) — bypasses webview audio,
            // which could stay silently suspended outside a gesture stack.
            await invoke("tts_audio_play", { path: first.path });
            if (text !== this.currentText || this._state !== 'loading') return;
            this.nativeSession = true;
            this.durationSec = first.duration_sec;
            this.lastPosSec = 0;
            this.streamDone = chunks.length <= 1;

            if (chunks.length > 0) {
                this.callbacks.onSentenceChange?.({
                    text: chunks[0],
                    index: 0,
                    startChar: 0,
                    endChar: chunks[0].length,
                }, chunks.length);
            }

            this.startProgressTimer();
            this.setState('playing');

            if (chunks.length > 1) {
                void this.streamChunks(text, chunks.slice(1), voice, speed, lang);
            }
        } catch (err: unknown) {
            this._onError(err instanceof Error ? err.message : String(err));
        }
    }

    /** Synthesize the remaining chunks one by one and append to the queue.
     *  The engine serializes synthesis behind a mutex, so this loop already
     *  keeps it saturated; if playback outpaces it, the native player's
     *  append-on-drain resumes seamlessly (see the underrun handling above). */
    private async streamChunks(
        text: string,
        chunks: string[],
        voice: NeuralVoice,
        speed: number,
        lang: string,
    ) {
        for (const chunk of chunks) {
            if (text !== this.currentText || !this.nativeSession) return;
            try {
                const result = await invoke<{ path: string; duration_sec: number; cached: boolean }>(
                    "tts_synthesize", { text: chunk, voice, speed, lang },
                );
                if (text !== this.currentText || !this.nativeSession) return;
                await invoke("tts_audio_append", { path: result.path });
                this.durationSec += result.duration_sec;
            } catch (err: unknown) {
                if (text === this.currentText && this.nativeSession) {
                    this._onError(err instanceof Error ? err.message : String(err));
                }
                return;
            }
        }
        this.streamDone = true;
    }

    private startProgressTimer() {
        this.stopProgressTimer();
        this.progressTimer = setInterval(async () => {
            if (this._state !== 'playing' || !this.nativeSession) return;
            try {
                const status = await invoke<{
                    position: number;
                    duration: number;
                    chunk_index: number;
                    finished: boolean;
                }>("tts_audio_status");

                this.lastPosSec = status.position;
                this.callbacks.onProgress?.(status.position, this.durationSec);

                if (
                    status.chunk_index !== this.lastChunkIndex &&
                    this.activeChunks.length > 0 &&
                    status.chunk_index < this.activeChunks.length
                ) {
                    this.lastChunkIndex = status.chunk_index;
                    const chunkText = this.activeChunks[status.chunk_index];
                    this.callbacks.onSentenceChange?.({
                        text: chunkText,
                        index: status.chunk_index,
                        startChar: 0,
                        endChar: chunkText.length,
                    }, this.activeChunks.length);
                }

                if (!this.nearEndEmitted && this.activeChunks.length > 0 && status.chunk_index >= this.activeChunks.length - 1) {
                    this.nearEndEmitted = true;
                    this.callbacks.onNearEnd?.();
                }

                if (status.finished && !this.streamDone && this._state === 'playing' && this.nativeSession) {
                    // Underrun: the queue drained while later chunks are still
                    // synthesizing. Not a completion — hold the playing state;
                    // the native player reports the end of synthesized audio as
                    // the position, and appending the next chunk resumes it.
                    if (import.meta.env.DEV) {
                        console.debug("[tts] queue underrun, waiting for synthesis");
                    }
                } else if (status.finished && this.streamDone && this._state === 'playing' && this.nativeSession) {
                    this._onDone();
                }
            } catch { /* transient IPC error; next tick retries */ }
        }, 100);
    }

    private stopProgressTimer() {
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }

    /** Real seek over the native player (seconds from the start of the page). */
    async seek(seconds: number) {
        if (!this.nativeSession) return;
        const target = Math.max(0, Math.min(seconds, this.durationSec - 0.05));
        try {
            await invoke("tts_audio_seek", { seconds: target });
            this.lastPosSec = target;
            if (this._state === 'paused') {
                this.callbacks.onProgress?.(target, this.durationSec);
            }
        } catch { /* seek unsupported for the current source */ }
    }

    // ── Platform: OS/engine voice with estimated or event-driven timing ─────

    private async speakPlatform(text: string, voice: string | null, speed: number = 1) {
        this.currentText = text;
        this.fullText = text;
        this.fullWords = text.trim().split(/\s+/);
        this.platformSentences = segmentSentences(text);
        this.lastSentenceIndex = -1;
        this.nearEndEmitted = false;
        this.voice = voice;
        this.lastRangeEnd = 0;
        this.startTime = performance.now();
        this.setState('loading');
        await this.bindPlatformEvents();
        try {
            await invoke("tts_speak", { text, voice: voice || "" });
            if (text !== this.currentText) return;
            this.setState('playing');

            if (this.platformSentences.length > 0) {
                this.lastSentenceIndex = 0;
                this.callbacks.onSentenceChange?.(this.platformSentences[0], this.platformSentences.length);
            }

            if (!isAndroid()) {
                // Desktop OS voices report no events; simulate progress with speed setting.
                const safeSpeed = speed > 0 ? speed : 1;
                const charsPerSec = BASE_CHARS_PER_SEC * safeSpeed;
                const estimatedMs = Math.max(2000, (text.length / charsPerSec) * 1000);

                this.startPlatformFallbackTimer(charsPerSec);

                this.completeTimer = setTimeout(() => {
                    this.completeTimer = null;
                    this._onDone();
                }, estimatedMs);
            }
        } catch (err: unknown) {
            this._onError(err instanceof Error ? err.message : String(err));
        }
    }

    /** One-time listeners for the Android plugin's utterance events. */
    private async bindPlatformEvents() {
        if (this.platformEventsBound || !isTauri()) return;
        this.platformEventsBound = true;
        await listen("tts-utterance-done", () => {
            if (this._state === 'playing' && !this.nativeSession) this._onDone();
        });
        await listen("tts-utterance-error", () => {
            if (!this.nativeSession && (this._state === 'playing' || this._state === 'loading')) {
                this._onError("Speech engine error");
            }
        });
        await listen<{ id?: string; start: number; end: number }>("tts-utterance-range", (event) => {
            this.lastRangeEnd = event.payload.end;
            this.handlePlatformRange(event.payload.start, event.payload.end);
        });
    }

    private handlePlatformRange(start: number, _end: number) {
        if (!this.platformSentences || this.platformSentences.length === 0) return;
        let foundIdx = -1;
        for (let i = 0; i < this.platformSentences.length; i++) {
            const s = this.platformSentences[i];
            if (start >= s.startChar && start < s.endChar) {
                foundIdx = i;
                break;
            }
        }
        if (foundIdx === -1) {
            for (let i = this.platformSentences.length - 1; i >= 0; i--) {
                if (start >= this.platformSentences[i].startChar) {
                    foundIdx = i;
                    break;
                }
            }
        }
        if (foundIdx !== -1 && foundIdx !== this.lastSentenceIndex && foundIdx < this.platformSentences.length) {
            this.lastSentenceIndex = foundIdx;
            this.callbacks.onSentenceChange?.(this.platformSentences[foundIdx], this.platformSentences.length);
            if (!this.nearEndEmitted && foundIdx >= this.platformSentences.length - 1) {
                this.nearEndEmitted = true;
                this.callbacks.onNearEnd?.();
            }
        }
    }

    private startPlatformFallbackTimer(charsPerSec: number) {
        this.stopPlatformFallbackTimer();
        this.platformFallbackTimer = setInterval(() => {
            if (this._state !== 'playing' || this.nativeSession || isAndroid()) {
                this.stopPlatformFallbackTimer();
                return;
            }
            const elapsedSec = (performance.now() - this.startTime) / 1000;
            const charsSpoken = elapsedSec * charsPerSec;
            let foundIdx = 0;
            for (let i = 0; i < this.platformSentences.length; i++) {
                if (charsSpoken >= this.platformSentences[i].startChar) {
                    foundIdx = i;
                }
            }
            if (foundIdx !== this.lastSentenceIndex && foundIdx < this.platformSentences.length) {
                this.lastSentenceIndex = foundIdx;
                this.callbacks.onSentenceChange?.(this.platformSentences[foundIdx], this.platformSentences.length);
                if (!this.nearEndEmitted && foundIdx >= this.platformSentences.length - 1) {
                    this.nearEndEmitted = true;
                    this.callbacks.onNearEnd?.();
                }
            }
        }, 120);
    }

    private stopPlatformFallbackTimer() {
        if (this.platformFallbackTimer) {
            clearInterval(this.platformFallbackTimer);
            this.platformFallbackTimer = null;
        }
    }

    // ── Transport ────────────────────────────────────────────────────────────

    async pause() {
        if (this._state !== 'playing') return;
        if (this.nativeSession) {
            await invoke("tts_audio_pause").catch(e => console.error("[catch]", e));
            if (import.meta.env.DEV) {
                console.debug("[tts] paused at", this.lastPosSec.toFixed(1), "s");
            }
            this.stopProgressTimer();
            this.setState('paused');
            return;
        }

        if (this.completeTimer) { clearTimeout(this.completeTimer); this.completeTimer = null; }
        await invoke("tts_stop").catch(e => console.error("[catch]", e));

        // Resume from the last real word boundary when the engine reports
        // ranges (Android), otherwise estimate from elapsed time.
        let wordsToDrop = 0;
        if (isAndroid() && this.lastRangeEnd > 0) {
            const spoken = this.fullText.slice(0, this.lastRangeEnd).trim();
            wordsToDrop = spoken ? spoken.split(/\s+/).length : 0;
        } else {
            const elapsedSec = (performance.now() - this.startTime) / 1000;
            const charsSpoken = Math.floor(elapsedSec * BASE_CHARS_PER_SEC);
            let charCount = 0;
            for (let i = 0; i < this.fullWords.length; i++) {
                charCount += this.fullWords[i].length;
                if (charCount >= charsSpoken) { wordsToDrop = i + 1; break; }
            }
        }
        this.fullText = this.fullWords.slice(wordsToDrop).join(" ");
        this.fullWords = this.fullWords.slice(wordsToDrop);
        this.startTime = performance.now();
        this.setState('paused');
    }

    async resume() {
        if (this._state !== 'paused' || !isTauri()) return;
        if (this.nativeSession) {
            await invoke("tts_audio_resume").catch(e => console.error("[catch]", e));
            this.startProgressTimer();
            this.setState('playing');
            return;
        }
        const remaining = this.fullText.trim();
        if (!remaining) { this._onDone(); return; }
        await this.speakPlatform(remaining, this.voice);
    }

    async stop() {
        this._clearAll();
        if (isTauri()) await invoke("tts_stop").catch(e => console.error("[catch]", e));
        this.setState('idle');
        this.scheduleEngineUnload();
    }

    /** Fire-and-forget synthesis of the next page's first chunk so it plays back instantly. */
    async prefetch(text: string, opts: SpeakOptions = {}) {
        if (!isTauri() || !text.trim()) return;
        const neural = await getNeuralStatus();
        if (!neural.available) return;
        const normalized = normalizeTextForAudio(text.trim());
        const voice = resolveNeuralVoice(opts.voice);
        const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
        const lang = opts.lang || "en";
        try {
            const chunks = await invoke<string[]>("tts_text_chunks", { text: normalized, lang });
            if (chunks.length > 0) {
                await invoke("tts_prefetch", { text: chunks[0], voice, speed, lang });
            }
        } catch { /* prefetch is best-effort */ }
    }

    private _clearAll() {
        this.currentText = '';
        if (this.nativeSession) {
            invoke("tts_audio_stop").catch(() => { /* already stopped */ });
        }
        this.nativeSession = false;
        this.streamDone = false;
        this.stopProgressTimer();
        this.stopPlatformFallbackTimer();
        this.durationSec = 0;
        this.lastPosSec = 0;
        this.activeChunks = [];
        this.lastChunkIndex = -1;
        this.platformSentences = [];
        this.lastSentenceIndex = -1;
        this.nearEndEmitted = false;
        if (this.completeTimer) { clearTimeout(this.completeTimer); this.completeTimer = null; }
        this.fullText = ''; this.fullWords = []; this.voice = null; this.lastRangeEnd = 0;
        this.callbacks.onSentenceChange?.(null, 0);
    }

    private _onDone() {
        this._clearAll();
        this.setState('idle');
        this.callbacks.onComplete?.();
        this.scheduleEngineUnload();
    }

    private _onError(msg: string) {
        this._clearAll();
        this.setState('idle');
        this.callbacks.onError?.(msg);
        this.scheduleEngineUnload();
    }

    static async getVoices(): Promise<{ name: string; lang: string }[]> {
        if (isAndroid()) {
            try {
                const v = await invoke<Array<{ name: string; locale: string }>>("tts_get_voices");
                if (v.length > 0) return v.map(x => ({ name: x.name, lang: x.locale }));
            } catch {  }
        }
        if (typeof window !== "undefined" && window.speechSynthesis) {
            const voices = window.speechSynthesis.getVoices();
            if (voices.length > 0) return voices.map(v => ({ name: v.name, lang: v.lang }));
        }
        return [];
    }

    static async loadVoices(): Promise<{ name: string; lang: string }[]> {
        return ImmersionPlayer.getVoices();
    }

    destroy() {
        this._clearAll();
        this.cancelEngineUnload();
        if (isTauri()) {
            invoke("tts_stop").catch(e => console.error("[catch]", e));
            invoke("tts_engine_unload").catch(e => console.error("[catch]", e));
        }
        this.callbacks = {};
    }
}

export const immersionPlayer = new ImmersionPlayer();
