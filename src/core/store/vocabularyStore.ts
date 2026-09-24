import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isTauri } from "../lib/env";
import { deferredJsonStorage, memoizePartialize } from "../lib/persist-storage";
import {
    sqliteDeleteVocabularyTerm,
    sqliteGetVocabularyTerms,
    sqliteSaveVocabularyTerm,
    type SqliteVocabularyTerm,
} from "../lib/sqlite-storage";
import {
    lookupDictionaryTerm,
    vocabularyTermFromLookup,
    type DictionaryLookupResult,
} from "../services/DictionaryService";
import {
    importStarDictDictionary,
    removeStarDictDictionary,
} from "../services/StarDictService";
import { scheduleMutationSync } from "../lib/sync-orchestrator";
import { triggerVaultAutoSync } from "../lib/vault-sync";
import type {
    DeletionTombstone,
    InstalledDictionary,
    VocabularyTerm,
} from "../types";
import { useLibraryStore } from "./libraryStore";

export function toSqliteVocabularyTerm(term: VocabularyTerm): SqliteVocabularyTerm {
    return {
        id: term.id,
        term: term.term,
        normalizedTerm: term.normalizedTerm,
        language: term.language,
        phonetic: term.phonetic,
        audioUrl: term.audioUrl,
        meaningsJson: JSON.stringify(term.meanings || []),
        providerHistoryJson: JSON.stringify(term.providerHistory || []),
        sourceBookId: undefined,
        contextSentence: undefined,
        createdAt: term.createdAt instanceof Date ? term.createdAt.getTime() : new Date(term.createdAt).getTime(),
        updatedAt: term.updatedAt
            ? (term.updatedAt instanceof Date ? term.updatedAt.getTime() : new Date(term.updatedAt).getTime())
            : undefined,
    };
}

export function fromSqliteVocabularyTerm(st: SqliteVocabularyTerm): VocabularyTerm {
    let meanings = [];
    try {
        meanings = JSON.parse(st.meaningsJson);
    } catch {
        meanings = [];
    }
    let providerHistory = [];
    try {
        providerHistory = JSON.parse(st.providerHistoryJson);
    } catch {
        providerHistory = [];
    }
    return {
        id: st.id,
        term: st.term,
        normalizedTerm: st.normalizedTerm,
        language: st.language,
        phonetic: st.phonetic || undefined,
        audioUrl: st.audioUrl || undefined,
        meanings: Array.isArray(meanings) ? meanings : [],
        providerHistory: Array.isArray(providerHistory) ? providerHistory : [],
        createdAt: new Date(st.createdAt),
        updatedAt: st.updatedAt ? new Date(st.updatedAt) : undefined,
    };
}

function normalizeTermKey(term: string, language: string): string {
    return `${term.trim().toLowerCase()}::${language.trim().toLowerCase()}`;
}

function toValidDate(value: Date | string | number | undefined, fallback: Date): Date {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }

    if (value !== undefined) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }

    return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function normalizeVocabularyTerm(term: VocabularyTerm): VocabularyTerm {
    const now = new Date();
    const normalized = {
        ...term,
    } as VocabularyTerm & { linkedCardId?: string; lastReviewedAt?: Date | string | number };
    if ("linkedCardId" in normalized) {
        delete normalized.linkedCardId;
    }
    if ("lastReviewedAt" in normalized) {
        delete normalized.lastReviewedAt;
    }
    return {
        ...normalized,
        createdAt: toValidDate(normalized.createdAt, now),
        updatedAt: normalized.updatedAt
            ? toValidDate(normalized.updatedAt, now)
            : undefined,
    };
}

function normalizeVocabularyLookupCache(
    value: unknown,
): Record<string, DictionaryLookupResult> {
    if (!isRecord(value)) {
        return {};
    }

    return value as Record<string, DictionaryLookupResult>;
}

interface VocabularyStore {
    vocabularyTerms: VocabularyTerm[];
    installedDictionaries: InstalledDictionary[];
    lookupCache: Record<string, DictionaryLookupResult>;
    activeDownload: { dictName: string; progress: { percent: number; downloaded: number; total: number } } | null;

    saveVocabularyTerm: (term: VocabularyTerm) => VocabularyTerm;
    deleteVocabularyTerm: (termId: string) => void;
    lookupTerm: (term: string, language?: string) => Promise<DictionaryLookupResult | null>;
    lookupAndSaveTerm: (term: string, language?: string) => Promise<VocabularyTerm | null>;

