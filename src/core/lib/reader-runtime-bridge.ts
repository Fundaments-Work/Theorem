export type WebBookOpener = (file: Blob | File) => Promise<unknown>;

export interface WebStarDict {
    loadIfo: (blob: Blob) => Promise<unknown>;
    loadDict: (blob: Blob, inflate: (data: Uint8Array) => Promise<Uint8Array>) => Promise<unknown>;
    loadIdx: (blob: Blob) => Promise<unknown>;
    loadSyn: (blob: Blob) => Promise<unknown> | undefined;
    lookup: (term: string) => Promise<unknown>;
}

export type WebStarDictLoader = () => Promise<new () => WebStarDict>;

let registeredBookOpener: WebBookOpener | null = null;
let registeredStarDictLoader: WebStarDictLoader | null = null;

export function registerWebBookOpener(opener: WebBookOpener | null): void {
    registeredBookOpener = opener;
}

export function registerWebStarDictLoader(loader: WebStarDictLoader | null): void {
    registeredStarDictLoader = loader;
}

export async function openWebBook(file: Blob | File): Promise<unknown> {
    if (!registeredBookOpener) {
        throw new Error("Book reader runtime has not been registered.");
    }
    return registeredBookOpener(file);
}

export async function loadWebStarDictClass(): Promise<new () => WebStarDict> {
    if (!registeredStarDictLoader) {
        throw new Error("Web StarDict runtime has not been registered.");
    }
    return registeredStarDictLoader();
}
