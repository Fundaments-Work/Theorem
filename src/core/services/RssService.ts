
import type { RssFeed, RssArticle } from '../types';
import { v4 as uuidv4 } from 'uuid';
import type { XMLParser } from 'fast-xml-parser';
import { isTauri } from '../lib/env';
import { invoke } from '@tauri-apps/api/core';
import { needsMarkdownRender, renderMarkdownBatch } from '../lib/article-markdown';

interface ParsedFeed {
    title: string;
    description?: string;
    siteUrl?: string;
    iconUrl?: string;
    articles: Omit<RssArticle, 'id' | 'feedId' | 'fetchedAt' | 'isRead' | 'isFavorite'>[];
}

class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private readonly maxTokens: number;
    private readonly refillRate: number;

    constructor(maxTokens: number, refillRatePerSecond: number) {
        this.maxTokens = maxTokens;
        this.tokens = maxTokens;
        this.refillRate = refillRatePerSecond;
        this.lastRefill = Date.now();
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }

    async acquire(tokenCount = 1, timeoutMs = 30000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            this.refill();
            if (this.tokens >= tokenCount) {
                this.tokens -= tokenCount;
                return;
            }
            const deficit = tokenCount - this.tokens;
            const waitMs = Math.min(500, Math.ceil((deficit / this.refillRate) * 1000));
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
        throw new Error('Rate limit acquire timeout');
    }
}

const FEED_REQUESTS_PER_SECOND = 2;

const feedRateLimiter = new TokenBucket(4, FEED_REQUESTS_PER_SECOND);

interface CachedTextResponse {
    body: string;
    expiresAt: number;
}

const FEED_FETCH_CACHE_TTL_MS = 2 * 60 * 1000;
const feedResponseCache = new Map<string, CachedTextResponse>();

function str(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if ('#text' in obj) return str(obj['#text']);
        if ('__text' in obj) return str(obj['__text']);
        return '';
    }
    return '';
}

function ensureArray<T>(value: T | T[] | undefined | null): T[] {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

function parseOptionalDate(value: unknown): Date | undefined {
    const s = str(value);
    if (!s) return undefined;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

function resolveAbsoluteUrl(value: string, baseUrl: string): string {
    if (!value || value.startsWith('data:') || value.startsWith('javascript:')) {
        return value;
    }
    try {
        return new URL(value, baseUrl).href;
    } catch {
        return value;
    }
}

function getCachedResponse(
    cache: Map<string, CachedTextResponse>,
    key: string,
): string | null {
    const cached = cache.get(key);
    if (!cached) {
        return null;
    }

    if (cached.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }

    return cached.body;
}

function putCachedResponse(
    cache: Map<string, CachedTextResponse>,
    key: string,
    body: string,
    ttlMs: number,
): void {
    cache.set(key, {
        body,
        expiresAt: Date.now() + ttlMs,
    });
}

async function createFeedParser(): Promise<XMLParser> {
    const { XMLParser } = await import('fast-xml-parser');
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        
        removeNSPrefix: false,
        
        cdataPropName: undefined,
        textNodeName: '#text',
        
        parseTagValue: false,
        parseAttributeValue: false,
        
        isArray: (_name: string, _jpath: any, _isLeafNode?: boolean, _isAttribute?: boolean) => {
            
            if (_name === 'item' || _name === 'entry') return true;
            
            if (_name === 'link') return true;
            return false;
        },
        trimValues: true,
    });
}

function isHtmlContent(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) {
        return true;
    }
    if (trimmed.includes('<html') && !trimmed.includes('<rss') && !trimmed.includes('<feed')) {
        return true;
    }
    
    const htmlTags = ['<head', '<body', '<meta', '<div', '<script', '<style'];
    const feedIndicators = ['<rss', '<feed', '<channel', 'jsonfeed', '<rdf:'];
    if (htmlTags.some(t => trimmed.includes(t)) && !feedIndicators.some(t => trimmed.includes(t))) {
        return true;
    }
    return false;
}

