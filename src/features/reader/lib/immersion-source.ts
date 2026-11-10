/**
 * Which audio immersion mode plays for a book. An audiobook the reader attached
 * on purpose comes first, then the book's own synced narration (EPUB 3 Media
 * Overlays), then generated speech. Framework-free so the Svelte reader can
 * reuse it.
 */
export type ImmersionSource = "audiobook" | "book-narration" | "tts";

export function immersionSource({ hasAudiobook, hasMediaOverlay }: { hasAudiobook: boolean; hasMediaOverlay: boolean }): ImmersionSource {
    if (hasAudiobook) return "audiobook";
    if (hasMediaOverlay) return "book-narration";
    return "tts";
}

/**
 * Whether immersion with this source depends on the TTS setting. The book's own
 * narration doesn't, so using it must not change the reader's saved choice.
 * The audiobook path keeps its existing behaviour.
 */
export function immersionUsesTts(source: ImmersionSource): boolean {
    return source !== "book-narration";
}
