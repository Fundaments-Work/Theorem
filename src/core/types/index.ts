
export type BookFormat = "epub" | "mobi" | "azw" | "azw3" | "fb2" | "cbz" | "cbr" | "pdf";

export const FIXED_LAYOUT_FORMATS: BookFormat[] = ["cbz", "cbr", "pdf"];
export const REFLOWABLE_FORMATS: BookFormat[] = ["epub", "mobi", "azw", "azw3", "fb2"];

export const isFixedLayout = (format: BookFormat): boolean =>
    FIXED_LAYOUT_FORMATS.includes(format);

export const isReflowable = (format: BookFormat): boolean =>
    REFLOWABLE_FORMATS.includes(format);

export const FORMAT_DISPLAY_NAMES: Record<BookFormat, string> = {
    epub: 'EPUB',
    mobi: 'MOBI',
    azw: 'AZW',
    azw3: 'AZW3',
    fb2: 'FB2',
    cbz: 'CBZ',
    cbr: 'CBR',
    pdf: 'PDF',
};

export const FORMAT_COLORS: Record<BookFormat, string> = {
    epub: "#111111",
    mobi: "#2b2b2b",
    azw: "#2b2b2b",
    azw3: "#2b2b2b",
    fb2: "#454545",
    cbz: "#5f5f5f",
    cbr: "#5f5f5f",
    pdf: "#7a7a7a",
};

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'red' | 'orange' | 'purple';

export type PdfZoomMode = "custom" | "page-fit" | "width-fit";

export interface PdfViewState {
    page: number;
    totalPages: number;
    zoom: number;
    zoomMode: PdfZoomMode;
    presentationMode?: 'scroll' | 'paged';
}

export interface Book {
    id: string;
    title: string;
    author: string;
    filePath: string;
    storagePath?: string; 
    format: BookFormat;
    contentHash?: string;
    coverPath?: string;
    coverExtractionDone?: boolean;
    description?: string;
    publisher?: string;
    publishedDate?: string;
    language?: string;
    isbn?: string;
    fileSize: number;
    addedAt: Date;
    lastReadAt?: Date;
    progress: number; 
    currentLocation?: string; 
    lastClickFraction?: number; 
    
    pageProgress?: {
        currentPage: number;
        endPage?: number;
        totalPages: number;
        range: string;
    };
    pdfViewState?: PdfViewState;
    locations?: string; 
    category?: string;
    tags: string[];
    rating?: number; 
    isFavorite: boolean;
    
    manualCompletionState?: "read" | "unread";
    
    progressBeforeFinish?: number;
    
    readingTime: number; 
    completedAt?: Date; 
    
    syncedWithoutFile?: boolean;
    
    blobHash?: string;
    
    coverBlobHash?: string;
}

export interface ReadingProgress {
    bookId: string;
    location: string;
    percentage: number;
    lastUpdated: Date;
    readingTime: number; 
    pagesRead: number;
}

export interface Annotation {
    id: string;
    bookId: string;
    referenceId?: string;
    type: "highlight" | "note" | "bookmark";
    location: string;
    selectedText?: string;
    noteContent?: string;
    color?: HighlightColor;
    createdAt: Date;
    updatedAt?: Date;
    
    pageNumber?: number;
    pdfAnnotationType?: 'highlight' | 'drawing' | 'textNote';
    drawingData?: string;
    textNoteContent?: string;
    rect?: { x: number; y: number; width: number; height: number };
    rects?: Array<{ x: number; y: number; width: number; height: number }>;
    strokeWidth?: number;
}

export interface Collection {
    id: string;
    name: string;
    description?: string;
    bookIds: string[];
    kind: "general";
    createdAt: Date;
    updatedAt?: Date;
}

export type TombstoneEntity = "book" | "annotation" | "collection" | "feed" | "rss_article" | "vocabulary" | "collection_book";

export interface DeletionTombstone {
    
    entityId: string;
    
    entityType: TombstoneEntity;
    
    deletedAt: string;
}

export type ReaderTheme = "light" | "sepia" | "dark";
export type FontFamily = "original" | "serif" | "sans" | "mono";
export type ReadingFlow = "paged" | "scroll" | "auto";
export type PageLayout = "single" | "double" | "auto";
export type PageAnimation = "slide" | "fade" | "instant";