function extractFeedUrlsFromHtml(htmlText: string, baseUrl?: string): string[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    const urls: string[] = [];

    const feedLinks = doc.querySelectorAll(
        'link[type="application/rss+xml"],' +
        'link[type="application/atom+xml"],' +
        'link[type="application/json"],' +
        'link[type="application/feed+json"],' +
        'link[type="application/json+feed"],' +
        'link[type="application/xml"],' +
        'link[type="text/xml"]'
    );
    for (const link of Array.from(feedLinks)) {
        const href = link.getAttribute('href');
        if (href) {
            urls.push(baseUrl ? resolveAbsoluteUrl(href, baseUrl) : href);
        }
    }

    if (urls.length === 0) {
        const anchors = doc.querySelectorAll<HTMLAnchorElement>('a[href]');
        const feedPattern = /\/(feed|rss|atom)(\.xml|\.json|\/)?$/i;
        for (const a of Array.from(anchors)) {
            const href = a.getAttribute('href');
            if (href && feedPattern.test(href)) {
                urls.push(baseUrl ? resolveAbsoluteUrl(href, baseUrl) : href);
            }
        }
    }

    return urls;
}

function extractFeedUrlFromHtml(htmlText: string, baseUrl?: string): string | null {
    const urls = extractFeedUrlsFromHtml(htmlText, baseUrl);
    return urls[0] ?? null;
}

interface JsonFeedAttachment {
    url: string;
    mime_type?: string;
    title?: string;
}

interface JsonFeedItem {
    id: string;
    title?: string;
    url?: string;
    external_url?: string;
    content_html?: string;
    content_text?: string;
    summary?: string;
    date_published?: string;
    date_modified?: string;
    author?: { name?: string };
    authors?: Array<{ name?: string }>;
    image?: string;
    banner_image?: string;
    attachments?: JsonFeedAttachment[];
}

function tryParseJsonFeed(text: string): ParsedFeed | null {
    try {
        const json = JSON.parse(text);
        if (!json.version || (!json.version.includes('jsonfeed') && !json.items)) {
            return null;
        }

        const articles = (json.items || []).map((item: JsonFeedItem) => {
            const content = item.content_html || item.content_text || item.summary || '';
            const summary = item.summary || (item.content_text ? item.content_text.substring(0, 500) : undefined);

            let imageUrl: string | undefined;
            if (item.banner_image) {
                imageUrl = item.banner_image;
            } else if (item.image) {
                imageUrl = item.image;
            } else if (item.attachments) {
                const imageAttachment = item.attachments.find((a: JsonFeedAttachment) =>
                    a.mime_type?.startsWith('image/')
                );
                if (imageAttachment) {
                    imageUrl = imageAttachment.url;
                }
            }

            return {
                title: item.title || 'Untitled',
                url: item.url || item.external_url || '',
                content,
                summary,
                author: item.author?.name || (Array.isArray(item.authors) ? item.authors[0]?.name : undefined),
                imageUrl,
                publishedAt: item.date_published ? new Date(item.date_published) :
                    item.date_modified ? new Date(item.date_modified) : undefined,
            };
        });

        return {
            title: json.title || 'Untitled Feed',
            description: json.description,
            siteUrl: json.home_page_url,
            iconUrl: json.icon || json.favicon,
            articles,
        };
    } catch {
        return null;
    }
}

type FeedNode = Record<string, any>;

function nodeText(node: unknown): string {
    if (node == null) return '';
    if (typeof node === 'string') return node.trim();
    if (typeof node === 'number') return String(node);
    if (typeof node === 'object') {
        const obj = node as FeedNode;
        
        if ('#text' in obj) return str(obj['#text']);
        
        if (Array.isArray(obj)) return obj.map(nodeText).join(' ').trim();
    }
    return '';
}

function firstOf(obj: FeedNode, ...keys: string[]): unknown {
    for (const key of keys) {
        if (obj[key] != null) return obj[key];
    }
    return undefined;
}

function atomLinkHref(links: FeedNode | FeedNode[] | undefined, rel = 'alternate'): string {
    const arr = ensureArray(links) as FeedNode[];
    
    for (const link of arr) {
        if (typeof link === 'string') return (link as string).trim();
        const l = link as FeedNode;
        if (l['@_rel'] === rel || (!l['@_rel'] && rel === 'alternate')) {
            const href = l['@_href'] ?? '';
            if (href) return str(href);
        }
    }
    
    for (const link of arr) {
        if (typeof link === 'string') return (link as string).trim();
        const l = link as FeedNode;
        const href = l['@_href'] ?? '';
        if (href) return str(href);
    }
    return '';
}

