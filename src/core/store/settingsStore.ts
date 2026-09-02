import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { applyAppTheme, applyReaderStyles, initReaderStyles } from "../lib/design-tokens";
import { theoremPersistStorage } from "../lib/persist-storage";
import { scheduleMutationSync } from "../lib/sync-orchestrator";
import type {
    AppSettings,
    ReaderSettings,
    ReadingStats,
    TtsSettings,
    VocabularySettings,
} from "../types";

const defaultReaderSettings: ReaderSettings = {
    theme: "light",
    fontFamily: "original",
    fontSize: 18,
    lineHeight: 1.6,
    letterSpacing: 0,
    paragraphSpacing: 1,
    textAlign: "left",
    hyphenation: false,
    margins: 10,
    flow: "paged",
    layout: "auto",
    brightness: 100,
    fullscreen: false,
    pageAnimation: "slide",
    toolbarAutoHide: false,
    autoHideDelay: 5,
    zoom: 100,
    wordSpacing: 0,
    forcePublisherStyles: false,
    prefetchDistance: 1,
    enableAnimations: false,
    virtualScrolling: false,
};

const defaultVocabularySettings: VocabularySettings = {
    vocabularyEnabled: true,
    showPronunciation: true,
    playPronunciationAudio: false,
};

const defaultVaultSettings: AppSettings["vault"] = {
    enabled: false,
    vaultPath: "",
    autoExportHighlights: true,
    highlightsFileName: "theorem-highlights",
    vocabularyFileName: "theorem-vocabulary.md",
};

const defaultDeviceSyncSettings: AppSettings["deviceSync"] = {
    deviceId: "",
    deviceName: "",
    pairedDevices: [],
    syncOnConnect: false,
    autoSyncEnabled: false,
};

const defaultTtsSettings: TtsSettings = {
    enabled: false,
    voice: "af_bella",
    speed: 1.0,
};

const DEFAULT_ACCENT_COLOR = "#000000";

const defaultAppSettings: AppSettings = {
    sidebarCollapsed: false,
    libraryViewMode: "grid",
    librarySortBy: "lastRead",
    librarySortOrder: "desc",
    scanFolders: [],
    cacheSize: 500,
    theme: "system",
    accentColor: DEFAULT_ACCENT_COLOR,
    readerSettings: defaultReaderSettings,
    vocabulary: defaultVocabularySettings,
    tts: defaultTtsSettings,
    vault: defaultVaultSettings,
    deviceSync: defaultDeviceSyncSettings,
    cli: { enabled: false },
    hasCompletedOnboarding: false,
    showDailyHighlight: false,
    speedReadEnabled: false,
    goalNotifications: true,
    dailyReminderTime: "20:00",
    syncNotifications: true,
};

const defaultReadingStats: ReadingStats = {
    totalReadingTime: 0,
    booksCompleted: 0,
    averageReadingSpeed: 200,
    currentStreak: 0,
    longestStreak: 0,
    dailyGoal: 30,
    yearlyBookGoal: 24,
    booksReadThisYear: 0,
    dailyActivity: [],
};

interface SettingsStore {
    settings: AppSettings;
    stats: ReadingStats;
    
    settingsLastModifiedAt: string;

    updateSettings: (updates: Partial<AppSettings>) => void;
    updateReaderSettings: (updates: Partial<ReaderSettings>) => void;
    updateVocabularySettings: (updates: Partial<VocabularySettings>) => void;
    updateTtsSettings: (updates: Partial<TtsSettings>) => void;
    updateStats: (updates: Partial<ReadingStats>) => void;
    resetSettings: () => void;
    resetReaderSettings: () => void;
}