    importStarDict: (files: FileList | File[]) => Promise<InstalledDictionary>;
    removeDictionary: (dictionaryId: string) => Promise<void>;
    addInstalledDictionary: (dict: InstalledDictionary) => void;
    setActiveDownload: (download: { dictName: string; progress: { percent: number; downloaded: number; total: number } } | null) => void;
    setDownloadProgress: (progress: { percent: number; downloaded: number; total: number }) => void;
}

export const useVocabularyStore = create<VocabularyStore>()(
    persist(
        (set, get) => ({
            vocabularyTerms: [],
            installedDictionaries: [],
            lookupCache: {},
            activeDownload: null,

            saveVocabularyTerm: (incomingTerm) => {
                const now = new Date();
                const incomingCreatedAt = toValidDate(incomingTerm.createdAt, now);
                const incomingUpdatedAt = incomingTerm.updatedAt
                    ? toValidDate(incomingTerm.updatedAt, now)
                    : now;

                const normalizedKey = normalizeTermKey(
                    incomingTerm.normalizedTerm,
                    incomingTerm.language,
                );

                const existing = get().vocabularyTerms.find((term) => (
                    normalizeTermKey(term.normalizedTerm, term.language) === normalizedKey
                ));

                if (!existing) {
                    const termToSave: VocabularyTerm = {
                        ...incomingTerm,
                        createdAt: incomingCreatedAt,
                        updatedAt: incomingUpdatedAt,
                    };
                    set((state) => ({
                        vocabularyTerms: [...state.vocabularyTerms, termToSave],
                    }));
                    if (isTauri()) {
                        void sqliteSaveVocabularyTerm(toSqliteVocabularyTerm(termToSave));
                    }
                    triggerVaultAutoSync();
                    scheduleMutationSync();
                    return termToSave;
                }

                const mergedMeanings = [...existing.meanings];
                const existingSigs = new Set(
                    mergedMeanings.map((candidate) =>
                        `${candidate.provider || ''}::${candidate.partOfSpeech || ''}::${(candidate.definitions || []).join('|')}`,
                    ),
                );
                for (const meaning of incomingTerm.meanings) {
                    const sig = `${meaning.provider || ''}::${meaning.partOfSpeech || ''}::${(meaning.definitions || []).join('|')}`;
                    if (!existingSigs.has(sig)) {
                        existingSigs.add(sig);
                        mergedMeanings.push(meaning);
                    }
                }

                const mergedProviderHistory = Array.from(new Set([
                    ...existing.providerHistory,
                    ...incomingTerm.providerHistory,
                ]));

                const mergedTerm: VocabularyTerm = {
                    ...existing,
                    term: incomingTerm.term || existing.term,
                    normalizedTerm: incomingTerm.normalizedTerm || existing.normalizedTerm,
                    language: incomingTerm.language || existing.language,
                    phonetic: incomingTerm.phonetic || existing.phonetic,
                    audioUrl: incomingTerm.audioUrl || existing.audioUrl,
                    meanings: mergedMeanings,
                    providerHistory: mergedProviderHistory,
                    updatedAt: now,
                };

                set((state) => ({
                    vocabularyTerms: state.vocabularyTerms.map((term) => (
                        term.id === existing.id ? mergedTerm : term
                    )),
                }));
                if (isTauri()) {
                    void sqliteSaveVocabularyTerm(toSqliteVocabularyTerm(mergedTerm));
                }
                triggerVaultAutoSync();
                scheduleMutationSync();
                return mergedTerm;
            },

            deleteVocabularyTerm: (termId) => {
                set((state) => ({
                    vocabularyTerms: state.vocabularyTerms.filter((term) => term.id !== termId),
                }));
                if (isTauri()) {
                    void sqliteDeleteVocabularyTerm(termId);
                }
                const tombstone: DeletionTombstone = {
                    entityId: termId,
                    entityType: "vocabulary",
                    deletedAt: new Date().toISOString(),
                };
                useLibraryStore.setState((s) => ({
                    deletionTombstones: [...s.deletionTombstones, tombstone],
                }));
                triggerVaultAutoSync();
                scheduleMutationSync();
            },

            lookupTerm: async (term, language = "en") => {
                const normalizedQuery = term.trim().toLowerCase();
                if (!normalizedQuery) {
                    return null;
                }

                const cacheKey = normalizeTermKey(normalizedQuery, language);
                const cached = get().lookupCache[cacheKey];
                if (cached) {
                    return cached;
                }

                const installedIds = get().installedDictionaries.map((dictionary) => dictionary.id);

                const result = await lookupDictionaryTerm({
                    term,
                    language,
                    installedDictionaryIds: installedIds,
                });

                if (result) {
                    set((state) => {
                        const MAX_CACHE_SIZE = 100;
                        const newCache = { ...state.lookupCache, [cacheKey]: result };
                        const cacheKeys = Object.keys(newCache);

                        if (cacheKeys.length > MAX_CACHE_SIZE) {
                            const keysToRemove = cacheKeys.slice(0, cacheKeys.length - MAX_CACHE_SIZE);
                            keysToRemove.forEach(key => delete newCache[key]);
                        }

                        return { lookupCache: newCache };
                    });
                }

                return result;
            },

            lookupAndSaveTerm: async (term, language = "en") => {
                const result = await get().lookupTerm(term, language);
                if (!result) {
                    return null;
                }

                const vocabularyTerm = vocabularyTermFromLookup(result);
                return get().saveVocabularyTerm(vocabularyTerm);
            },

            importStarDict: async (files) => {
                const dictionary = await importStarDictDictionary(files);
                set((state) => ({
                    installedDictionaries: [dictionary, ...state.installedDictionaries],
                }));
                return dictionary;
            },

            removeDictionary: async (dictionaryId) => {
                await removeStarDictDictionary(dictionaryId);
                set((state) => ({
                    installedDictionaries: state.installedDictionaries.filter(
                        (dictionary) => dictionary.id !== dictionaryId,
                    ),
                }));
            },

            addInstalledDictionary: (dict: InstalledDictionary) => {
                set((state) => ({
                    installedDictionaries: [...state.installedDictionaries, dict],
                }));
            },

            setActiveDownload: (download) => {
                set({ activeDownload: download });
            },

            setDownloadProgress: (progress) => {
                const current = get().activeDownload;
                if (current) {
                    set({ activeDownload: { ...current, progress } });
                }
            },
        }),
        {
            name: "theorem-vocabulary",
            version: 6,
            storage: deferredJsonStorage,
            migrate: (persistedState, version) => {
                const persisted = isRecord(persistedState) ? persistedState : {};
                const {
                    preferredTab: _preferredTab,
                    reviewRecords: _reviewRecords,
                    reviewEvents: _reviewEvents,
                    dailyReminderState: _dailyReminderState,
                    reviewSessionState: _reviewSessionState,
                    ...persistedWithoutLegacyReviewFields
                } = persisted;
                const vocabularyTermsRaw = Array.isArray(persisted.vocabularyTerms)
                    ? persisted.vocabularyTerms
                    : [];
                const vocabularyTerms = vocabularyTermsRaw.map((term) => {
                    if (!isRecord(term)) {
                        return term;
                    }
                    const {
                        linkedCardId: _linkedCardId,
                        lastReviewedAt: _lastReviewedAt,
                        ...rest
                    } = term;
                    return rest;
                });
                const installedDictionaries = Array.isArray(persisted.installedDictionaries)
                    ? persisted.installedDictionaries
                    : [];
                const lookupCache = normalizeVocabularyLookupCache(persisted.lookupCache);

                // When upgrading from < 6 on native platforms, migrate existing vocabulary into SQLite
                if (version < 6 && isTauri() && vocabularyTerms.length > 0) {
                    for (const term of vocabularyTerms) {
                        if (term && typeof term === "object" && "id" in term) {
                            try {
                                const norm = normalizeVocabularyTerm(term as VocabularyTerm);
                                void sqliteSaveVocabularyTerm(toSqliteVocabularyTerm(norm)).catch(() => {});
                            } catch {}
                        }
                    }
                }

                return {
                    ...persistedWithoutLegacyReviewFields,
                    vocabularyTerms: isTauri() ? [] : vocabularyTerms,
                    installedDictionaries,
                    lookupCache,
                    activeDownload: null,
                } as VocabularyStore;
            },
            partialize: memoizePartialize(
                (state) => [isTauri() ? [] : state.vocabularyTerms, state.installedDictionaries],
                (state) => ({
                    vocabularyTerms: isTauri() ? [] : state.vocabularyTerms,
                    installedDictionaries: state.installedDictionaries,
                }),
            ),
            onRehydrateStorage: () => (state) => {
                if (!state) {
                    return;
                }

                state.installedDictionaries = (state.installedDictionaries || []).map((dictionary) => ({
                    ...dictionary,
                    importedAt: toValidDate(dictionary.importedAt, new Date()),
                }));

                state.lookupCache = {};
                state.activeDownload = null;

                if (isTauri()) {
                    void sqliteGetVocabularyTerms().then((sqliteTerms) => {
                        if (sqliteTerms) {
                            useVocabularyStore.setState({
                                vocabularyTerms: sqliteTerms.map(fromSqliteVocabularyTerm),
                            });
                        }
                    }).catch(() => {});
                } else {
                    state.vocabularyTerms = (state.vocabularyTerms || []).map((term) => (
                        normalizeVocabularyTerm(term)
                    ));
                }
            },
        },
    ),
);