export interface ReaderSettings {
    theme: ReaderTheme;
    fontFamily: FontFamily;
    fontSize: number; 
    lineHeight: number; 
    letterSpacing: number; 
    paragraphSpacing: number; 
    textAlign: "left" | "justify" | "center";
    hyphenation: boolean;
    margins: number; 
    flow: ReadingFlow;
    layout: PageLayout;
    brightness: number; 
    fullscreen: boolean;
    pageAnimation: PageAnimation;
    toolbarAutoHide: boolean;
    autoHideDelay: number; 
    zoom: number; 
    wordSpacing: number; 
    forcePublisherStyles: boolean; 
    
    prefetchDistance: number; 
    enableAnimations: boolean;
    virtualScrolling: boolean; 
}

export type LibraryViewMode = "grid" | "list" | "compact";
export type LibrarySortBy = "title" | "author" | "dateAdded" | "lastRead" | "progress" | "rating";
export type LibrarySortOrder = "asc" | "desc";
export type LibraryStatusFilter = "all" | "unread" | "reading" | "completed";

export interface AppSettings {
    sidebarCollapsed: boolean;
    libraryViewMode: LibraryViewMode;
    librarySortBy: LibrarySortBy;
    librarySortOrder: LibrarySortOrder;
    scanFolders: string[];
    cacheSize: number; 
    theme: "light" | "dark" | "system";
    accentColor: string;
    readerSettings: ReaderSettings;
    vocabulary: VocabularySettings;
    tts: TtsSettings;
    vault: VaultIntegrationSettings;
    deviceSync: DeviceSyncSettings;
    hasCompletedOnboarding: boolean;
    showDailyHighlight: boolean;
    speedReadEnabled: boolean;
    goalNotifications: boolean;
    dailyReminderTime: string;
    syncNotifications: boolean;
}

export interface PairedDevice {
    deviceId: string;
    deviceName: string;
    
    irohNodeId: string;
    lastIp: string;
    lastPort: number;
    pairedAt: string;
    lastSyncAt?: string;
    
    fingerprint?: string;
    
    peerRelayUrl?: string;
    
    syncDocId?: string;
    
    syncDocTicket?: string;
}

export interface DeviceSyncSettings {
    
    deviceId: string;
    
    deviceName: string;
    
    pairedDevices: PairedDevice[];
    
    syncOnConnect: boolean;
    
    autoSyncEnabled: boolean;
}

export interface DeviceIdentityInfo {
    deviceId: string;
    deviceName: string;
    publicKeyHex: string;
    fingerprint?: string;
}

export interface SyncServerInfo {
    ip: string;
    port: number;
    running: boolean;
}

export interface PairingQrData {
    qrSvg: string;
    pairingCode: string;
}

export type DeviceSyncStatus = "idle" | "hosting" | "pairing" | "connecting" | "syncing" | "synced" | "error";

export interface SyncConflict {
    entityType: string;
    entityId: string;
    
    winner: "local" | "remote";
    
    label?: string;
}

export type DictionaryProvider = "stardict" | "free-dictionary-api";

export interface VocabularySettings {
    vocabularyEnabled: boolean;
    showPronunciation: boolean;
    playPronunciationAudio: boolean;
}

export interface TtsSettings {
    enabled: boolean;
    voice: string;
    speed: number;
}

export interface VaultIntegrationSettings {
    enabled: boolean;
    vaultPath: string;
    autoExportHighlights: boolean;
    
    highlightsFileName: string;
    vocabularyFileName: string;
}

export interface VocabularyMeaning {
    partOfSpeech?: string;
    definitions: string[];
    examples?: string[];
    synonyms?: string[];
    antonyms?: string[];
    provider: DictionaryProvider;
}

export interface VocabularyTerm {
    id: string;
    term: string;
    normalizedTerm: string;
    language: string;
    phonetic?: string;
    audioUrl?: string;
    meanings: VocabularyMeaning[];
    providerHistory: DictionaryProvider[];
    createdAt: Date;
    updatedAt?: Date;
    lookupCount?: number;
    tags?: string[];
    contexts?: string[];
}

export interface InstalledDictionary {
    id: string;
    name: string;
    language: string;
    format: "stardict" | "mdx";
    sizeBytes: number;
    importedAt: Date;
}

export interface DailyReadingActivity {
    date: string; 
    minutes: number;
    booksRead: string[]; 
}