function parseRss2(root: FeedNode): ParsedFeed {
    const rss = root.rss || root;
    const channel: FeedNode = rss.channel || rss;

    const title = nodeText(channel.title);
    const description = nodeText(channel.description);
    const siteUrl = nodeText(channel.link);
    const iconUrl = nodeText(channel.image?.url) || nodeText(channel['itunes:image']?.['@_href']);

    const items = ensureArray(channel.item);
    const articles = items.map((item: FeedNode) => {
        const itemTitle = nodeText(item.title);

        let link = nodeText(item.link);
        if (!link) {
            const guid = item.guid;
            if (typeof guid === 'object' && guid?.['@_isPermaLink'] === 'true') {
                link = nodeText(guid);
            } else if (typeof guid === 'string' && (guid.startsWith('http://') || guid.startsWith('https://'))) {
                link = guid.trim();
            }
        }

        const contentEncoded = firstOf(item, 'content:encoded', 'content\\:encoded', 'encoded');
        let content = nodeText(contentEncoded);
        if (!content) {
            content = nodeText(item.description);
        }

        const summary = nodeText(item.description);

        const author = nodeText(firstOf(item, 'author', 'dc:creator', 'dc:author'))
            || nodeText(firstOf(item, 'itunes:author'))
            || undefined;

        const pubDate = nodeText(firstOf(item, 'pubDate', 'dc:date', 'published', 'updated'));

        let articleImageUrl: string | undefined;

        const enclosures = ensureArray(item.enclosure);
        for (const enc of enclosures) {
            const type = str(enc?.['@_type']);
            if (type.startsWith('image/')) {
                articleImageUrl = str(enc?.['@_url']);
                break;
            }
        }

        if (!articleImageUrl) {
            const mediaContents = ensureArray(firstOf(item, 'media:content')) as FeedNode[];
            for (const mc of mediaContents) {
                const n = mc as FeedNode;
                const type = str(n['@_type'] ?? n['@_medium']);
                const url = str(n['@_url']);
                if (url && (type.startsWith('image') || type === 'image')) {
                    articleImageUrl = url;
                    break;
                }
                
                if (url && str(n['@_medium']) === 'image') {
                    articleImageUrl = url;
                    break;
                }
            }
        }

        if (!articleImageUrl) {
            const mediaThumbnail = firstOf(item, 'media:thumbnail');
            const thumbUrl = str(typeof mediaThumbnail === 'object' ? (mediaThumbnail as FeedNode)?.['@_url'] : mediaThumbnail);
            if (thumbUrl) articleImageUrl = thumbUrl;
        }

        if (!articleImageUrl) {
            const mediaGroup = item['media:group'];
            if (mediaGroup) {
                const groupContents = ensureArray(mediaGroup['media:content']);
                for (const mc of groupContents) {
                    if (str(mc?.['@_medium']) === 'image' || str(mc?.['@_type']).startsWith('image')) {
                        articleImageUrl = str(mc?.['@_url']);
                        break;
                    }
                }
                if (!articleImageUrl) {
                    const groupThumb = mediaGroup['media:thumbnail'];
                    const gUrl = str(typeof groupThumb === 'object' ? groupThumb?.['@_url'] : groupThumb);
                    if (gUrl) articleImageUrl = gUrl;
                }
            }
        }

        if (!articleImageUrl) {
            const itunesImage = item['itunes:image'];
            if (itunesImage) {
                articleImageUrl = str(typeof itunesImage === 'object' ? itunesImage?.['@_href'] : itunesImage);
            }
        }

        if (!articleImageUrl && content) {
            const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
            if (imgMatch?.[1]) {
                articleImageUrl = imgMatch[1];
            }
        }

        return {
            title: itemTitle || 'Untitled',
            url: link,
            content: content || summary || '',
            summary: summary !== content ? summary : undefined,
            author,
            imageUrl: articleImageUrl,
            publishedAt: parseOptionalDate(pubDate),
        };
    });

    return {
        title: title || 'Untitled Feed',
        description: description || undefined,
        siteUrl: siteUrl || undefined,
        iconUrl: iconUrl || undefined,
        articles,
    };
}

