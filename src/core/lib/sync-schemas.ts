
import { z } from "zod";

const highlightColor = z.enum(["yellow", "green", "blue", "red", "orange", "purple"]);

const dateLike = z.union([z.string(), z.date()]).optional();

export const BookSchema = z.object({
    id: z.string().min(1),
    title: z.string(),
    author: z.string(),
    filePath: z.string().optional(),
    storagePath: z.string().optional(),
    format: z.enum(["epub", "mobi", "azw", "azw3", "fb2", "cbz", "cbr", "pdf"]),
    contentHash: z.string().optional(),
    coverPath: z.string().optional(),
    coverExtractionDone: z.boolean().optional(),
    description: z.string().optional(),
    publisher: z.string().optional(),
    publishedDate: z.string().optional(),
    language: z.string().optional(),
    isbn: z.string().optional(),
    fileSize: z.number().finite(),
    addedAt: dateLike,
    lastReadAt: dateLike,
    progress: z.number().min(0).max(1),
    currentLocation: z.string().optional(),
    lastClickFraction: z.number().min(0).max(1).optional(),
    pageProgress: z
        .object({
            currentPage: z.number().int().nonnegative(),
            endPage: z.number().int().nonnegative().optional(),
            totalPages: z.number().int().nonnegative(),
            range: z.string(),
        })
        .optional(),
    pdfViewState: z
        .object({
            page: z.number().int().positive(),
            totalPages: z.number().int().nonnegative(),
            zoom: z.number().positive(),
            zoomMode: z.enum(["custom", "page-fit", "width-fit"]),
            presentationMode: z.enum(["scroll", "paged", "two-page"]).optional(),
        })
        .optional(),
    locations: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()),
    rating: z.number().int().min(1).max(5).optional(),
    isFavorite: z.boolean(),
    manualCompletionState: z.enum(["read", "unread"]).optional(),
    progressBeforeFinish: z.number().min(0).max(1).optional(),
    readingTime: z.number().min(0),
    completedAt: dateLike,
    syncedWithoutFile: z.boolean().optional(),
    blobHash: z.string().optional(),
    coverBlobHash: z.string().optional(),
}).passthrough();

export const BooksArraySchema = z.array(BookSchema);

export const AnnotationSchema = z.object({
    id: z.string().min(1),
    bookId: z.string().min(1),
    referenceId: z.string().optional(),
    type: z.enum(["highlight", "note", "bookmark"]),
    location: z.string(),
    selectedText: z.string().optional(),
    noteContent: z.string().optional(),
    color: highlightColor.optional(),
    createdAt: dateLike,
    updatedAt: dateLike,
    pageNumber: z.number().int().positive().optional(),
    pdfAnnotationType: z.enum(["highlight", "drawing", "textNote"]).optional(),
    drawingData: z.string().optional(),
    textNoteContent: z.string().optional(),
    rect: z
        .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
        })
        .optional(),
    rects: z
        .array(
            z.object({
                x: z.number(),
                y: z.number(),
                width: z.number(),
                height: z.number(),
            }),
        )
        .optional(),
    strokeWidth: z.number().optional(),
}).passthrough();

export const AnnotationsArraySchema = z.array(AnnotationSchema);

export const CollectionSchema = z.object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
    bookIds: z.array(z.string()),
    kind: z.enum(["general"]),
    createdAt: dateLike,
    updatedAt: dateLike,
}).passthrough();

export const CollectionsArraySchema = z.array(CollectionSchema);

export const DeletionTombstoneSchema = z.object({
    entityId: z.string().min(1),
    entityType: z.enum([
        "book",
        "annotation",
        "collection",
        "feed",
        "rss_article",
        "vocabulary",
        "collection_book",
    ]),
    deletedAt: z.string().min(1),
}).passthrough();

export const TombstonesArraySchema = z.array(DeletionTombstoneSchema);

export const VocabularyMeaningSchema = z.object({
    partOfSpeech: z.string().optional(),
    definitions: z.array(z.string()),
    examples: z.array(z.string()).optional(),
    synonyms: z.array(z.string()).optional(),
    antonyms: z.array(z.string()).optional(),
    provider: z.enum(["stardict", "free-dictionary-api"]),
});

export const VocabularyTermSchema = z.object({
    id: z.string().min(1),
    term: z.string(),
    normalizedTerm: z.string(),
    language: z.string(),
    phonetic: z.string().optional(),
    audioUrl: z.string().optional(),
    meanings: z.array(VocabularyMeaningSchema),
    providerHistory: z.array(z.enum(["stardict", "free-dictionary-api"])),
    createdAt: dateLike,
    updatedAt: dateLike,
    lookupCount: z.number().int().nonnegative().optional(),
    tags: z.array(z.string()).optional(),
    contexts: z.array(z.string()).optional(),
}).passthrough();

export const VocabularyTermsArraySchema = z.array(VocabularyTermSchema);

export const RssFeedSchema = z.object({
    id: z.string().min(1),
    title: z.string(),
    url: z.string(),
    siteUrl: z.string().optional(),
    description: z.string().optional(),
    iconUrl: z.string().optional(),
    lastFetched: dateLike,
    addedAt: dateLike,
    errorMessage: z.string().optional(),
    unreadCount: z.number().int().nonnegative(),
}).passthrough();

export const RssFeedsArraySchema = z.array(RssFeedSchema);

export const RssArticleSchema = z.object({
    id: z.string().min(1),
    feedId: z.string().min(1),
    title: z.string(),
    author: z.string().optional(),
    url: z.string(),
    content: z.string(),
    summary: z.string().optional(),
    imageUrl: z.string().optional(),
    publishedAt: dateLike,
    fetchedAt: dateLike,
    isRead: z.boolean(),
    isFavorite: z.boolean(),
}).passthrough();

