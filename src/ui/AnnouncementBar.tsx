import React, { useEffect, useState, useTransition } from "react";
import { X, Info, AlertTriangle, AlertOctagon } from "lucide-react";
import {
    Announcement,
    fetchAnnouncements,
    selectActive,
    getDismissedAnnouncementIds,
    dismissAnnouncement,
    linkifySegments,
    renderInlineBold,
} from "../core/lib/announcements";
import { openExternalUrl } from "../core/lib/open-external-url";
import { cn } from "../core/lib/utils";

interface AnnouncementBarProps {
    className?: string;
    announcement?: Announcement | null;
    onDismiss?: (id: string) => void;
}

/**
 * Pure presentational renderer for announcement body text.
 * Guaranteed zero-HTML-sink: converts tokens to native React elements with automatic escaping.
 */
export function AnnouncementBody({ body }: { body: string }) {
    if (!body) return null;

    const segments = linkifySegments(body);

    return (
        <span className="whitespace-pre-line break-words">
            {segments.map((seg, i) => {
                if (seg.kind === "link") {
                    return (
                        <a
                            key={i}
                            href={seg.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => {
                                e.preventDefault();
                                void openExternalUrl(seg.href);
                            }}
                            className="underline underline-offset-2 hover:opacity-80 transition-opacity font-medium"
                        >
                            {seg.value}
                        </a>
                    );
                }

                const inlineNodes = renderInlineBold(seg.value);
                return (
                    <span key={i}>
                        {inlineNodes.map((node, j) =>
                            node.bold ? (
                                <strong key={j} className="font-semibold text-[color:var(--color-text-primary)]">
                                    {node.value}
                                </strong>
                            ) : (
                                <React.Fragment key={j}>{node.value}</React.Fragment>
                            )
                        )}
                    </span>
                );
            })}
        </span>
    );
}

export function AnnouncementBar({ className, announcement: overrideAnnouncement, onDismiss }: AnnouncementBarProps) {
    const [active, setActive] = useState<Announcement | null>(overrideAnnouncement ?? null);
    const [, startTransition] = useTransition();

    useEffect(() => {
        if (overrideAnnouncement !== undefined) {
            setActive(overrideAnnouncement);
            return;
        }

        let isMounted = true;

        async function load() {
            const list = await fetchAnnouncements();
            if (!isMounted) return;

            const dismissed = getDismissedAnnouncementIds();
            const current = selectActive(list, Date.now(), dismissed);

            startTransition(() => {
                setActive(current);
            });
        }

        void load();

        return () => {
            isMounted = false;
        };
    }, [overrideAnnouncement]);

    if (!active) {
        return null;
    }

    const handleDismiss = () => {
        dismissAnnouncement(active.id);
        onDismiss?.(active.id);
        setActive(null);
    };

    const severityIcon = () => {
        switch (active.severity) {
            case "critical":
                return <AlertOctagon className="w-4 h-4 text-[color:var(--color-error)] shrink-0 mt-0.5" />;
            case "warning":
                return <AlertTriangle className="w-4 h-4 text-[color:var(--color-accent)] shrink-0 mt-0.5" />;
            case "info":
            default:
                return <Info className="w-4 h-4 text-[color:var(--color-text-secondary)] shrink-0 mt-0.5" />;
        }
    };

    const severityStyles = () => {
        switch (active.severity) {
            case "critical":
                return "bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)] border-[color-mix(in_srgb,var(--color-error)_25%,transparent)] text-[color:var(--color-text-primary)]";
            case "warning":
                return "bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] border-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-[color:var(--color-text-primary)]";
            case "info":
            default:
                return "bg-[var(--color-surface-variant)] border-[var(--color-border)] text-[color:var(--color-text-primary)]";
        }
    };

    return (
        <aside
            role="status"
            aria-live="polite"
            className={cn(
                "sticky top-0 z-[100] w-full border-b px-4 py-2.5 sm:px-6 transition-all duration-200 animate-fade-in text-xs",
                severityStyles(),
                className
            )}
        >
            <div className="flex items-start sm:items-center justify-between gap-3 max-w-7xl mx-auto">
                <div className="flex items-start sm:items-center gap-2.5 min-w-0 flex-1">
                    {severityIcon()}
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2.5 min-w-0">
                        {active.title && (
                            <span className="font-semibold text-[color:var(--color-text-primary)] shrink-0">
                                {active.title}
                            </span>
                        )}
                        {active.title && active.body && (
                            <span className="hidden sm:inline text-[color:var(--color-border)]">|</span>
                        )}
                        <span className="text-[color:var(--color-text-secondary)] min-w-0">
                            <AnnouncementBody body={active.body} />
                        </span>
                    </div>

                    {active.link && (
                        <button
                            type="button"
                            onClick={() => void openExternalUrl(active.link!)}
                            className="inline-flex items-center gap-1 shrink-0 text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-accent)] hover:opacity-80 transition-opacity ml-1.5"
                        >
                            {active.linkLabel || "View"} &rarr;
                        </button>
                    )}
                </div>

                <button
                    type="button"
                    onClick={handleDismiss}
                    aria-label="Dismiss announcement"
                    className="p-1 -mr-1 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] rounded transition-colors shrink-0"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        </aside>
    );
}
