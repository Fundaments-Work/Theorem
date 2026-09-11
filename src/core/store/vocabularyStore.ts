import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { theoremPersistStorage } from "../lib/persist-storage";
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
                triggerVaultAutoSync();
                scheduleMutationSync();
                return mergedTerm;
            },

            deleteVocabularyTerm: (termId) => {
                set((state) => ({
                    vocabularyTerms: state.vocabularyTerms.filter((term) => term.id !== termId),
                }));
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
            version: 5,
            storage: createJSONStorage(() => theoremPersistStorage),
            migrate: (persistedState, _version) => {
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

                return {
                    ...persistedWithoutLegacyReviewFields,
                    vocabularyTerms,
                    installedDictionaries,
                    lookupCache,
                    activeDownload: null,
                } as VocabularyStore;
            },
            partialize: (state) => ({
                vocabularyTerms: state.vocabularyTerms,
                installedDictionaries: state.installedDictionaries,
            }),
            onRehydrateStorage: () => (state) => {
                if (!state) {
                    return;
                }

                state.vocabularyTerms = (state.vocabularyTerms || []).map((term) => (
                    normalizeVocabularyTerm(term)
                ));

                state.installedDictionaries = (state.installedDictionaries || []).map((dictionary) => ({
                    ...dictionary,
                    importedAt: toValidDate(dictionary.importedAt, new Date()),
                }));

                state.lookupCache = {};
                state.activeDownload = null;
            },
        },
    ),
);