export const RssArticlesArraySchema = z.array(RssArticleSchema);

const ReaderSettingsSchema = z.object({
    theme: z.enum(["light", "sepia", "dark"]),
    fontFamily: z.enum(["original", "serif", "sans", "mono"]),
    fontSize: z.number().min(12).max(36),
    lineHeight: z.number().min(1).max(2.5),
    letterSpacing: z.number().min(-0.05).max(0.2),
    paragraphSpacing: z.number().min(0).max(2),
    textAlign: z.enum(["left", "justify", "center"]),
    hyphenation: z.boolean(),
    margins: z.number().min(0).max(35),
    flow: z.enum(["paged", "scroll", "auto"]),
    layout: z.enum(["single", "double", "auto"]),
    brightness: z.number().min(0).max(100),
    fullscreen: z.boolean(),
    pageAnimation: z.enum(["slide", "fade", "instant"]),
    toolbarAutoHide: z.boolean(),
    autoHideDelay: z.number(),
    zoom: z.number().min(50).max(200),
    wordSpacing: z.number().min(0).max(0.5),
    forcePublisherStyles: z.boolean(),
    prefetchDistance: z.number().int().min(1).max(3),
    enableAnimations: z.boolean(),
    virtualScrolling: z.boolean(),
});

const VocabularySettingsSchema = z.object({
    vocabularyEnabled: z.boolean(),
    showPronunciation: z.boolean(),
    playPronunciationAudio: z.boolean(),
});

const TtsSettingsSchema = z.object({
    enabled: z.boolean(),
    voice: z.string(),
    speed: z.number(),
});

const VaultSettingsSchema = z.object({
    enabled: z.boolean(),
    vaultPath: z.string(),
    autoExportHighlights: z.boolean(),
    highlightsFileName: z.string(),
    vocabularyFileName: z.string(),
});

const DeviceSyncSettingsSchema = z.object({
    deviceId: z.string(),
    deviceName: z.string(),
    pairedDevices: z.array(
        z.object({
            deviceId: z.string(),
            deviceName: z.string(),
            lastIp: z.string(),
            lastPort: z.number(),
            pairedAt: z.string(),
            lastSyncAt: z.string().optional(),
        }),
    ),
    syncOnConnect: z.boolean(),
    autoSyncEnabled: z.boolean(),
});

export const AppSettingsSchema = z.object({
    sidebarCollapsed: z.boolean(),
    libraryViewMode: z.enum(["grid", "list", "compact"]),
    librarySortBy: z.enum(["title", "author", "dateAdded", "lastRead", "progress", "rating"]),
    librarySortOrder: z.enum(["asc", "desc"]),
    scanFolders: z.array(z.string()),
    cacheSize: z.number(),
    theme: z.enum(["light", "dark", "system"]),
    readerSettings: ReaderSettingsSchema,
    vocabulary: VocabularySettingsSchema,
    tts: TtsSettingsSchema,
    vault: VaultSettingsSchema,
    deviceSync: DeviceSyncSettingsSchema,
    hasCompletedOnboarding: z.boolean(),
    _settingsUpdatedAt: z.string().optional(),
}).passthrough();

const DailyActivitySchema = z.object({
    date: z.string(),
    minutes: z.number().min(0),
    booksRead: z.array(z.string()),
});

export const ReadingStatsSchema = z.object({
    totalReadingTime: z.number().min(0),
    booksCompleted: z.number().int().nonnegative(),
    averageReadingSpeed: z.number().min(0),
    currentStreak: z.number().int().nonnegative(),
    longestStreak: z.number().int().nonnegative(),
    dailyGoal: z.number().int().positive(),
    yearlyBookGoal: z.number().int().positive(),
    booksReadThisYear: z.number().int().nonnegative(),
    dailyActivity: z.array(DailyActivitySchema),
    lastReadDate: z.string().optional(),
}).passthrough();

const DOMAIN_SCHEMAS = {
    books: BooksArraySchema,
    annotations: AnnotationsArraySchema,
    collections: CollectionsArraySchema,
    deletion_tombstones: TombstonesArraySchema,
    vocabulary: VocabularyTermsArraySchema,
    rss_feeds: RssFeedsArraySchema,
    rss_articles: RssArticlesArraySchema,
    settings: AppSettingsSchema,
    reading_stats: ReadingStatsSchema,
} as const;

export function validateSyncDomain(
    domain: keyof typeof DOMAIN_SCHEMAS,
    json: string,
): unknown | null {
    const schema = DOMAIN_SCHEMAS[domain];
    if (!schema) return null;
    try {
        const parsed = JSON.parse(json);
        const result = schema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

export function validateSyncPayloads(
    incomingMap: Record<string, string>,
): Record<string, unknown> {
    const valid: Record<string, unknown> = {};
    for (const [domain, json] of Object.entries(incomingMap)) {
        const data = validateSyncDomain(domain as keyof typeof DOMAIN_SCHEMAS, json);
        if (data !== null) {
            valid[domain] = data;
        }
    }
    
    for (const [domain, data] of Object.entries(valid)) {
        if (Array.isArray(data)) {
            const incomingCount = (() => {
                try { return JSON.parse(incomingMap[domain] ?? "[]").length; } catch { return -1; }
            })();
            if (incomingCount !== data.length) {
                console.warn(`[sync-validation] ${domain}: ${incomingCount} incoming, ${data.length} valid (${incomingCount - data.length} filtered)`);
            } else {
                if (import.meta.env.DEV) console.log(`[sync-validation] ${domain}: ${data.length} items passed validation`);
            }
        }
    }
    return valid;
}