function parseAtomFeed(root: FeedNode): ParsedFeed {
    const feed: FeedNode = root.feed || root;

    const title = nodeText(feed.title);
    const subtitle = nodeText(feed.subtitle);
    const siteUrl = atomLinkHref(feed.link, 'alternate');
    const iconUrl = nodeText(feed.icon) || nodeText(feed.logo);

    const entries = ensureArray(feed.entry);
    const articles = entries.map((entry: FeedNode) => {
        const entryTitle = nodeText(entry.title);
        const link = atomLinkHref(entry.link, 'alternate');

        let content = '';
        const contentNode = entry.content;
        if (contentNode != null) {
            if (typeof contentNode === 'object' && '#text' in contentNode) {
                content = str(contentNode['#text']);
            } else {
                content = nodeText(contentNode);
            }
        }

        const summary = nodeText(entry.summary);
        if (!content) content = summary;

        let author = '';
        const authorNode = entry.author;
        if (authorNode) {
            author = nodeText(authorNode.name) || nodeText(authorNode);
        }
        if (!author) {
            
            const feedAuthor = feed.author;
            if (feedAuthor) {
                author = nodeText(feedAuthor.name) || nodeText(feedAuthor);
            }
        }

        const published = nodeText(firstOf(entry, 'published', 'updated', 'dc:date'));

        let imageUrl: string | undefined;
        const mediaThumbnail = firstOf(entry, 'media:thumbnail');
        if (mediaThumbnail) {
            imageUrl = str(typeof mediaThumbnail === 'object' ? (mediaThumbnail as FeedNode)?.['@_url'] : mediaThumbnail);
        }
        if (!imageUrl) {
            const mediaContents = ensureArray(firstOf(entry, 'media:content')) as FeedNode[];
            for (const mc of mediaContents) {
                const n = mc as FeedNode;
                if (str(n['@_medium']) === 'image' || str(n['@_type']).startsWith('image')) {
                    imageUrl = str(n['@_url']);
                    break;
                }
            }
        }
        if (!imageUrl) {
            const enclosures = ensureArray(entry.link);
            for (const enc of enclosures) {
                if (str(enc?.['@_rel']) === 'enclosure' && str(enc?.['@_type']).startsWith('image')) {
                    imageUrl = str(enc?.['@_href']);
                    break;
                }
            }
        }
        
        if (!imageUrl && content) {
            const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
            if (imgMatch?.[1]) imageUrl = imgMatch[1];
        }

        return {
            title: entryTitle || 'Untitled',
            url: link,
            content: content || '',
            summary: summary !== content ? summary : undefined,
            author: author || undefined,
            imageUrl,
            publishedAt: parseOptionalDate(published),
        };
    });

    return {
        title: title || 'Untitled Feed',
        description: subtitle || undefined,
        siteUrl: siteUrl || undefined,
        iconUrl: iconUrl || undefined,
        articles,
    };
}

function parseRdfFeed(root: FeedNode): ParsedFeed {
    
    const rdf = root['rdf:RDF'] || root['RDF'] || root;
    const channel: FeedNode = rdf.channel || rdf['rss:channel'] || {};

    const title = nodeText(firstOf(channel, 'title', 'rss:title'));
    const description = nodeText(firstOf(channel, 'description', 'rss:description'));
    const siteUrl = nodeText(firstOf(channel, 'link', 'rss:link'));

    const items = ensureArray(rdf.item || rdf['rss:item']);
    const articles = items.map((item: FeedNode) => {
        const itemTitle = nodeText(firstOf(item, 'title', 'rss:title'));
        const link = nodeText(firstOf(item, 'link', 'rss:link'));
        const itemDesc = nodeText(firstOf(item, 'description', 'rss:description'));
        const contentEncoded = firstOf(item, 'content:encoded', 'content\\:encoded');
        const content = nodeText(contentEncoded) || itemDesc;
        const author = nodeText(firstOf(item, 'dc:creator', 'dc:author', 'author'));
        const pubDate = nodeText(firstOf(item, 'dc:date', 'pubDate'));

        return {
            title: itemTitle || 'Untitled',
            url: link,
            content: content || '',
            summary: itemDesc || undefined,
            author: author || undefined,
            imageUrl: undefined,
            publishedAt: parseOptionalDate(pubDate),
        };
    });

    return {
        title: title || 'Untitled Feed',
        description: description || undefined,
        siteUrl: siteUrl || undefined,
        iconUrl: undefined,
        articles,
    };
}

