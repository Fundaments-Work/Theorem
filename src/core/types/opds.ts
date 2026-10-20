/**
 * OPDS catalog types. These mirror, field for field, the JSON the Rust parser
 * (`theorem_core::opds`) produces — desktop and mobile get it from native commands, the web
 * build from WebAssembly — so there is nothing to map between the two.
 */

export type OpdsDialect = "atom" | "opds2";
export type OpdsFeedKind = "navigation" | "acquisition" | "mixed" | "empty";
export type OpdsAcquisitionKind = "generic" | "openAccess" | "borrow" | "buy" | "sample" | "subscribe";
export type OpdsFormat = "epub" | "pdf" | "cbz" | "cbr" | "mobi" | "fb2";

export interface OpdsPrice {
    value: string;
    currency: string;
}

export interface OpdsAcquisition {
    href: string;
    kind: OpdsAcquisitionKind;
    mime: string;
    format?: OpdsFormat;
    title?: string;
    size?: number;
    price?: OpdsPrice;
    /** Media types of an indirect acquisition chain. */
    indirect?: string[];
    drm: boolean;
    /** A direct, importable, DRM-free file. */
    downloadable: boolean;
}

export interface OpdsLink {
    href: string;
    rel: string;
    mime: string;
    title?: string;
}

export interface OpdsSeries {
    name: string;
    position?: number;
}

export interface OpdsEntry {
    id: string;
    title: string;
    subtitle?: string;
    authors: string[];
    /** The catalog's own HTML; always pass through `sanitizeHtml` before rendering. */
    summary?: string;
    published?: string;
    updated?: string;
    language?: string;
    publisher?: string;
    rights?: string;
    identifiers?: string[];
    categories?: string[];
    series?: OpdsSeries;
    cover?: string;
    thumbnail?: string;
    acquisitions: OpdsAcquisition[];
    /** Index into `acquisitions` of the best direct download. */
    primary?: number;
    detailHref?: string;
    webUrl?: string;
    related?: OpdsLink[];
}

export interface OpdsNavItem {
    title: string;
    href: string;
    rel: string;
    summary?: string;
    count?: number;
    thumbnail?: string;
    updated?: string;
}

export interface OpdsFacet {
    title: string;
    href: string;
    active: boolean;
    count?: number;
}

export interface OpdsFacetGroup {
    title: string;
    items: OpdsFacet[];
}

export interface OpdsGroup {
    title: string;
    href?: string;
    navigation: OpdsNavItem[];
    entries: OpdsEntry[];
}

export interface OpdsSearchRef {
    href: string;
    kind: "template" | "description";
}

export interface OpdsFeed {
    id: string;
    title: string;
    subtitle?: string;
    icon?: string;
    updated?: string;
    dialect: OpdsDialect;
    kind: OpdsFeedKind;
    selfUrl?: string;
    nextUrl?: string;
    prevUrl?: string;
    firstUrl?: string;
    lastUrl?: string;
    upUrl?: string;
    startUrl?: string;
    search?: OpdsSearchRef;
    facets: OpdsFacetGroup[];
    navigation: OpdsNavItem[];
    groups: OpdsGroup[];
    entries: OpdsEntry[];
    totalResults?: number;
    itemsPerPage?: number;
    startIndex?: number;
}

export interface OpdsAuthFlow {
    kind: string;
    loginLabel?: string;
    passwordLabel?: string;
}

export type OpdsOutcome =
    | { type: "feed"; feed: OpdsFeed }
    | { type: "openSearch"; templates: { template: string; mime: string }[] }
    | { type: "discovery"; href: string; mime: string }
    | { type: "authentication"; title: string; description?: string; flows: OpdsAuthFlow[] }
    | { type: "unsupported"; reason: string };

export interface OpdsLoaded {
    /** Where the document really came from after redirects and HTML discovery. */
    finalUrl: string;
    outcome: OpdsOutcome;
}

/** What a catalog needs to be signed in. HTTP Basic is what OPDS servers use in practice. */
export interface OpdsCredentials {
    username: string;
    password: string;
}

export type OpdsErrorKind =
    | "invalidUrl"
    | "network"
    | "timeout"
    | "notFound"
    | "forbidden"
    | "rateLimited"
    | "http"
    | "authRequired"
    | "tooLarge"
    | "unsupported"
    | "io"
    | "cors";

export interface OpdsDownloadedFile {
    path: string;
    filename: string;
    mime: string;
    size: number;
}
