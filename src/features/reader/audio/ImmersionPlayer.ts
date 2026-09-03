
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

export interface PlaybackCallbacks {
    onStateChange?: (state: PlaybackState) => void;
    /** Real playback position, reported while the neural buffer plays. */
    onProgress?: (elapsedSec: number, durationSec: number) => void;
    onError?: (message: string) => void;
    onComplete?: () => void;
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

    // ── Neural session (desktop Supertonic, real audio) ─────────────────────
    private audioCtx: AudioContext | null = null;
    private source: AudioBufferSourceNode | null = null;
    private buffer: AudioBuffer | null = null;
    private offsetSec = 0;
    private startedAt = 0;
    private progressTimer: ReturnType<typeof setInterval> | null = null;
    private currentText = '';

    // ── Platform session (Android engine app / desktop OS voice) ────────────
    private voice: string | null = null;
    private fullText = '';
    private fullWords: string[] = [];
    private lastRangeEnd = 0;
    private startTime = 0;
    private completeTimer: ReturnType<typeof setTimeout> | null = null;
    private platformEventsBound = false;

    get state(): PlaybackState { return this._state; }

    private setState(s: PlaybackState) {
        if (this._state === s) return;
        this._state = s;
        this.callbacks.onStateChange?.(s);
    }

    init(callbacks: PlaybackCallbacks = {}) { this.callbacks = callbacks; }

    /** Create the AudioContext and resume it synchronously. Must be called
     *  directly from a user-gesture handler (click) — WebKit only allows
     *  audio to start from a gesture call stack, and by the time synthesis
     *  finishes the gesture is long gone. */
    unlockAudio() {
        if (!isTauri()) return;
        const ctx = this.ensureAudioContext();
        if (ctx.state === 'suspended') {
            void ctx.resume().catch(() => { /* retried in startSource */ });
        }
    }

    async speak(text: string, opts: SpeakOptions = {}) {
        this._clearAll();
        if (!text.trim() || !isTauri()) return;

        this.currentText = text;
        const neural = await getNeuralStatus();
        // Superseded by a newer speak()/stop() while awaiting the status probe.
        if (text !== this.currentText) return;
        if (neural.available) {
            await this.speakNeural(text, opts);
        } else {
            await this.speakPlatform(text, opts.voice ?? null);
        }
    }

    // ── Neural: synthesize to WAV, decode, play real audio ──────────────────

    private async speakNeural(text: string, opts: SpeakOptions) {
        const voice = resolveNeuralVoice(opts.voice);
        const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
        const lang = opts.lang || "en";
        this.setState('loading');
        try {
            const result = await invoke<{ path: string; duration_sec: number; cached: boolean }>(
                "tts_synthesize", { text, voice, speed, lang },
            );
            const resp = await fetch(convertFileSrc(result.path));
            const bytes = await resp.arrayBuffer();
            const ctx = this.ensureAudioContext();
            const buffer = await ctx.decodeAudioData(bytes);
            if (text !== this.currentText || this._state !== 'loading') return;
            this.buffer = buffer;
            this.offsetSec = 0;
            this.startSource();
        } catch (err: unknown) {
            this._onError(err instanceof Error ? err.message : String(err));
        }
    }

    private ensureAudioContext(): AudioContext {
        if (!this.audioCtx) this.audioCtx = new AudioContext();
        if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
        return this.audioCtx;
    }

