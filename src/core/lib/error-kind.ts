/**
 * The kind of an error returned by a Tauri command (`AppError` in
 * `src-tauri/src/error.rs`). Framework-free on purpose.
 *
 * Commands send errors as the plain message string, so every existing
 * `String(e)` / `typeof e === "string"` call site keeps working. The kind is
 * read back here: from a `{ kind, message }` object when a caller passes one
 * (the structured form, for the 2.0 plugin API), otherwise from the message.
 * SQLite errors keep SQLite's own result-code text ("database is locked",
 * "file is not a database"), which the Rust tests pin.
 */
export type ErrorKind =
    | "busy"
    | "corrupt"
    | "constraint"
    | "not_found"
    | "invalid_input"
    | "io"
    | "network"
    | "internal";

const KINDS: ReadonlySet<string> = new Set<ErrorKind>([
    "busy",
    "corrupt",
    "constraint",
    "not_found",
    "invalid_input",
    "io",
    "network",
    "internal",
]);

/** Prefixes `with_connection` puts on every SQLite failure. */
const SQLITE_PREFIXES = ["SQLite operation failed:", "Failed to acquire SQLite connection"];

function messageOf(error: unknown): string | undefined {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
        return (error as { message: string }).message;
    }
    return undefined;
}

/** The kind of a command error, or `undefined` when it cannot be told. */
export function errorKind(error: unknown): ErrorKind | undefined {
    if (error && typeof error === "object") {
        const kind = (error as { kind?: unknown }).kind;
        if (typeof kind === "string" && KINDS.has(kind)) return kind as ErrorKind;
    }
    const message = messageOf(error);
    if (!message || !SQLITE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
        return undefined;
    }
    if (/database (table )?is locked|timed out waiting for connection/.test(message)) return "busy";
    if (/file is not a database|database disk image is malformed/.test(message)) return "corrupt";
    if (/constraint failed/.test(message)) return "constraint";
    if (/Query returned no rows/.test(message)) return "not_found";
    return "internal";
}

/**
 * What to tell the user when the library database refused a write, for the
 * kinds that have something better to say than a generic failure.
 */
export function storageErrorHint(error: unknown): string | undefined {
    switch (errorKind(error)) {
        case "busy":
            return "The library is busy, try again in a moment.";
        case "corrupt":
            return "The library database is damaged. Restore a snapshot in Settings → Data & Storage.";
        default:
            return undefined;
    }
}
