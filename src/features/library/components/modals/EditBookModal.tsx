import { useEffect, useRef, useState } from "react";
import { Modal, ModalHeader, ModalBody, ModalFooter, TheoremBookCover } from "../../../../ui";
import { applyBookEdits } from "../../../../core/lib/book-edit";
import { cn } from "../../../../core/lib/utils";
import { Star, Upload, Link as LinkIcon, Trash2, AlertCircle, Loader2 } from "lucide-react";
import type { Book } from "../../../../core/types";

interface EditBookModalProps {
    isOpen: boolean;
    book: Book | null;
    onClose: () => void;
}

export function EditBookModal({ isOpen, book, onClose }: EditBookModalProps) {
    const [title, setTitle] = useState("");
    const [author, setAuthor] = useState("");
    const [description, setDescription] = useState("");
    const [publisher, setPublisher] = useState("");
    const [publishedDate, setPublishedDate] = useState("");
    const [language, setLanguage] = useState("");
    const [isbn, setIsbn] = useState("");
    const [category, setCategory] = useState("");
    const [tagsText, setTagsText] = useState("");
    const [rating, setRating] = useState(0);
    const [series, setSeries] = useState("");
    const [seriesIndex, setSeriesIndex] = useState<string>("");

    const [coverPreview, setCoverPreview] = useState<string>("");
    const [coverBlob, setCoverBlob] = useState<Blob | null>(null);
    const [removeCover, setRemoveCover] = useState(false);
    const [coverUrlVisible, setCoverUrlVisible] = useState(false);
    const [coverUrl, setCoverUrl] = useState("");

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen && book) {
            setTitle(book.title);
            setAuthor(book.author || "");
            setDescription(book.description || "");
            setPublisher(book.publisher || "");
            setPublishedDate(book.publishedDate || "");
            setLanguage(book.language || "");
            setIsbn(book.isbn || "");
            setCategory(book.category || "");
            setTagsText(book.tags.join(", "));
            setRating(book.rating || 0);
            setSeries(book.series || "");
            setSeriesIndex(book.seriesIndex !== undefined ? String(book.seriesIndex) : "");
            setCoverPreview(book.coverPath || "");
            setCoverBlob(null);
            setRemoveCover(false);
            setCoverUrlVisible(false);
            setCoverUrl("");
            setError(null);
        }
    }, [isOpen, book]);

    if (!book) return null;

    const handleFilePick = (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            setError("Selected file is not an image.");
            return;
        }
        setCoverBlob(file);
        setRemoveCover(false);
        setCoverPreview(URL.createObjectURL(file));
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleFetchCoverUrl = async () => {
        const url = coverUrl.trim();
        if (!url) return;
        try {
            setError(null);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (!blob.type.startsWith("image/")) {
                throw new Error("Fetched content is not an image.");
            }
            setCoverBlob(blob);
            setRemoveCover(false);
            setCoverPreview(URL.createObjectURL(blob));
            setCoverUrlVisible(false);
            setCoverUrl("");
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load image from URL. The site may block downloads.");
        }
    };

    const handleRemoveCover = () => {
        setCoverBlob(null);
        setRemoveCover(true);
        setCoverPreview("");
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || saving) return;

        setSaving(true);
        setError(null);
        try {
            const metadata: Partial<Book> = {};
            if (title.trim() !== book.title) metadata.title = title.trim();
            if (author.trim() !== (book.author || "")) metadata.author = author.trim();
            if (description.trim() !== (book.description || "")) metadata.description = description.trim();
            if (publisher.trim() !== (book.publisher || "")) metadata.publisher = publisher.trim();
            if (publishedDate.trim() !== (book.publishedDate || "")) metadata.publishedDate = publishedDate.trim();
            if (language.trim() !== (book.language || "")) metadata.language = language.trim();
            if (isbn.trim() !== (book.isbn || "")) metadata.isbn = isbn.trim();
            if (category.trim() !== (book.category || "")) metadata.category = category.trim();

            if (series.trim() !== (book.series || "")) {
                metadata.series = series.trim() || undefined;
            }
            const parsedSeriesIndex = seriesIndex.trim() !== "" ? parseFloat(seriesIndex.trim()) : undefined;
            if (parsedSeriesIndex !== book.seriesIndex) {
                metadata.seriesIndex = typeof parsedSeriesIndex === "number" && !Number.isNaN(parsedSeriesIndex) ? parsedSeriesIndex : undefined;
            }

            const nextTags = tagsText
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean);
            const currentTags = book.tags;
            if (nextTags.length !== currentTags.length || nextTags.some((t, i) => t !== currentTags[i])) {
                metadata.tags = nextTags;
            }

            if (rating !== (book.rating || 0)) metadata.rating = rating || undefined;

            const coverInput = coverBlob
                ? { blob: coverBlob }
                : removeCover
                  ? { remove: true }
                  : undefined;

            const result = await applyBookEdits(book.id, metadata, coverInput);
            if (!result.ok) {
                setError(result.message || "Failed to save book edits.");
                return;
            }
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" showCloseButton={true}>
            <form onSubmit={handleSubmit} className="flex h-full min-h-0 flex-col">
                <ModalHeader title="Edit Book Info" onClose={onClose} showCloseButton={true} />
                <ModalBody>
                    {error && (
                        <div className="flex items-start gap-2 p-3 bg-[var(--color-error)]/10 mb-4">
                            <AlertCircle className="w-4 h-4 text-[color:var(--color-error)] mt-0.5 flex-shrink-0" />
                            <div className="text-xs text-[color:var(--color-error)] whitespace-pre-wrap leading-relaxed">{error}</div>
                        </div>
                    )}

                    <div className="flex items-start gap-4 mb-5">
                        <div className="w-20 h-28 shrink-0 overflow-hidden shadow-sm">
                            <TheoremBookCover
                                title={title || book?.title || "Untitled"}
                                author={author || book?.author || "Unknown Author"}
                                coverUrl={coverPreview}
                            />
                        </div>
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2">
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => handleFilePick(e.target.files)}
                                />
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="ui-btn px-3 py-1.5 text-xs font-bold uppercase"
                                >
                                    <Upload className="w-3.5 h-3.5" />
                                    Choose Image
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setCoverUrlVisible((v) => !v)}
                                    className="ui-btn px-3 py-1.5 text-xs font-bold uppercase"
                                >
                                    <LinkIcon className="w-3.5 h-3.5" />
                                    From URL
                                </button>
                                {book.coverPath && (
                                    <button
                                        type="button"
                                        onClick={handleRemoveCover}
                                        disabled={removeCover}
                                        className="ui-btn px-3 py-1.5 text-xs font-bold uppercase text-[var(--color-error)] disabled:opacity-50"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                        Remove
                                    </button>
                                )}
                            </div>
                            {coverUrlVisible && (
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        value={coverUrl}
                                        onChange={(e) => setCoverUrl(e.target.value)}
                                        placeholder="https://example.com/cover.jpg"
                                        className="ui-input text-sm"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleFetchCoverUrl}
                                        disabled={!coverUrl.trim() || saving}
                                        className="ui-btn-primary px-3 py-1.5 text-xs font-bold uppercase disabled:opacity-50"
                                    >
                                        Set
                                    </button>
                                </div>
                            )}
                            {removeCover && (
                                <p className="text-xs text-[color:var(--color-text-muted)]">Cover will be removed.</p>
                            )}
                        </div>
                    </div>

                    <div className="space-y-4">
                        <div>
                            <label htmlFor="edit-title" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                Title
                            </label>
                            <input
                                id="edit-title"
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className="ui-input"
                                autoFocus
                            />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div className="sm:col-span-2">
                                <label htmlFor="edit-series" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                    Series Name
                                </label>
                                <input
                                    id="edit-series"
                                    type="text"
                                    value={series}
                                    onChange={(e) => setSeries(e.target.value)}
                                    placeholder="e.g., The Lord of the Rings"
                                    className="ui-input"
                                />
                            </div>
                            <div>
                                <label htmlFor="edit-series-index" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                    Volume / Index
                                </label>
                                <input
                                    id="edit-series-index"
                                    type="number"
                                    step="any"
                                    value={seriesIndex}
                                    onChange={(e) => setSeriesIndex(e.target.value)}
                                    placeholder="e.g., 1"
                                    className="ui-input"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label htmlFor="edit-author" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                    Author
                                </label>
                                <input
                                    id="edit-author"
                                    type="text"
                                    value={author}
                                    onChange={(e) => setAuthor(e.target.value)}
                                    className="ui-input"
                                />
                            </div>
                            <div>
                                <label htmlFor="edit-publisher" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                    Publisher
                                </label>
                                <input
                                    id="edit-publisher"
                                    type="text"
                                    value={publisher}
                                    onChange={(e) => setPublisher(e.target.value)}
                                    className="ui-input"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label htmlFor="edit-date" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                    Published Date
                                </label>
                                <input
                                    id="edit-date"
                                    type="text"
                                    value={publishedDate}
                                    onChange={(e) => setPublishedDate(e.target.value)}
                                    placeholder="YYYY-MM-DD"
                                    className="ui-input"
                                />
                            </div>
                            <div>
                                <label htmlFor="edit-language" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                    Language
                                </label>
                                <input
                                    id="edit-language"
                                    type="text"
                                    value={language}
                                    onChange={(e) => setLanguage(e.target.value)}
                                    placeholder="en"
                                    className="ui-input"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label htmlFor="edit-isbn" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                    ISBN
                                </label>
                                <input
                                    id="edit-isbn"
                                    type="text"
                                    value={isbn}
                                    onChange={(e) => setIsbn(e.target.value)}
                                    className="ui-input"
                                />
                            </div>
                            <div>
                                <label htmlFor="edit-category" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                    Category
                                </label>
                                <input
                                    id="edit-category"
                                    type="text"
                                    value={category}
                                    onChange={(e) => setCategory(e.target.value)}
                                    className="ui-input"
                                />
                            </div>
                        </div>

                        <div>
                            <label htmlFor="edit-tags" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                Tags
                            </label>
                            <input
                                id="edit-tags"
                                type="text"
                                value={tagsText}
                                onChange={(e) => setTagsText(e.target.value)}
                                placeholder="comma, separated, tags"
                                className="ui-input"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                Description
                            </label>
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={4}
                                className={cn("ui-input", "resize-none")}
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                Rating
                            </label>
                            <div className="flex items-center gap-1">
                                {[1, 2, 3, 4, 5].map((star) => (
                                    <button
                                        key={star}
                                        type="button"
                                        onClick={() => setRating(rating === star ? 0 : star)}
                                        className="p-0.5"
                                        aria-label={`${star} star${star > 1 ? "s" : ""}`}
                                    >
                                        <Star
                                            className={cn(
                                                "w-5 h-5",
                                                star <= rating
                                                    ? "text-[color:var(--color-warning)] fill-current"
                                                    : "text-[color:var(--color-border)]",
                                            )}
                                        />
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => setRating(0)}
                                    className="ml-2 text-xs text-[color:var(--color-text-muted)] underline"
                                >
                                    Clear
                                </button>
                            </div>
                        </div>
                    </div>
                </ModalBody>
                <ModalFooter>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={saving}
                        className="ui-btn-ghost disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!title.trim() || saving}
                        className="ui-btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                    </button>
                </ModalFooter>
            </form>
        </Modal>
    );
}