export interface ReadingStats {
    totalReadingTime: number; 
    booksCompleted: number;
    averageReadingSpeed: number; 
    currentStreak: number; 
    longestStreak: number; 
    dailyGoal: number; 
    yearlyBookGoal: number;
    booksReadThisYear: number;
    dailyActivity: DailyReadingActivity[]; 
    lastReadDate?: string; 
}

export interface RssFeed {
    id: string;
    title: string;
    url: string;           
    siteUrl?: string;      
    description?: string;
    iconUrl?: string;
    lastFetched?: Date;
    addedAt: Date;
    errorMessage?: string;
    unreadCount: number;
}

export interface RssArticle {
    id: string;
    feedId: string;
    title: string;
    author?: string;
    url: string;           
    content: string;       
    summary?: string;
    fullContent?: string;
    contentSource?: 'feed' | 'extracted';
    imageUrl?: string;
    publishedAt?: Date;
    fetchedAt: Date;
    isRead: boolean;
    isFavorite: boolean;
    progress?: number;
}

export type AppRoute = "library" | "reader" | "vocabulary" | "settings" | "annotations" | "statistics" | "shelves" | "bookmarks" | "feeds" | "opds";

export interface UIState {
    currentRoute: AppRoute;
    currentBookId?: string;
    sidebarOpen: boolean;
    readerToolbarVisible: boolean;
    searchQuery: string;
    searchCommittedQuery: string;
    selectedBooks: string[];
    isLoading: boolean;
    loadingMessage?: string;
    error?: string;
    vaultSyncStatus: "idle" | "syncing" | "synced" | "error";
    vaultSyncMessage?: string;
    vaultSyncAt?: string;
    deviceSyncStatus: DeviceSyncStatus;
    deviceSyncMessage?: string;
    deviceSyncAt?: string;
    
    downloadingBookId?: string;
    
    hasHydrated: boolean;
}

export interface DocLocation {
    cfi: string;
    percentage: number;
    tocItem?: {
        label: string;
        href: string;
    };
    pageItem?: {
        label: string;
    };
    
    pageInfo?: {
        currentPage: number;      
        endPage?: number;         
        totalPages: number;       
        range?: string;           
        isEstimated?: boolean;    
    };
}

export interface TocItem {
    label: string;
    href: string;
    subitems?: TocItem[];
}

export interface DocMetadata {
    title: string;
    author: string;
    description?: string;
    publisher?: string;
    language?: string;
    pubdate?: string;
    identifier?: string;
    cover?: string;
}

export interface SearchResult {
    cfi: string;
    excerpt: string;
}

export interface BookSection {
    label: string;
    href: string;
    fraction: number; 
    index: number;
}

export interface ThemeSettings {
    fontFamily?: string;
    fontSize?: number;
    lineHeight?: number;
    letterSpacing?: number;
    wordSpacing?: number;
    paragraphSpacing?: number;
    textAlign?: "left" | "justify" | "center";
    textColor?: string;
    backgroundColor?: string;
    linkColor?: string;
    flow?: ReadingFlow;
    layout?: PageLayout;
    margins?: number;
    zoom?: number;
    hyphenation?: boolean;
    forcePublisherStyles?: boolean;
}

export type { ThemeSettings as ReaderThemeSettings };

export interface OpdsLink {
    rel: string;
    href: string;
    type?: string;
    title?: string;
}

export interface OpdsEntry {
    id: string;
    title: string;
    author?: string;
    summary?: string;
    content?: string;
    updated?: string;
    published?: string;
    language?: string;
    publisher?: string;
    coverUrl?: string;
    thumbnailUrl?: string;
    downloadUrl?: string;
    downloadFormat?: "epub" | "pdf" | "cbz" | "mobi";
    navUrl?: string;
    isNavigation: boolean;
    links: OpdsLink[];
}

export interface OpdsFeed {
    id: string;
    title: string;
    subtitle?: string;
    icon?: string;
    updated?: string;
    selfUrl?: string;
    nextUrl?: string;
    prevUrl?: string;
    upUrl?: string;
    startUrl?: string;
    searchUrlTemplate?: string;
    entries: OpdsEntry[];
}

export interface OpdsCatalog {
    id: string;
    title: string;
    url: string;
    isPreset?: boolean;
    description?: string;
    icon?: string;
}
