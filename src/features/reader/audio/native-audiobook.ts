import { invoke } from "@tauri-apps/api/core";

/** The controls used by the audiobook bar, shared by HTML and native audio. */
export interface AudiobookAudio extends EventTarget {
    preload: string;
    src: string;
    currentTime: number;
    duration: number;
    playbackRate: number;
    readonly paused: boolean;
    readonly error: { readonly code: number } | null;
    play(): Promise<void>;
    pause(): void;
}

interface Snapshot {
    ready: boolean;
    playing: boolean;
    finished: boolean;
    position: number;
    duration: number;
}

const POLL_MS = 250;

/** Linux playback is native because WebKitGTK cannot play Tauri asset URLs. */
export class NativeAudiobookAudio extends EventTarget implements AudiobookAudio {
    preload = "";
    duration = Number.NaN;
    error: { code: number } | null = null;
    paused = true;
    private path: string;
    private readonly commandPrefix: "linux_audiobook" | "opus_audiobook";
    private id: number | null = null;
    private readonly onPageHide = () => {
        if (this.id !== null) {
            const id = this.id;
            this.id = null;
            void invoke(`${this.commandPrefix}_close`, { id }).catch(() => undefined);
        }
    };
    private position = 0;
    private positionRevision = 0;
    private rate = 1;
    private metadataReady = false;
    private ended = false;
    private disposed = false;
    private wantsPlayback = false;
    private playbackRevision = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private queue: Promise<void> = Promise.resolve();
    private readyResolve!: () => void;
    private readyReject!: (error: Error) => void;
    private ready = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
    });

    constructor(path: string, commandPrefix: "linux_audiobook" | "opus_audiobook" = "linux_audiobook") {
        super();
        this.path = path;
        this.commandPrefix = commandPrefix;
        if (typeof window !== "undefined") {
            window.addEventListener("pagehide", this.onPageHide);
        }
        // The player may fail before a play request is made.
        void this.ready.catch(() => undefined);
        void invoke<number>(`${this.commandPrefix}_open`, { path }).then(async id => {
            if (this.disposed) {
                await invoke(`${this.commandPrefix}_close`, { id });
                return;
            }
            this.id = id;
            this.schedulePoll(0);
        }).catch(() => this.fail());
    }

    get src(): string { return this.path; }
    set src(value: string) {
        this.path = value;
        if (value !== "" || this.disposed) return;
        this.disposed = true;
        if (typeof window !== "undefined") {
            window.removeEventListener("pagehide", this.onPageHide);
        }
        this.wantsPlayback = false;
        this.playbackRevision += 1;
        if (this.timer !== null) clearTimeout(this.timer);
        this.readyReject(new Error("Audiobook player closed"));
        const id = this.id;
        this.id = null;
        if (id !== null) void this.enqueue(() => invoke(`${this.commandPrefix}_close`, { id })).catch(() => undefined);
    }

    get currentTime(): number { return this.position; }
    set currentTime(seconds: number) {
        if (!Number.isFinite(seconds) || seconds < 0 || this.disposed) return;
        this.position = seconds;
        this.positionRevision += 1;
        if (!this.metadataReady || this.id === null) return;
        const id = this.id;
        void this.enqueue(() => invoke(`${this.commandPrefix}_seek`, { id, seconds }))
            .then(() => { if (!this.disposed) this.dispatchEvent(new Event("seeked")); })
            .catch(() => this.fail());
    }

    get playbackRate(): number { return this.rate; }
    set playbackRate(rate: number) {
        if (!Number.isFinite(rate) || rate <= 0 || this.disposed) return;
        this.rate = rate;
        if (!this.metadataReady || this.id === null) return;
        const id = this.id;
        void this.enqueue(() => invoke(`${this.commandPrefix}_set_rate`, { id, rate }))
            .then(() => { if (!this.disposed) this.dispatchEvent(new Event("ratechange")); })
            .catch(() => this.fail());
    }

    async play(): Promise<void> {
        this.wantsPlayback = true;
        const revision = ++this.playbackRevision;
        await this.ready;
        if (this.disposed || this.id === null) throw new Error("Audiobook player closed");
        if (!this.wantsPlayback || revision !== this.playbackRevision) return;
        const id = this.id;
        try {
            await this.enqueue(() => invoke(`${this.commandPrefix}_play`, { id }));
            if (this.disposed || !this.wantsPlayback || revision !== this.playbackRevision) return;
            this.ended = false;
            this.paused = false;
            this.dispatchEvent(new Event("play"));
        } catch (error) {
            this.fail();
            throw error;
        }
    }

    pause(): void {
        if (this.disposed) return;
        const wasRequested = this.wantsPlayback || !this.paused;
        this.wantsPlayback = false;
        const revision = ++this.playbackRevision;
        if (this.id === null || !wasRequested) return;
        this.paused = true;
        const id = this.id;
        void this.enqueue(() => invoke(`${this.commandPrefix}_pause`, { id }))
            .then(() => { if (!this.disposed && revision === this.playbackRevision) this.dispatchEvent(new Event("pause")); })
            .catch(() => this.fail());
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private schedulePoll(delay: number): void {
        if (this.disposed || this.error) return;
        this.timer = setTimeout(() => { void this.poll(); }, delay);
    }

    private async poll(): Promise<void> {
        if (this.disposed || this.id === null) return;
        const id = this.id;
        try {
            const revision = this.positionRevision;
            const playbackRevision = this.playbackRevision;
            const status = await this.enqueue(() => invoke<Snapshot>(`${this.commandPrefix}_snapshot`, { id }));
            if (this.disposed) return;
            if (revision === this.positionRevision) this.position = status.position;
            if (status.ready && !this.metadataReady) {
                this.duration = status.duration;
                this.metadataReady = true;
                if (this.rate !== 1) await this.enqueue(() => invoke(`${this.commandPrefix}_set_rate`, { id, rate: this.rate }));
                if (this.disposed) return;
                this.readyResolve();
                this.dispatchEvent(new Event("loadedmetadata"));
            }
            if (this.metadataReady) this.dispatchEvent(new Event("timeupdate"));
            if (status.finished && !this.ended && playbackRevision === this.playbackRevision) {
                this.ended = true;
                this.paused = true;
                this.wantsPlayback = false;
                this.dispatchEvent(new Event("ended"));
            }
            this.schedulePoll(POLL_MS);
        } catch {
            this.fail();
        }
    }

    private fail(): void {
        if (this.disposed || this.error) return;
        this.error = { code: 4 };
        this.paused = true;
        this.wantsPlayback = false;
        if (this.timer !== null) clearTimeout(this.timer);
        if (typeof window !== "undefined") {
            window.removeEventListener("pagehide", this.onPageHide);
        }
        const id = this.id;
        this.id = null;
        if (id !== null) {
            void this.enqueue(() => invoke(`${this.commandPrefix}_close`, { id })).catch(() => undefined);
        }
        this.readyReject(new Error("Cannot load audiobook"));
        this.dispatchEvent(new Event("error"));
    }
}
