import { registerWebBookOpener, registerWebStarDictLoader } from "../../../core/lib/reader-runtime-bridge";

let registered = false;

/**
 * Registers lazy reader-runtime loaders so `core/` modules never import directly
 * from `features/reader/` and startup bundles do not eagerly pull foliate-js.
 */
export function registerReaderCoreRuntime(): void {
    if (registered) {
        return;
    }
    registered = true;

    registerWebBookOpener(async (file) => {
        const { makeBook } = await import("../foliate-js-runtime/view.js");
        return makeBook(file);
    });

    registerWebStarDictLoader(async () => {
        const { StarDict } = await import("../foliate-js-runtime/dict.js");
        return StarDict;
    });
}
