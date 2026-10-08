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
                return <AlertOctagon className="w-4 h-4 text-[color:var(--color-error)] shrink-0" />;
            case "warning":
                return <AlertTriangle className="w-4 h-4 text-[color:var(--color-accent)] shrink-0" />;
            case "info":
            default:
                return <Info className="w-4 h-4 text-[color:var(--color-accent)] shrink-0" />;
        }
    };

    const severityStyles = () => {
        switch (active.severity) {
            case "critical":
                return "bg-[color-mix(in_srgb,var(--color-error)_8%,var(--color-surface))] border-[color-mix(in_srgb,var(--color-error)_25%,var(--color-border))] border-l-[3px] border-l-[var(--color-error)] text-[color:var(--color-text-primary)]";
            case "warning":
                return "bg-[color-mix(in_srgb,var(--color-accent)_7%,var(--color-surface))] border-[color-mix(in_srgb,var(--color-accent)_25%,var(--color-border))] border-l-[3px] border-l-[var(--color-accent)] text-[color:var(--color-text-primary)]";
            case "info":
            default:
                return "bg-[color-mix(in_srgb,var(--color-surface-variant)_50%,var(--color-surface))] border-[var(--color-border)] border-l-[3px] border-l-[var(--color-accent)] text-[color:var(--color-text-primary)]";
        }
    };

    const badgeConfig = () => {
        switch (active.severity) {
            case "critical":
                return {
                    label: "Alert",
                    styles: "bg-[color-mix(in_srgb,var(--color-error)_14%,transparent)] text-[color:var(--color-error)] border-[color-mix(in_srgb,var(--color-error)_28%,transparent)]",
                };
            case "warning":
                return {
                    label: "Advisory",
                    styles: "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[color:var(--color-accent)] border-[color-mix(in_srgb,var(--color-accent)_28%,transparent)]",
                };
            case "info":
            default:
                return {
                    label: "Notice",
                    styles: "bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[color:var(--color-accent)] border-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]",
                };
        }
    };

    const ctaButtonStyles = () => {
        switch (active.severity) {
            case "critical":
                return "text-[color:var(--color-error)] bg-[color-mix(in_srgb,var(--color-error)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-error)_18%,transparent)] border-[color-mix(in_srgb,var(--color-error)_25%,transparent)]";
            case "warning":
            case "info":
            default:
                return "text-[color:var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] border-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]";
        }
    };

    const badge = badgeConfig();

    return (
        <aside
            role="status"
            aria-live="polite"
            className={cn(
                "sticky top-0 z-[40] w-full border-b transition-colors duration-150 animate-fade-in text-xs",
                severityStyles(),
                className
            )}
        >
            <div className="relative max-w-[var(--layout-content-max-width)] mx-auto px-4 sm:px-6 lg:px-8 py-2.5 sm:py-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3.5 pr-8 sm:pr-10">
                    {/* Content Group */}
                    <div className="flex items-start sm:items-center gap-2.5 min-w-0 flex-1">
                        <div className="pt-0.5 sm:pt-0 shrink-0">
                            {severityIcon()}
                        </div>

                        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2.5 min-w-0 flex-1">
                            <div className="flex items-center gap-2 shrink-0">
                                <span
                                    className={cn(
                                        "px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold tracking-wider uppercase border select-none shrink-0 leading-none",
                                        badge.styles
                                    )}
                                >
                                    {badge.label}
                                </span>
                                {active.title && (
                                    <span className="font-semibold text-[13px] sm:text-xs text-[color:var(--color-text-primary)]">
                                        {active.title}
                                    </span>
                                )}
                            </div>

                            {active.title && active.body && (
                                <span
                                    className="hidden sm:inline-block w-px h-3 bg-[var(--color-border)] shrink-0 opacity-60"
                                    aria-hidden="true"
                                />
                            )}

                            {active.body && (
                                <span className="text-xs leading-relaxed text-[color:var(--color-text-secondary)] min-w-0 break-words">
                                    <AnnouncementBody body={active.body} />
                                </span>
                            )}
                        </div>
                    </div>

                    {/* CTA Action */}
                    {active.link && (
                        <div className="pl-6.5 sm:pl-0 shrink-0">
                            <button
                                type="button"
                                onClick={() => void openExternalUrl(active.link!)}
                                className={cn(
                                    "inline-flex items-center gap-1.5 px-2.5 py-1 sm:py-0.5 rounded-sm text-[11px] font-semibold tracking-wide border transition-colors shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
                                    ctaButtonStyles()
                                )}
                            >
                                <span>{active.linkLabel || "Details"}</span>{" "}
                                <span aria-hidden="true">&rarr;</span>
                            </button>
                        </div>
                    )}
                </div>

                {/* Dismiss Button */}
                <button
                    type="button"
                    onClick={handleDismiss}
                    aria-label="Dismiss announcement"
                    title="Dismiss announcement"
                    className="absolute right-2.5 sm:right-5 lg:right-7 top-2 sm:top-1/2 sm:-translate-y-1/2 p-1.5 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] rounded-xs transition-colors shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        </aside>
    );
}
