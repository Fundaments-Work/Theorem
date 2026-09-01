import { isTauri } from "../lib/env";
import type {
    DictionaryProvider,
    VocabularyMeaning,
    VocabularyTerm,
} from "../types";
import { lookupInStarDictDictionaries } from "./StarDictService";

const FREE_DICTIONARY_API_BASE = "https://api.dictionaryapi.dev/api/v2/entries/en";

export interface DictionaryLookupInput {
    term: string;
    language?: string;
    installedDictionaryIds?: string[];
}

export interface DictionaryLookupResult {
    term: string;
    normalizedTerm: string;
    language: string;
    phonetic?: string;
    audioUrl?: string;
    meanings: VocabularyMeaning[];
    providersUsed: DictionaryProvider[];
}

interface FreeDictPhonetic {
    text?: string;
    audio?: string;
}

interface FreeDictDefinition {
    definition: string;
    example?: string;
    synonyms?: string[];
    antonyms?: string[];
}

interface FreeDictMeaning {
    partOfSpeech: string;
    definitions: FreeDictDefinition[];
}

interface FreeDictEntry {
    word: string;
    phonetic?: string;
    phonetics?: FreeDictPhonetic[];
    origin?: string;
    meanings: FreeDictMeaning[];
}

function dedupeDefinitions(meanings: VocabularyMeaning[]): VocabularyMeaning[] {
    return meanings.map((meaning) => ({
        ...meaning,
        definitions: Array.from(new Set(meaning.definitions.map((item) => item.trim()).filter(Boolean))),
        examples: meaning.examples
            ? Array.from(new Set(meaning.examples.map((item) => item.trim()).filter(Boolean)))
            : undefined,
        synonyms: meaning.synonyms
            ? Array.from(new Set(meaning.synonyms.map((item) => item.trim()).filter(Boolean)))
            : undefined,
        antonyms: meaning.antonyms
            ? Array.from(new Set(meaning.antonyms.map((item) => item.trim()).filter(Boolean)))
            : undefined,
    }));
}

export function normalizeLookupTerm(term: string): string {
    return term
        .trim()
        .toLowerCase()
        .replace(/^[\s"'""'`.,!?;:()\[\]{}]+|[\s"'""'`.,!?;:()\[\]{}]+$/g, "")
        .replace(/\s+/g, " ");
}

function toVocabularyTerm(result: DictionaryLookupResult): VocabularyTerm {
    const now = new Date();
    return {
        id: crypto.randomUUID(),
        term: result.term,
        normalizedTerm: result.normalizedTerm,
        language: result.language,
        phonetic: result.phonetic,
        audioUrl: result.audioUrl,
        meanings: result.meanings,
        providerHistory: result.providersUsed,
        createdAt: now,
        updatedAt: now,
    };
}

async function lookupWithStarDict(
    term: string,
    dictionaryIds: string[],
): Promise<{ meanings: VocabularyMeaning[] } | null> {
    if (dictionaryIds.length === 0) return null;
    const meanings = await lookupInStarDictDictionaries(dictionaryIds, term);
    if (meanings.length === 0) return null;
    return { meanings };
}

async function lookupWithFreeDictionaryApi(
    term: string,
): Promise<{ meanings: VocabularyMeaning[]; phonetic?: string; audioUrl?: string } | null> {
    try {
        let entries: FreeDictEntry[] | null = null;

        if (isTauri()) {
            try {
                const { invoke } = await import("@tauri-apps/api/core");
                entries = await invoke<FreeDictEntry[]>("fetch_online_definition", { term });
            } catch {
                return null;
            }
        } else {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500);
            try {
                const response = await fetch(`${FREE_DICTIONARY_API_BASE}/${encodeURIComponent(term)}`, {
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);
                if (!response.ok) return null;
                entries = await response.json();
            } catch {
                clearTimeout(timeoutId);
                return null;
            }
        }

        if (!entries || !Array.isArray(entries) || entries.length === 0) return null;

        const entry = entries[0];
        const meanings: VocabularyMeaning[] = [];

        for (const m of entry.meanings || []) {
            const definitions: string[] = [];
            const examples: string[] = [];
            const synonyms: string[] = [];
            const antonyms: string[] = [];

            for (const d of m.definitions || []) {
                if (d.definition) definitions.push(d.definition);
                if (d.example) examples.push(d.example);
                if (d.synonyms) synonyms.push(...d.synonyms);
                if (d.antonyms) antonyms.push(...d.antonyms);
            }

            if (definitions.length > 0) {
                meanings.push({
                    partOfSpeech: m.partOfSpeech || "General",
                    definitions,
                    examples: examples.length > 0 ? examples : undefined,
                    synonyms: synonyms.length > 0 ? synonyms : undefined,
                    antonyms: antonyms.length > 0 ? antonyms : undefined,
                    provider: "free-dictionary-api",
                });
            }
        }

        const phonetic = entry.phonetics?.find((p) => p.text)?.text || entry.phonetic;
        const audioUrl = entry.phonetics?.find((p) => p.audio)?.audio || undefined;

        return {
            meanings,
            phonetic,
            audioUrl: audioUrl ? (audioUrl.startsWith("//") ? `https:${audioUrl}` : audioUrl) : undefined,
        };
    } catch {
        return null;
    }
}

export async function lookupDictionaryTerm(
    input: DictionaryLookupInput,
): Promise<DictionaryLookupResult | null> {
    const normalizedTerm = normalizeLookupTerm(input.term);
    if (!normalizedTerm) return null;

    const language = input.language || "en";
    const installedIds = input.installedDictionaryIds || [];
    const providersUsed: DictionaryProvider[] = [];

    let phonetic: string | undefined;
    let audioUrl: string | undefined;
    let allMeanings: VocabularyMeaning[] = [];

    // Run offline and online lookups in parallel for fastest response
    const [stardictRes, onlineRes] = await Promise.allSettled([
        installedIds.length > 0 ? lookupWithStarDict(normalizedTerm, installedIds) : Promise.resolve(null),
        lookupWithFreeDictionaryApi(normalizedTerm),
    ]);

    if (stardictRes.status === "fulfilled" && stardictRes.value) {
        allMeanings.push(...stardictRes.value.meanings);
        providersUsed.push("stardict");
    }

    if (onlineRes.status === "fulfilled" && onlineRes.value) {
        allMeanings.push(...onlineRes.value.meanings);
        providersUsed.push("free-dictionary-api");
        if (onlineRes.value.phonetic && !phonetic) phonetic = onlineRes.value.phonetic;
        if (onlineRes.value.audioUrl && !audioUrl) audioUrl = onlineRes.value.audioUrl;
    }

    if (allMeanings.length === 0) return null;

    const normalizedMeanings = dedupeDefinitions(allMeanings).filter(
        (item) => item.definitions.length > 0,
    );
    if (normalizedMeanings.length === 0) return null;

    return {
        term: input.term.trim(),
        normalizedTerm,
        language,
        phonetic,
        audioUrl,
        meanings: normalizedMeanings,
        providersUsed,
    };
}

export function vocabularyTermFromLookup(result: DictionaryLookupResult): VocabularyTerm {
    return toVocabularyTerm(result);
}