export const useSettingsStore = create<SettingsStore>()(
    persist(
        (set, get) => ({
            settings: defaultAppSettings,
            stats: defaultReadingStats,
            settingsLastModifiedAt: new Date(0).toISOString(),

            updateSettings: (updates) => {
                const needsThemeApply = "theme" in updates || "accentColor" in updates;
                if (needsThemeApply) {
                    const resolved = { ...get().settings, ...updates };
                    applyAppTheme(resolved.theme, resolved.accentColor);
                }

                set((state) => ({
                    settings: { ...state.settings, ...updates },
                    settingsLastModifiedAt: new Date().toISOString(),
                }));
                scheduleMutationSync();
            },

            updateReaderSettings: (updates) => {
                const newSettings = { ...get().settings.readerSettings, ...updates };

                applyReaderStyles(newSettings);

                set((state) => ({
                    settings: {
                        ...state.settings,
                        readerSettings: newSettings,
                    },
                    settingsLastModifiedAt: new Date().toISOString(),
                }));
                scheduleMutationSync();
            },

            updateVocabularySettings: (updates) => {
                set((state) => ({
                    settings: {
                        ...state.settings,
                        vocabulary: {
                            ...state.settings.vocabulary,
                            ...updates,
                        },
                    },
                    settingsLastModifiedAt: new Date().toISOString(),
                }));
                scheduleMutationSync();
            },

            updateTtsSettings: (updates) =>
                set((state) => ({
                    settings: {
                        ...state.settings,
                        tts: {
                            ...state.settings.tts,
                            ...updates,
                        },
                    },
                    settingsLastModifiedAt: new Date().toISOString(),
                })),

            updateStats: (updates) => {
                set((state) => ({
                    stats: { ...state.stats, ...updates },
                }));
                scheduleMutationSync();
            },

            resetSettings: () => {
                set({
                    settings: defaultAppSettings,
                    settingsLastModifiedAt: new Date().toISOString(),
                });
                scheduleMutationSync();
            },

            resetReaderSettings: () => {
                applyReaderStyles(defaultReaderSettings);

                set((state) => ({
                    settings: {
                        ...state.settings,
                        readerSettings: defaultReaderSettings,
                    },
                    settingsLastModifiedAt: new Date().toISOString(),
                }));
                scheduleMutationSync();
            },
        }),
        {
            name: "theorem-settings",
            version: 11,
            storage: createJSONStorage(() => theoremPersistStorage),
            partialize: (state) => ({
                settings: state.settings,
                stats: state.stats,
                settingsLastModifiedAt: state.settingsLastModifiedAt,
            }),
            migrate: (persistedState, version) => {
                const state = (
                    typeof persistedState === "object" && persistedState !== null
                        ? persistedState
                        : {}
                ) as any;

                if (version === 0 || !version) {
                    if (state.settings && state.settings.learning && !state.settings.vocabulary) {
                        state.settings.vocabulary = state.settings.learning;
                        delete state.settings.learning;
                    }

                    if (state.settings && !state.settings.vocabulary) {
                        state.settings.vocabulary = defaultVocabularySettings;
                    }
                }

                if (!version || version < 4) {
                    if (state.settings && !state.settings.tts) {
                        state.settings.tts = defaultTtsSettings;
                    }
                }

                if (version < 5) {
                    if (state.settings?.tts && state.settings.tts.speed === undefined) {
                        state.settings.tts.speed = defaultTtsSettings.speed;
                    }
                }

                if (version < 6) {
                    if (state.settings?.tts && state.settings.tts.enabled === undefined) {
                        state.settings.tts.enabled = defaultTtsSettings.enabled;
                    }
                }

                if (version < 7) {
                    if (state.settings && !state.settings.accentColor) {
                        state.settings.accentColor = DEFAULT_ACCENT_COLOR;
                    }
                }

                if (version < 8) {
                    if (state.settings && state.settings.showDailyHighlight === undefined) {
                        state.settings.showDailyHighlight = true;
                    }
                }

                if (version < 9) {
                    if (state.settings && state.settings.speedReadEnabled === undefined) {
                        state.settings.speedReadEnabled = true;
                    }
                }

                if (version < 10) {
                    if (state.settings) {
                        if (state.settings.goalNotifications === undefined) {
                            state.settings.goalNotifications = true;
                        }
                        if (state.settings.dailyReminderTime === undefined) {
                            state.settings.dailyReminderTime = "20:00";
                        }
                        if (state.settings.syncNotifications === undefined) {
                            state.settings.syncNotifications = true;
                        }
                    }
                }

                if (version < 11) {
                    if (state.settings && state.settings.cli === undefined) {
                        state.settings.cli = { enabled: false };
                    }
                }

                if (!state.settings) {
                    state.settings = {
                        ...defaultAppSettings,
                        readerSettings: { ...defaultReaderSettings },
                        vocabulary: { ...defaultVocabularySettings },
                        tts: { ...defaultTtsSettings },
                        vault: { ...defaultVaultSettings },
                    };
                } else {
                    state.settings = {
                        ...defaultAppSettings,
                        ...state.settings,
                        readerSettings: {
                            ...defaultReaderSettings,
                            ...(state.settings.readerSettings || {}),
                        },
                        vocabulary: {
                            ...defaultVocabularySettings,
                            ...(state.settings.vocabulary || {}),
                        },
                        tts: {
                            ...defaultTtsSettings,
                            ...(state.settings.tts || {}),
                        },
                        vault: {
                            ...defaultVaultSettings,
                            ...(state.settings.vault || {}),
                        },
                        deviceSync: {
                            ...defaultDeviceSyncSettings,
                            ...(state.settings.deviceSync || {}),
                        },
                    };
                }

                if (!state.stats) {
                    state.stats = {
                        ...defaultReadingStats,
                        dailyActivity: [...defaultReadingStats.dailyActivity],
                    };
                } else if (!Array.isArray(state.stats.dailyActivity)) {
                    state.stats.dailyActivity = [];
                }

                if (!state.settingsLastModifiedAt) {
                    state.settingsLastModifiedAt = new Date(0).toISOString();
                }

                return state;
            },
            onRehydrateStorage: () => (state) => {
                if (state?.settings) {
                    if (state.settings.readerSettings) {
                        initReaderStyles(state.settings.readerSettings);
                    }
                    applyAppTheme(state.settings.theme, state.settings.accentColor);
                }

                if (state && !state.settings.vocabulary) {
                    state.settings.vocabulary = defaultVocabularySettings;
                } else if (state?.settings.vocabulary) {
                    state.settings.vocabulary = {
                        ...defaultVocabularySettings,
                        ...state.settings.vocabulary,
                    };
                }

                if (state && !state.settings.tts) {
                    state.settings.tts = defaultTtsSettings;
                } else if (state?.settings.tts) {
                    state.settings.tts = {
                        ...defaultTtsSettings,
                        ...state.settings.tts,
                    };
                }

                if (state && !state.settings.vault) {
                    state.settings.vault = defaultVaultSettings;
                } else if (state?.settings.vault) {
                    state.settings.vault = {
                        ...defaultVaultSettings,
                        ...state.settings.vault,
                    };
                }

                if (state && !state.settings.deviceSync) {
                    state.settings.deviceSync = defaultDeviceSyncSettings;
                } else if (state?.settings.deviceSync) {
                    state.settings.deviceSync = {
                        ...defaultDeviceSyncSettings,
                        ...state.settings.deviceSync,
                    };
                }

                if (state && !state.stats.dailyActivity) {
                    state.stats.dailyActivity = [];
                }

                if (state?.stats?.dailyActivity && state.stats.dailyActivity.length > 0) {
                    const cutoff = new Date();
                    cutoff.setDate(cutoff.getDate() - 365);
                    const cutoffStr = cutoff.toISOString().split('T')[0];
                    state.stats.dailyActivity = state.stats.dailyActivity.filter(
                        (d: { date: string }) => d.date >= cutoffStr,
                    );
                }
            },
        }
    )
);
