import { useState, type FormEvent } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import type { OpdsAuthFlow, OpdsCredentials, OpdsOutcome } from "../../../core/types";

/** Sign-in methods the app can do. OPDS servers in practice use HTTP Basic. */
const BASIC = "http://opds-spec.org/auth/basic";

/**
 * Asks for a login when a catalog answers 401. Understands the server's own wording when it sent
 * an OPDS Authentication Document, and says plainly when it only offers a method Theorem lacks.
 */
export function OpdsAuthPanel({
    catalogTitle,
    realm,
    hint,
    failed,
    initialUsername = "",
    onSubmit,
}: {
    catalogTitle: string;
    realm?: string;
    hint?: OpdsOutcome;
    /** Credentials were already sent and refused. */
    failed: boolean;
    /** Kept across a failed attempt so only the password has to be retyped. */
    initialUsername?: string;
    onSubmit: (credentials: OpdsCredentials, remember: boolean) => void;
}) {
    const doc = hint?.type === "authentication" ? hint : undefined;
    const flows: OpdsAuthFlow[] = doc?.flows ?? [];
    const basic = flows.find((f) => f.kind === BASIC);
    // With a document that lists only other methods (OAuth, SAML...) there is nothing we can ask for.
    const unsupported = Boolean(doc) && flows.length > 0 && !basic;

    const [username, setUsername] = useState(initialUsername);
    const [password, setPassword] = useState("");
    const [remember, setRemember] = useState(true);
    const [show, setShow] = useState(false);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (!username.trim() && !password) return;
        onSubmit({ username: username.trim(), password }, remember);
    };

    const input =
        "h-9 w-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[color:var(--color-text-primary)] placeholder-[color:var(--color-text-muted)] focus:border-[var(--color-text-primary)] focus:outline-none";

    return (
        <div className="mx-auto flex w-full max-w-[24rem] flex-col items-center py-16 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface)]">
                <Lock className="h-6 w-6 stroke-1 text-[color:var(--color-text-muted)]" />
            </div>
            <h2 className="mb-1 text-base text-[color:var(--color-text-primary)]">{doc?.title ?? `Sign in to ${catalogTitle}`}</h2>
            <p className="mb-6 text-sm leading-relaxed text-[color:var(--color-text-muted)]">
                {doc?.description ?? (realm ? `“${realm}” asks for a username and password.` : "This catalog asks for a username and password.")}
            </p>

            {unsupported ? (
                <p className="text-sm text-[color:var(--color-text-muted)]">
                    This library signs in with a method Theorem can't use yet. You can still browse its public catalog in a web browser.
                </p>
            ) : (
                <form onSubmit={submit} className="w-full space-y-3 text-left">
                    <label className="block space-y-1">
                        <span className="text-xs text-[color:var(--color-text-secondary)]">{basic?.loginLabel ?? "Username"}</span>
                        <input
                            className={input}
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            autoComplete="username"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            autoFocus={!initialUsername}
                        />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs text-[color:var(--color-text-secondary)]">{basic?.passwordLabel ?? "Password"}</span>
                        <span className="relative block">
                            <input
                                className={`${input} pr-9`}
                                type={show ? "text" : "password"}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="current-password"
                                autoFocus={Boolean(initialUsername)}
                            />
                            <button
                                type="button"
                                onClick={() => setShow((v) => !v)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-[color:var(--color-text-muted)] transition-colors hover:text-[color:var(--color-accent)]"
                                aria-label={show ? "Hide password" : "Show password"}
                            >
                                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                        </span>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
                        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                        Remember on this device
                    </label>
                    {failed && (
                        <p role="alert" className="text-xs text-[color:var(--color-error)]">
                            The catalog did not accept those details. Check them and try again.
                        </p>
                    )}
                    <button
                        type="submit"
                        className="h-9 w-full bg-[var(--color-accent)] text-sm text-[color:var(--color-accent-contrast)] transition-opacity hover:opacity-90"
                    >
                        Sign in
                    </button>
                </form>
            )}
        </div>
    );
}
