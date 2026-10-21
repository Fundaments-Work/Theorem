import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { OpdsError, OpdsService, describeOpdsError, normalizeCatalogUrl } from "../../../core/services/OpdsService";
import type { OpdsCredentials, OpdsFeed } from "../../../core/types";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "../../../ui";

type Check =
    | { status: "idle" }
    | { status: "checking" }
    | { status: "ok"; feed: OpdsFeed; url: string }
    | { status: "auth"; message: string; failed: boolean }
    | { status: "error"; message: string; kind: OpdsError["kind"] | "other" };

const field =
    "h-9 w-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[color:var(--color-text-primary)] placeholder-[color:var(--color-text-muted)] focus:border-[var(--color-text-primary)] focus:outline-none";

function describeFeed(feed: OpdsFeed): string {
    const dialect = feed.dialect === "opds2" ? "OPDS 2.0" : "OPDS 1.x";
    const books = feed.entries.length + feed.groups.reduce((n, g) => n + g.entries.length, 0);
    const sections = feed.navigation.length + feed.groups.reduce((n, g) => n + g.navigation.length, 0);
    const parts = [dialect];
    if (sections) parts.push(`${sections} section${sections === 1 ? "" : "s"}`);
    if (books) parts.push(`${books} book${books === 1 ? "" : "s"}`);
    if (feed.search) parts.push("search");
    return parts.join(" · ");
}

/**
 * Add a catalog. The address is checked before it is saved, so a typo or a server that is not an
 * OPDS catalog is caught here (with a plain reason) instead of becoming a source that never loads.
 */
export function AddCatalogModal({
    isOpen,
    onClose,
    onAdd,
}: {
    isOpen: boolean;
    onClose: () => void;
    onAdd: (catalog: { title: string; url: string; auth?: OpdsCredentials }) => void;
}) {
    const [url, setUrl] = useState("");
    const [title, setTitle] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [needsAuth, setNeedsAuth] = useState(false);
    const [check, setCheck] = useState<Check>({ status: "idle" });

    useEffect(() => {
        if (!isOpen) {
            setUrl("");
            setTitle("");
            setUsername("");
            setPassword("");
            setNeedsAuth(false);
            setCheck({ status: "idle" });
        }
    }, [isOpen]);

    // Editing the address invalidates an earlier check.
    useEffect(() => {
        setCheck((prev) => (prev.status === "idle" ? prev : { status: "idle" }));
    }, [url]);

    const creds = needsAuth && (username || password) ? { username: username.trim(), password } : undefined;

    const runCheck = async () => {
        if (!url.trim()) return;
        setCheck({ status: "checking" });
        const normalized = normalizeCatalogUrl(url);
        try {
            const { feed, finalUrl } = await OpdsService.probe(normalized, creds);
            setCheck({ status: "ok", feed, url: finalUrl });
            setTitle((t) => t || feed.title);
        } catch (error) {
            if (error instanceof OpdsError && error.kind === "authRequired") {
                setNeedsAuth(true);
                setCheck({ status: "auth", message: describeOpdsError(error), failed: Boolean(creds) });
            } else {
                setCheck({
                    status: "error",
                    message: describeOpdsError(error),
                    kind: error instanceof OpdsError ? error.kind : "other",
                });
            }
        }
    };

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (check.status === "ok") {
            onAdd({ title: title.trim() || check.feed.title, url: check.url, auth: creds });
            onClose();
        } else if (check.status !== "checking") {
            void runCheck();
        }
    };

    // A server that is simply offline right now can still be saved on purpose.
    const canAddUnchecked = check.status === "error" && (check.kind === "network" || check.kind === "timeout");
    const addUnchecked = () => {
        const normalized = normalizeCatalogUrl(url);
        onAdd({ title: title.trim() || normalized.replace(/^https?:\/\//, "").split("/")[0], url: normalized, auth: creds });
        onClose();
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="sm">
            <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
                <ModalHeader title="Add a catalog" onClose={onClose} />
                <ModalBody className="space-y-4">
                    <p className="text-xs leading-relaxed text-[color:var(--color-text-muted)]">
                        Paste the address of an OPDS catalog: a Calibre, Kavita, Komga or COPS server, a library, or a public collection.
                    </p>

                    <label className="block space-y-1">
                        <span className="text-xs text-[color:var(--color-text-secondary)]">Address</span>
                        <input
                            className={field}
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="192.168.1.10:8080/opds"
                            inputMode="url"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            autoFocus
                        />
                    </label>

                    {needsAuth && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="block space-y-1">
                                <span className="text-xs text-[color:var(--color-text-secondary)]">Username</span>
                                <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} />
                            </label>
                            <label className="block space-y-1">
                                <span className="text-xs text-[color:var(--color-text-secondary)]">Password</span>
                                <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                            </label>
                        </div>
                    )}
                    {!needsAuth && (
                        <button type="button" onClick={() => setNeedsAuth(true)} className="text-xs text-[color:var(--color-text-secondary)] underline underline-offset-2 transition-colors hover:text-[color:var(--color-accent)]">
                            This catalog needs a sign-in
                        </button>
                    )}

                    <div aria-live="polite" className="min-h-5 text-xs">
                        {check.status === "checking" && (
                            <p className="flex items-center gap-2 text-[color:var(--color-text-muted)]">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
                            </p>
                        )}
                        {check.status === "ok" && (
                            <p className="flex items-start gap-2 text-[color:var(--color-text-primary)]">
                                <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-[color:var(--color-accent)]" />
                                <span>
                                    {check.feed.title}
                                    <span className="block text-[color:var(--color-text-muted)]">{describeFeed(check.feed)}</span>
                                </span>
                            </p>
                        )}
                        {check.status === "auth" && (
                            <p className="flex items-start gap-2 text-[color:var(--color-text-secondary)]">
                                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                                {check.failed ? "Those details were not accepted." : "This catalog asks for a sign-in. Enter your details and check again."}
                            </p>
                        )}
                        {check.status === "error" && (
                            <p className="flex items-start gap-2 text-[color:var(--color-error)]">
                                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                                {check.message}
                            </p>
                        )}
                    </div>

                    {check.status === "ok" && (
                        <label className="block space-y-1">
                            <span className="text-xs text-[color:var(--color-text-secondary)]">Name</span>
                            <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} />
                        </label>
                    )}
                </ModalBody>
                <ModalFooter>
                    <button type="button" onClick={onClose} className="border border-[var(--color-border)] px-4 py-2 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-muted)]">
                        Cancel
                    </button>
                    {canAddUnchecked && (
                        <button type="button" onClick={addUnchecked} className="border border-[var(--color-border)] px-4 py-2 text-xs text-[color:var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-muted)]">
                            Add anyway
                        </button>
                    )}
                    <button
                        type="submit"
                        disabled={!url.trim() || check.status === "checking"}
                        className="bg-[var(--color-text-primary)] px-4 py-2 text-xs text-[var(--color-background)] transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                        {check.status === "ok" ? "Add catalog" : "Check address"}
                    </button>
                </ModalFooter>
            </form>
        </Modal>
    );
}