async function parseFeedXml(xmlText: string): Promise<ParsedFeed> {
    
    if (isHtmlContent(xmlText)) {
        const feedUrl = extractFeedUrlFromHtml(xmlText);
        if (feedUrl) {
            throw new Error(
                `This URL returns an HTML page instead of a feed. ` +
                `The actual feed URL appears to be: ${feedUrl}. ` +
                `Please try using that URL instead.`
            );
        }
        throw new Error(
            `This URL returns HTML instead of a valid RSS/Atom feed. ` +
            `The site may require visiting the page in a browser first, ` +
            `or the feed URL may be different. Try looking for a link ` +
            `with "RSS" or "Feed" on the website.`
        );
    }

    const jsonFeed = tryParseJsonFeed(xmlText);
    if (jsonFeed) return jsonFeed;

    if (isTauri()) {
        try {
            return await invoke<ParsedFeed>('parse_rss_feed_native', { xml: xmlText });
        } catch {
            // Fallback to JS parser
        }
    }

    const parser = await createFeedParser();
    let parsed: FeedNode;
    try {
        parsed = parser.parse(xmlText);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse feed XML: ${msg}`);
    }

    if (parsed.rss) {
        return parseRss2(parsed);
    }

    if (parsed.feed) {
        return parseAtomFeed(parsed);
    }

    if (parsed['rdf:RDF'] || parsed['RDF']) {
        return parseRdfFeed(parsed);
    }

    if (parsed.channel) {
        return parseRss2({ channel: parsed.channel });
    }

    const keys = Object.keys(parsed).filter(k => !k.startsWith('?'));
    if (keys.length === 1) {
        const root = parsed[keys[0]];
        if (root?.channel) return parseRss2(root);
        if (root?.entry) return parseAtomFeed(root);
    }

    throw new Error(
        'Unrecognized feed format. Supported formats: RSS 2.0, RSS 1.0/RDF, Atom, JSON Feed.'
    );
}

async function fetchWithTauri(url: string): Promise<string> {
    const cached = getCachedResponse(feedResponseCache, url);
    if (cached) {
        return cached;
    }

    const body = await invoke<string>('fetch_rss_feed', { url });
    putCachedResponse(feedResponseCache, url, body, FEED_FETCH_CACHE_TTL_MS);
    return body;
}

function isCorsError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
        message.includes('cors') ||
        message.includes('access control') ||
        message.includes('preflight') ||
        message.includes('cross-origin') ||
        message.includes('blocked by cors') ||
        (message.includes('load failed') && !message.includes('json')) ||
        message.includes('networkerror') ||
        message.includes('failed to fetch')
    );
}

function isLikelyCorsRestricted(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    const corsRestrictedServices = [
        'elsevier.com', 'springer.com', 'sciencedirect.com', 'nature.com',
        'ieee.org', 'acm.org', 'jstor.org', 'wiley.com',
        'tandfonline.com', 'sagepub.com',
    ];
    return corsRestrictedServices.some(service => lowerUrl.includes(service));
}

export async function convertMarkdownToHtml(html: string): Promise<string> {
    if (!needsMarkdownRender(html)) {
        return html;
    }
    const [rendered] = await renderMarkdownBatch([html]);
    return rendered;
}

export async function fetchAndParseFeed(
    url: string,
): Promise<{ feed: Omit<ParsedFeed, 'articles'>; articles: ParsedFeed['articles'] }> {
    await feedRateLimiter.acquire();
    let xmlText = getCachedResponse(feedResponseCache, url) ?? "";

    if (!xmlText && isTauri()) {
        try {
            xmlText = await fetchWithTauri(url);
        } catch (tauriError) {
            const errorMsg = tauriError instanceof Error ? tauriError.message : String(tauriError);
            throw new Error(`Failed to fetch feed: ${errorMsg}`);
        }
    } else if (!xmlText) {
        if (isLikelyCorsRestricted(url)) {
            throw new Error(
                `This URL appears to be from a publisher that blocks browser requests (CORS). ` +
                `Some publishers require authentication and block direct feed access from web browsers. ` +
                `Try using a different feed source or accessing through the publisher's official RSS page.`
            );
        }

        let response: Response;
        try {
            response = await fetch(url, { method: 'GET' });
        } catch (fetchError) {
            const error = fetchError instanceof Error ? fetchError : new Error(String(fetchError));
            if (isCorsError(error)) {
                throw new Error(
                    `CORS Error: The server at ${new URL(url).hostname} is blocking browser requests. ` +
                    `This is a security restriction on the server side. ` +
                    `Try these solutions:\n` +
                    `1. Find the feed on a different aggregator (e.g., Feedly)\n` +
                    `2. Use the website's main RSS link instead\n` +
                    `3. Check if the site requires authentication`
                );
            }
            if (error.message.includes('failed to fetch') || error.message.includes('network')) {
                throw new Error(
                    `Network error: Unable to reach ${url}. ` +
                    `Please check:\n` +
                    `1. Your internet connection\n` +
                    `2. The URL is correct\n` +
                    `3. The server is online`
                );
            }
            throw error;
        }

        if (!response.ok) {
            if (response.status === 403) {
                throw new Error(
                    `Access forbidden (403): The server blocked this request. ` +
                    `This may be due to:\n` +
                    `1. CORS restrictions - the server blocks browser requests\n` +
                    `2. Authentication required\n` +
                    `3. Rate limiting\n` +
                    `Try accessing the feed URL directly in your browser to verify it works.`
                );
            }
            if (response.status === 404) {
                throw new Error(`Feed not found (404): The URL does not exist. Please check the URL is correct.`);
            }
            if (response.status === 401) {
                throw new Error(`Authentication required (401): This feed requires login credentials.`);
            }
            throw new Error(`Failed to fetch feed: ${response.status} ${response.statusText}`);
        }

        try {
            xmlText = await response.text();
            putCachedResponse(feedResponseCache, url, xmlText, FEED_FETCH_CACHE_TTL_MS);
        } catch (textError) {
            throw new Error(`Failed to read feed content: ${textError instanceof Error ? textError.message : 'Unknown error'}`);
        }
    }

    if (isHtmlContent(xmlText)) {
        const discoveredUrls = extractFeedUrlsFromHtml(xmlText, url);
        for (const feedUrl of discoveredUrls) {
            const resolvedUrl = new URL(feedUrl, url).href;
            try {
                let newText: string;
                if (isTauri()) {
                    newText = await fetchWithTauri(resolvedUrl);
                } else {
                    const newResponse = await fetch(resolvedUrl, { method: 'GET' });
                    if (!newResponse.ok) continue;
                    newText = await newResponse.text();
                }
                if (!isHtmlContent(newText)) {
                    const parsed = await parseFeedXml(newText);
                    const { articles, ...feedMeta } = parsed;
                    return { feed: feedMeta, articles };
                }
            } catch {
                
            }
        }

        const commonFeedPaths = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml', '/feed/'];
        for (const path of commonFeedPaths) {
            try {
                const guessUrl = new URL(path, url).href;
                let guessText: string;
                if (isTauri()) {
                    guessText = await fetchWithTauri(guessUrl);
                } else {
                    const guessRes = await fetch(guessUrl, { method: 'GET' });
                    if (!guessRes.ok) continue;
                    guessText = await guessRes.text();
                }
                if (!isHtmlContent(guessText)) {
                    const parsed = await parseFeedXml(guessText);
                    const { articles, ...feedMeta } = parsed;
                    return { feed: feedMeta, articles };
                }
            } catch {
                
            }
        }
    }

    const parsed = await parseFeedXml(xmlText);
    const { articles, ...feedMeta } = parsed;
    return { feed: feedMeta, articles };
}

export async function materializeFeed(
    url: string,
    parsed: Awaited<ReturnType<typeof fetchAndParseFeed>>,
): Promise<{ feed: RssFeed; articles: RssArticle[] }> {
    const feedId = uuidv4();
    const now = new Date();

    const articles: RssArticle[] = await Promise.all(parsed.articles.map(async a => ({
        id: uuidv4(),
        feedId,
        title: a.title,
        author: a.author,
        url: a.url,
        content: await convertMarkdownToHtml(a.content),
        summary: await convertMarkdownToHtml(a.summary ?? ""),
        imageUrl: a.imageUrl,
        publishedAt: a.publishedAt,
        fetchedAt: now,
        isRead: false,
        isFavorite: false,
    })));

    const feed: RssFeed = {
        id: feedId,
        title: parsed.feed.title,
        url,
        siteUrl: parsed.feed.siteUrl,
        description: parsed.feed.description,
        iconUrl: parsed.feed.iconUrl,
        lastFetched: now,
        addedAt: now,
        unreadCount: articles.length,
    };

    return { feed, articles };
}
