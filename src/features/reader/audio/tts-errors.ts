import { toast } from "sonner";

/** Which narration path failed: the desktop neural voice or the platform (OS / Android engine) voice. */
export type TtsEngine = "neural" | "platform";

export interface TtsErrorInfo {
    title: string;
    description: string;
}

const MAX_DETAIL = 160;

function detail(message: string): string {
    const clean = message.replace(/\s+/g, " ").trim();
    return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL - 1)}…` : clean;
}

/** Turn a raw narration error into a plain explanation for the listener. */
export function describeTtsError(message: string, engine: TtsEngine): TtsErrorInfo {
    const m = (message || "").toLowerCase();
    if (m.includes("no audio output device")) {
        return {
            title: "No audio output",
            description: "No speaker or headphones were found to play narration. Connect one and press Play again.",
        };
    }
    if (engine === "neural") {
        if (/not downloaded|model file missing|cannot read|voice style|invalid tts\.json|unicode_indexer|failed to load/.test(m)) {
            return {
                title: "The neural voice is not fully installed",
                description: "Some of its files are missing or damaged. Reinstall it in Settings → General → Neural Voice, or use the system voice for now.",
            };
        }
        const why = detail(message);
        return {
            title: "The neural voice could not read this page",
            description: `${why ? `${why}. ` : ""}You can continue with the system voice.`,
        };
    }
    if (/spd-say|speech-dispatcher|no such file|os error 2|not found|cannot find|is not recognized/.test(m)) {
        return {
            title: "No system voice is installed",
            description: "Reading aloud uses your system's speech engine and none was found. On Linux install speech-dispatcher (the spd-say command); on Android install a text-to-speech engine in system settings.",
        };
    }
    if (/speech engine|tts speak failed|tts not available|initiali[sz]e tts engine|failed to speak/.test(m)) {
        return {
            title: "The speech engine stopped",
            description: "Your device's text-to-speech engine did not read the page. Check it in system settings (Text-to-speech output), or choose another engine in Settings → General.",
        };
    }
    return {
        title: "Narration stopped",
        description: detail(message) || "The voice could not read this page.",
    };
}

/** Show a narration error. A neural failure offers to read the page with the system voice instead. */
export function showTtsError(message: string, engine: TtsEngine, retryWithSystemVoice?: () => void): void {
    const { title, description } = describeTtsError(message, engine);
    toast.error(title, {
        description,
        duration: 10_000,
        action: engine === "neural" && retryWithSystemVoice
            ? { label: "Use system voice", onClick: retryWithSystemVoice }
            : undefined,
    });
}