    private startSource() {
        const ctx = this.audioCtx;
        const buffer = this.buffer;
        if (!ctx || !buffer) return;
        this.stopSource();
        if (ctx.state === 'suspended') {
            // Unlock was missed (no gesture reached unlockAudio) — retry, but
            // a suspended context would play silence with a frozen clock.
            void ctx.resume().catch(() => {});
            if (import.meta.env.DEV) {
                console.warn("[tts] AudioContext still suspended at playback start");
            }
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => {
            if (this.source === source) {
                this.source = null;
                this._onDone();
            }
        };
        this.source = source;
        this.startedAt = ctx.currentTime;
        source.start(0, this.offsetSec);
        this.startProgressTimer();
        this.setState('playing');
    }

    private stopSource() {
        if (this.source) {
            const s = this.source;
            this.source = null;
            s.onended = null;
            try { s.stop(); } catch { /* already stopped */ }
            s.disconnect();
        }
        this.stopProgressTimer();
    }

    private currentPosition(): number {
        if (!this.audioCtx || !this.buffer) return this.offsetSec;
        if (this._state !== 'playing') return this.offsetSec;
        return Math.min(this.offsetSec + this.audioCtx.currentTime - this.startedAt, this.buffer.duration);
    }

    private startProgressTimer() {
        this.stopProgressTimer();
        this.progressTimer = setInterval(() => {
            if (this._state === 'playing' && this.buffer) {
                this.callbacks.onProgress?.(this.currentPosition(), this.buffer.duration);
            }
        }, 250);
    }

    private stopProgressTimer() {
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }

    /** Real seek over the neural buffer (seconds from the start of the page). */
    seek(seconds: number) {
        if (!this.buffer) return;
        const target = Math.max(0, Math.min(seconds, this.buffer.duration - 0.05));
        if (this._state === 'playing') {
            this.offsetSec = target;
            this.startSource();
        } else if (this._state === 'paused') {
            this.offsetSec = target;
            this.callbacks.onProgress?.(target, this.buffer.duration);
        }
    }

    // ── Platform: OS/engine voice with estimated or event-driven timing ─────

    private async speakPlatform(text: string, voice: string | null) {
        this.currentText = text;
        this.fullText = text;
        this.fullWords = text.trim().split(/\s+/);
        this.voice = voice;
        this.lastRangeEnd = 0;
        this.startTime = performance.now();
        this.setState('loading');
        await this.bindPlatformEvents();
        try {
            await invoke("tts_speak", { text, voice: voice || "" });
            if (text !== this.currentText) return;
            this.setState('playing');
            if (!isAndroid()) {
                // Android completion arrives via tts-utterance-done; desktop OS
                // voices report nothing, so keep the duration estimate there.
                const estimatedMs = Math.max(2000, (text.length / BASE_CHARS_PER_SEC) * 1000);
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
            if (this._state === 'playing' && !this.buffer) this._onDone();
        });
        await listen("tts-utterance-error", () => {
            if (!this.buffer && (this._state === 'playing' || this._state === 'loading')) {
                this._onError("Speech engine error");
            }
        });
        await listen<{ end: number }>("tts-utterance-range", (event) => {
            this.lastRangeEnd = event.payload.end;
        });
    }

    // ── Transport ────────────────────────────────────────────────────────────

    async pause() {
        if (this._state !== 'playing') return;
        if (this.buffer) {
            const pos = this.currentPosition();
            this.stopSource();
            this.offsetSec = pos;
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
        if (this.buffer) { this.startSource(); return; }
        const remaining = this.fullText.trim();
        if (!remaining) { this._onDone(); return; }
        await this.speakPlatform(remaining, this.voice);
    }

    async stop() {
        this._clearAll();
        if (isTauri()) await invoke("tts_stop").catch(e => console.error("[catch]", e));
        this.setState('idle');
    }

    /** Fire-and-forget synthesis of the next page so it plays back instantly. */
    async prefetch(text: string, opts: SpeakOptions = {}) {
        if (!isTauri() || !text.trim()) return;
        const neural = await getNeuralStatus();
        if (!neural.available) return;
        invoke("tts_prefetch", {
            text,
            voice: resolveNeuralVoice(opts.voice),
            speed: opts.speed && opts.speed > 0 ? opts.speed : 1,
            lang: opts.lang || "en",
        }).catch(() => { /* prefetch is best-effort */ });
    }

    private _clearAll() {
        this.currentText = '';
        this.stopSource();
        this.buffer = null;
        this.offsetSec = 0;
        if (this.completeTimer) { clearTimeout(this.completeTimer); this.completeTimer = null; }
        this.fullText = ''; this.fullWords = []; this.voice = null; this.lastRangeEnd = 0;
    }

    private _onDone() {
        this._clearAll();
        this.setState('idle');
        this.callbacks.onComplete?.();
    }

    private _onError(msg: string) {
        this._clearAll();
        this.setState('idle');
        this.callbacks.onError?.(msg);
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
        if (isTauri()) invoke("tts_stop").catch(e => console.error("[catch]", e));
        this.callbacks = {};
    }
}

export const immersionPlayer = new ImmersionPlayer();
