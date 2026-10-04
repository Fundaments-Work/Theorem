import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function formatReadingTime(minutes: number): string {
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function formatProgress(progress: number): string {
    return `${Math.round(progress * 100)}%`;
}

export function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + "...";
}

export function debounce<T extends (...args: unknown[]) => unknown>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return (...args: Parameters<T>) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

export function formatFileSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function formatRelativeDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
    return `${Math.floor(diffDays / 365)} years ago`;
}

export function isBookMarkedRead(book: { completedAt?: Date | string | null; progress?: number }): boolean {
    return Boolean(book.completedAt || (book.progress != null && book.progress >= 0.99));
}

export function normalizeAuthor(author: unknown): string {
    if (!author) return "";
    
    if (typeof author === "string") return author;
    
    if (Array.isArray(author)) {
        return author
            .map(a => normalizeAuthor(a))
            .filter(Boolean)
            .join(", ");
    }
    
    if (typeof author === "object" && author !== null) {
        const authorObj = author as Record<string, unknown>;
        if (typeof authorObj.name === "string") {
            return authorObj.name;
        }
        
        const values = Object.values(authorObj);
        const stringVal = values.find(v => typeof v === "string");
        if (stringVal) return stringVal as string;
    }
    
    return "";
}

export function safeDecodeURIComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function normalizeFilePath(filePath: string): string {
    const trimmedPath = filePath.trim();
    if (!trimmedPath) {
        return trimmedPath;
    }

    const schemeMatch = trimmedPath.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
    if (schemeMatch && schemeMatch[1]?.toLowerCase() !== "file") {
        return trimmedPath;
    }

    if (!trimmedPath.startsWith("file://")) {
        return safeDecodeURIComponent(trimmedPath);
    }

    try {
        const url = new URL(trimmedPath);
        if (url.protocol !== "file:") {
            return safeDecodeURIComponent(trimmedPath);
        }

        const decodedPath = safeDecodeURIComponent(url.pathname);
        
        if (/^\/[A-Za-z]:\//.test(decodedPath)) {
            return decodedPath.slice(1);
        }
        return decodedPath || trimmedPath;
    } catch {
        return trimmedPath;
    }
}
