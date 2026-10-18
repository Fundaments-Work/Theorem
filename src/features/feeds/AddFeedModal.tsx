
import { useState, useCallback, useRef, useEffect } from "react";
import { Modal, ModalBody, ModalFooter } from "../../ui";
import { Loader2, Rss, AlertCircle } from "lucide-react";

interface AddFeedModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (url: string) => Promise<void>;
    isLoading?: boolean;
    error?: string;
}

export function AddFeedModal({ isOpen, onClose, onSubmit, isLoading, error }: AddFeedModalProps) {
    const [url, setUrl] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setUrl("");
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [isOpen]);

    const handleSubmit = useCallback(async () => {
        const trimmed = url.trim();
        if (!trimmed) return;

        let feedUrl = trimmed;
        if (!feedUrl.startsWith("http://") && !feedUrl.startsWith("https://")) {
            feedUrl = "https://" + feedUrl;
        }

        await onSubmit(feedUrl);
    }, [url, onSubmit]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !isLoading) {
            e.preventDefault();
            handleSubmit();
        }
    }, [handleSubmit, isLoading]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={true}>
            <ModalBody className="p-0">
                <div className="p-6">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="w-10 h-10 bg-[var(--color-accent)]/10 flex items-center justify-center">
                            <Rss className="w-5 h-5 text-[color:var(--color-accent)]" />
                        </div>
                        <div>
                            <h2 className="text-lg text-[color:var(--color-text-primary)]">
                                Add Feed
                            </h2>
                            <p className="text-xs text-[color:var(--color-text-muted)]">
                                Subscribe to an RSS or Atom feed
                            </p>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div>
                            <label htmlFor="feed-url" className="block text-xs text-[color:var(--color-text-muted)] mb-1.5">
                                Feed URL
                            </label>
                            <input
                                id="feed-url"
                                ref={inputRef}
                                type="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="https://example.com/feed.xml"
                                disabled={isLoading}
                                className="ui-input"
                            />
                        </div>

                        {error && (
                            <div className="flex items-start gap-2 p-3 bg-[var(--color-error)]/10">
                                <AlertCircle className="w-4 h-4 text-[color:var(--color-error)] mt-0.5 flex-shrink-0" />
                                <div className="text-xs text-[color:var(--color-error)] whitespace-pre-wrap leading-relaxed">
                                    {error}
                                </div>
                            </div>
                        )}

                        <p className="text-[var(--font-size-3xs)] text-[color:var(--color-text-muted)]">
                            Enter the URL of an RSS or Atom feed. Most blogs and news sites provide feed URLs.
                        </p>
                    </div>
                </div>
            </ModalBody>
            <ModalFooter>
                <button
                    onClick={onClose}
                    className="ui-btn-ghost"
                >
                    Cancel
                </button>
                <button
                    onClick={handleSubmit}
                    disabled={isLoading || !url.trim()}
                    className="ui-btn-primary"
                >
                    {isLoading ? (
                        <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Adding...</span>
                        </>
                    ) : (
                        <span>Subscribe</span>
                    )}
                </button>
            </ModalFooter>
        </Modal>
    );
}
