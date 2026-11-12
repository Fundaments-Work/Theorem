import { useCallback, useMemo, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import { vocabularyTermFromLookup, type DictionaryLookupResult } from "../../../core/services/DictionaryService";
import type { Annotation, DocLocation, HighlightColor, VocabularyTerm } from "../../../core/types";
import type { ReaderViewportHandle } from "../components/ReaderViewport";
import { findAnnotationForSelection, findMergeTargets, pickVisibleAnchorRect, unionCfis } from "../foliate/selection-anchor";
import { usePdfTextSelection } from "./index";
import { extractSectionIndex } from "../lib/reader-page-helpers";

export interface UseReaderAnnotationsAndDictionaryParams {
    activeDocId: string | null;
    readerRef: RefObject<ReaderViewportHandle | null>;
    annotations: Annotation[];
    setAnnotations: Dispatch<SetStateAction<Annotation[]>>;
    annotationsById: Map<string, Annotation>;
    bookmarkByLocation: Map<string, Annotation>;
    location: DocLocation | null;
    isPdfFormat: boolean;
    pdfAnnotationMode: "none" | "highlight" | "pen" | "text" | "erase";
    getCurrentChapterInfo: () => { chapterTitle?: string; chapterIndex?: number };
    addAnnotation: (annotation: Annotation) => void;
    removeAnnotation: (id: string) => void;
    getBookAnnotations: (bookId: string) => Annotation[];
    updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
    lookupTerm: (term: string, language?: string) => Promise<DictionaryLookupResult | null>;
    saveVocabularyTerm: (term: VocabularyTerm) => unknown;
    installedDictionaryCount: number;
    vocabularyEnabled: boolean;
    lastCreatedHighlightRef: MutableRefObject<{
        annotationId: string;
        text: string;
        cfi: string;
        sectionIndex: number;
        timestamp: number;
    } | null>;
    debug: (...args: unknown[]) => void;
}

export function useReaderAnnotationsAndDictionary({
    activeDocId,
    readerRef,
    annotations,
    setAnnotations,
    annotationsById,
    bookmarkByLocation,
    location,
    isPdfFormat,
    pdfAnnotationMode,
    getCurrentChapterInfo,
    addAnnotation,
    removeAnnotation,
    getBookAnnotations,
    updateAnnotation,
    lookupTerm,
    saveVocabularyTerm,
    installedDictionaryCount,
    vocabularyEnabled,
    lastCreatedHighlightRef,
    debug,
}: UseReaderAnnotationsAndDictionaryParams) {
    const [showColorPicker, setShowColorPicker] = useState(false);
    const [colorPickerMode, setColorPickerMode] = useState<"actions" | "dictionary">("actions");
    const [colorPickerPosition, setColorPickerPosition] = useState<{ x: number; y: number; height?: number }>({ x: 0, y: 0 });
    const [selectedText, setSelectedText] = useState("");
    const [selectedCfi, setSelectedCfi] = useState("");
    const [activeAnnotation, setActiveAnnotation] = useState<Annotation | null>(null);
    const [editingHighlightId, setEditingHighlightId] = useState<string | null>(null);
    const [showNoteEditor, setShowNoteEditor] = useState(false);
    const [noteEditorPosition, setNoteEditorPosition] = useState({ x: 0, y: 0 });
    const [editingNote, setEditingNote] = useState("");
    const [pendingHighlightColor, setPendingHighlightColor] = useState<HighlightColor | null>(null);
    const [dictionaryLookupTerm, setDictionaryLookupTerm] = useState("");
    const [dictionaryLookupResult, setDictionaryLookupResult] = useState<DictionaryLookupResult | null>(null);
    const [dictionaryLookupError, setDictionaryLookupError] = useState<string | null>(null);
    const [dictionaryLookupLoading, setDictionaryLookupLoading] = useState(false);
    const [dictionaryLookupSaved, setDictionaryLookupSaved] = useState(false);

    const handleTextSelected = useCallback((cfi: string, text: string, rangeOrEvent?: Range | MouseEvent) => {
        debug("[Reader] Text selected:", { cfi: cfi.substring(0, 50), text: text.substring(0, 50) });

        const freshAnnotations = activeDocId ? getBookAnnotations(activeDocId) : [];
        debug("[Reader] Fresh annotations from store:", freshAnnotations.length);
        debug(
            "[Reader] Available highlight/note annotations:",
            freshAnnotations
                .filter(a => a.type === "highlight" || a.type === "note")
                .map(a => ({ id: a.id.substring(0, 8), loc: a.location?.substring(0, 40), text: a.selectedText?.substring(0, 30) })),
        );

        if (!cfi) {
            debug("[Reader] Empty CFI, ignoring");
            return;
        }

        const resolvePickerPosition = (anchor?: Range | MouseEvent) => {
            if (anchor && "getBoundingClientRect" in anchor) {
                const rangeDocument = anchor.startContainer?.ownerDocument;
                const frameElement = rangeDocument?.defaultView?.frameElement;
                const frameRect = frameElement instanceof HTMLElement
                    ? frameElement.getBoundingClientRect()
                    : null;
                const offsetX = frameRect?.left ?? 0;
                const offsetY = frameRect?.top ?? 0;

                // Rects of a selection that runs onto the next page lie outside the
                // viewport; anchor to one the reader can see.
                const rects = Array.from(anchor.getClientRects()).map((r) => ({
                    left: r.left + offsetX,
                    top: r.top + offsetY,
                    width: r.width,
                    height: r.height,
                }));
                const fallback = anchor.getBoundingClientRect();
                const targetRect = pickVisibleAnchorRect(
                    rects.length > 0 ? rects : [{
                        left: fallback.left + offsetX,
                        top: fallback.top + offsetY,
                        width: fallback.width,
                        height: fallback.height,
                    }],
                    { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
                );
                if (targetRect) {
                    return {
                        x: targetRect.left + targetRect.width / 2,
                        y: targetRect.top,
                        height: Math.max(targetRect.height, 24),
                    };
                }
            }

            if (anchor && "clientX" in anchor) {
                return {
                    x: anchor.clientX,
                    y: anchor.clientY,
                };
            }

            return {
                x: window.innerWidth / 2,
                y: window.innerHeight / 3,
            };
        };

        const existingAnnotation = findAnnotationForSelection(freshAnnotations, cfi, text);

        if (existingAnnotation) {
            debug("[Reader] ✓ Found existing annotation:", existingAnnotation.id, existingAnnotation.type, "- setting editingHighlightId");
            setActiveAnnotation(existingAnnotation);
            setEditingHighlightId(existingAnnotation.id);
            debug("[Reader] editingHighlightId set to:", existingAnnotation.id);
            setSelectedCfi(existingAnnotation.location);
            setSelectedText(existingAnnotation.selectedText || text || "");

            const pickerPosition = resolvePickerPosition(rangeOrEvent);
            debug("[Reader] Positioning color picker:", pickerPosition);
            setColorPickerPosition(pickerPosition);

            setColorPickerMode("actions");
            setDictionaryLookupTerm("");
            setDictionaryLookupResult(null);
            setDictionaryLookupError(null);
            setDictionaryLookupLoading(false);
            setDictionaryLookupSaved(false);
            setShowColorPicker(true);
        } else {
            debug("[Reader] ✗ No existing annotation found - treating as new selection");
            if (!text.trim()) {
                debug("[Reader] Empty text selection, ignoring");
                return;
            }

            setEditingHighlightId(null);
            setActiveAnnotation(null);
            setSelectedCfi(cfi);
            setSelectedText(text);

            const pickerPosition = resolvePickerPosition(rangeOrEvent);
            debug("[Reader] Positioning color picker:", pickerPosition);
            setColorPickerPosition(pickerPosition);

            setColorPickerMode("actions");
            setDictionaryLookupTerm("");
            setDictionaryLookupResult(null);
            setDictionaryLookupError(null);
            setDictionaryLookupLoading(false);
            setDictionaryLookupSaved(false);
            setShowColorPicker(true);
        }
    }, [activeDocId, debug, getBookAnnotations]);

    const handleLookupWord = useCallback(async (word: string) => {
        const term = word.trim();
        if (!term) return;

        readerRef.current?.clearSelection?.();
        if (typeof window !== "undefined") {
            window.getSelection?.()?.removeAllRanges?.();
        }

        setColorPickerMode("dictionary");
        setShowColorPicker(true);
        setDictionaryLookupTerm(term);
        setDictionaryLookupResult(null);
        setDictionaryLookupError(null);
        setDictionaryLookupSaved(false);
        setDictionaryLookupLoading(true);

        try {
            const result = await lookupTerm(term, "en");
            setDictionaryLookupResult(result);
            if (!result) {
                if (installedDictionaryCount === 0) {
                    setDictionaryLookupError(
                        "No dictionaries installed. Download one from Settings > Dictionary to look up words offline.",
                    );
                } else {
                    setDictionaryLookupError("No dictionary result found for this selection.");
                }
            }
        } catch {
            setDictionaryLookupError("Dictionary lookup failed. Install a dictionary in Settings > Dictionary.");
        } finally {
            setDictionaryLookupLoading(false);
        }
    }, [installedDictionaryCount, lookupTerm, readerRef]);

    const handleDefineSelection = useCallback(async () => {
        await handleLookupWord(selectedText);
    }, [handleLookupWord, selectedText]);

    const [pdfSelection, clearPdfSelection] = usePdfTextSelection(isPdfFormat && pdfAnnotationMode === "none");
    const handlePdfDefine = useCallback(() => {
        if (!pdfSelection) return;
        setColorPickerPosition(pdfSelection.position);
        clearPdfSelection();
        void handleLookupWord(pdfSelection.text);
    }, [pdfSelection, clearPdfSelection, handleLookupWord]);

    const handlePdfCopy = useCallback(() => {
        if (!pdfSelection) return;
        void navigator.clipboard?.writeText(pdfSelection.text).then(
            () => toast.success("Copied"),
            () => toast.error("Could not copy"),
        );
        clearPdfSelection();
    }, [pdfSelection, clearPdfSelection]);

    const closeDictionaryPicker = useCallback(() => {
        setShowColorPicker(false);
        setColorPickerMode("actions");
        setDictionaryLookupTerm("");
        setDictionaryLookupResult(null);
        setDictionaryLookupError(null);
        setDictionaryLookupLoading(false);
        setDictionaryLookupSaved(false);
    }, []);

    const handleSaveDictionaryResult = useCallback(() => {
        if (!dictionaryLookupResult || !vocabularyEnabled) {
            return;
        }

        saveVocabularyTerm(vocabularyTermFromLookup(dictionaryLookupResult));
        setDictionaryLookupSaved(true);
    }, [dictionaryLookupResult, saveVocabularyTerm, vocabularyEnabled]);

    const dictionaryView = useMemo(() => ({
        term: dictionaryLookupTerm,
        result: dictionaryLookupResult,
        loading: dictionaryLookupLoading,
        error: dictionaryLookupError,
        saved: dictionaryLookupSaved,
        canSaveToVocabulary: vocabularyEnabled,
        saveDisabledMessage: "Enable Vocabulary Builder in Settings to save terms.",
        onSave: handleSaveDictionaryResult,
        onLookupTerm: handleLookupWord,
        onBack: () => setColorPickerMode("actions"),
    }), [
        dictionaryLookupTerm,
        dictionaryLookupResult,
        dictionaryLookupLoading,
        dictionaryLookupError,
        dictionaryLookupSaved,
        vocabularyEnabled,
        handleSaveDictionaryResult,
        handleLookupWord,
    ]);

    /**
     * A selection that overlaps or touches existing highlights (e.g. the second
     * half of a sentence that runs onto the next page) extends them into ONE
     * highlight instead of creating a neighbour. The oldest keeps its id and
     * notes; the others are removed (with sync tombstones). Null when there is
     * nothing to merge with.
     */
    const mergeSelectionIntoHighlights = useCallback(async (color: HighlightColor, noteContent?: string): Promise<Annotation | null> => {
        if (!activeDocId || !selectedCfi) return null;
        const targets = findMergeTargets(getBookAnnotations(activeDocId), selectedCfi);
        if (targets.length === 0) return null;
        const locationUri = unionCfis([selectedCfi, ...targets.map(t => t.location)]);
        if (!locationUri) return null;

        const ordered = [...targets].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
        const base = ordered[0];
        const rest = ordered.slice(1);

        const resolvedText = await readerRef.current?.resolveCfiText?.(locationUri);
        const text = resolvedText
            || [selectedText, ...targets.map(t => t.selectedText ?? "")].reduce((longest, t) => t.length > longest.length ? t : longest, "");
        const notes = [...new Set([...targets.map(t => t.noteContent), noteContent]
            .filter((n): n is string => Boolean(n?.trim())))];
        const mergedNote = notes.length > 0 ? notes.join("\n\n") : undefined;

        const updated: Annotation = {
            ...base,
            location: locationUri,
            selectedText: text,
            color,
            type: mergedNote ? "note" : "highlight",
            noteContent: mergedNote,
            updatedAt: new Date(),
        };

        try {
            for (const other of rest) {
                await readerRef.current?.removeHighlight?.(other.id);
                removeAnnotation(other.id);
            }
            await readerRef.current?.removeHighlight?.(base.id);
            updateAnnotation(base.id, {
                location: locationUri,
                selectedText: text,
                color,
                type: updated.type,
                noteContent: mergedNote,
            });
            const removed = new Set(rest.map(r => r.id));
            setAnnotations(prev => prev
                .filter(a => !removed.has(a.id))
                .map(a => a.id === base.id ? updated : a));
            await readerRef.current?.addAnnotation?.(updated);
        } catch {
            return null;
        }
        return updated;
    }, [activeDocId, selectedCfi, selectedText, getBookAnnotations, readerRef, removeAnnotation, setAnnotations, updateAnnotation]);

    const handleColorSelect = useCallback(async (color: HighlightColor) => {
        if (!selectedCfi || !activeDocId) return;

        const freshAnnotations = getBookAnnotations(activeDocId);

        if (editingHighlightId) {
            const existingAnnotation = annotationsById.get(editingHighlightId) || freshAnnotations.find(a => a.id === editingHighlightId);
            if (existingAnnotation) {
                updateAnnotation(editingHighlightId, { color });
                setAnnotations(prev => prev.map(a =>
                    a.id === editingHighlightId ? { ...a, color, updatedAt: new Date() } : a
                ));

                try {
                    await readerRef.current?.removeHighlight?.(editingHighlightId);
                    const updatedAnnotation: Annotation = { ...existingAnnotation, color, updatedAt: new Date() };
                    await readerRef.current?.addAnnotation?.(updatedAnnotation);
                    debug("[Reader] Updated existing highlight color:", editingHighlightId, color);
                } catch {
                }
            }

            setShowColorPicker(false);
            setColorPickerMode("actions");
            setEditingHighlightId(null);
            setActiveAnnotation(null);
            setSelectedText("");
            setSelectedCfi("");

            readerRef.current?.clearSelection?.();
            return;
        }

        const merged = await mergeSelectionIntoHighlights(color);

        if (merged) {
            debug("[Reader] Merged selection into highlight:", merged.id);
        } else {
            try {
                const annotation = await readerRef.current?.addHighlight?.(selectedCfi, selectedText, color);
                if (annotation) {
                    const chapterInfo = getCurrentChapterInfo();
                    const annotationWithBookId: Annotation = {
                        ...annotation,
                        bookId: activeDocId,
                        referenceId: annotation.referenceId || activeDocId,
                        chapterTitle: annotation.chapterTitle || chapterInfo.chapterTitle,
                        chapterIndex: annotation.chapterIndex ?? chapterInfo.chapterIndex,
                    };

                    addAnnotation(annotationWithBookId);
                    setAnnotations(prev => [...prev, annotationWithBookId]);
                    debug("[Reader] Created new highlight:", annotationWithBookId.id);

                    lastCreatedHighlightRef.current = {
                        annotationId: annotationWithBookId.id,
                        text: selectedText,
                        cfi: selectedCfi,
                        sectionIndex: extractSectionIndex(selectedCfi) ?? -1,
                        timestamp: Date.now(),
                    };
                }
            } catch {
            }
        }

        setShowColorPicker(false);
        setColorPickerMode("actions");
        setEditingHighlightId(null);
        setActiveAnnotation(null);
        setSelectedText("");
        setSelectedCfi("");

        readerRef.current?.clearSelection?.();
    }, [selectedCfi, selectedText, activeDocId, addAnnotation, annotationsById, debug, editingHighlightId, getBookAnnotations, getCurrentChapterInfo, lastCreatedHighlightRef, mergeSelectionIntoHighlights, readerRef, setAnnotations, updateAnnotation]);

    const handleAddNote = useCallback(() => {
        if (!selectedCfi || !activeDocId) return;

        debug("[Reader] Opening note editor, editingHighlightId:", editingHighlightId, "activeAnnotation:", activeAnnotation?.id);

        setShowColorPicker(false);
        setColorPickerMode("actions");
        setNoteEditorPosition(colorPickerPosition);

        if (editingHighlightId && activeAnnotation) {
            setEditingNote(activeAnnotation.noteContent || "");
            setPendingHighlightColor(activeAnnotation.color || "yellow");
            debug("[Reader] Editing existing highlight, preserving ID:", editingHighlightId);
        } else {
            setEditingNote("");
            setPendingHighlightColor("yellow");
            debug("[Reader] Creating new highlight with note");
        }

        setShowNoteEditor(true);
    }, [selectedCfi, activeDocId, colorPickerPosition, debug, editingHighlightId, activeAnnotation]);

    const handleSaveNote = useCallback(async (noteContent: string) => {
        if (!selectedCfi || !activeDocId) return;

        let existingHighlight = editingHighlightId
            ? (annotationsById.get(editingHighlightId) ?? null)
            : null;

        if (!existingHighlight) {
            existingHighlight = findAnnotationForSelection(annotations, selectedCfi, selectedText) ?? null;
        }

        if (!existingHighlight && noteContent) {
            const merged = await mergeSelectionIntoHighlights(pendingHighlightColor ?? "yellow", noteContent);
            if (merged) {
                setShowNoteEditor(false);
                setEditingHighlightId(null);
                setActiveAnnotation(null);
                setSelectedText("");
                setSelectedCfi("");
                setEditingNote("");
                setPendingHighlightColor("yellow");
                readerRef.current?.clearSelection?.();
                return;
            }
        }

        if (existingHighlight) {
            debug("[Reader] Adding note to existing highlight:", existingHighlight.id);
            updateAnnotation(existingHighlight.id, {
                type: noteContent ? "note" : "highlight",
                noteContent: noteContent || undefined,
            });

            setAnnotations(prev => prev.map(a =>
                a.id === existingHighlight!.id
                    ? { ...a, type: noteContent ? "note" : "highlight", noteContent: noteContent || undefined, updatedAt: new Date() }
                    : a
            ));

            const updatedAnnotation: Annotation = {
                ...existingHighlight,
                type: noteContent ? "note" : "highlight",
                noteContent: noteContent || undefined,
                updatedAt: new Date(),
            };
            try {
                await readerRef.current?.removeHighlight?.(existingHighlight.id);
                await readerRef.current?.addAnnotation?.(updatedAnnotation);
                debug("[Reader] Re-rendered highlight with note in viewport");
            } catch {
            }
        } else {
            debug("[Reader] Creating new highlight with note");
            const chapterInfo = getCurrentChapterInfo();
            const annotation: Annotation = {
                id: crypto.randomUUID(),
                bookId: activeDocId,
                referenceId: activeDocId,
                type: noteContent ? "note" : "highlight",
                location: selectedCfi,
                selectedText,
                color: pendingHighlightColor ?? "yellow",
                noteContent: noteContent || undefined,
                chapterTitle: chapterInfo.chapterTitle,
                chapterIndex: chapterInfo.chapterIndex,
                createdAt: new Date(),
            };

            addAnnotation(annotation);
            setAnnotations(prev => [...prev, annotation]);

            try {
                await readerRef.current?.addAnnotation?.(annotation);
            } catch {
            }
        }

        setShowNoteEditor(false);
        setEditingHighlightId(null);
        setActiveAnnotation(null);
        setSelectedText("");
        setSelectedCfi("");
        setEditingNote("");
        setPendingHighlightColor("yellow");

        readerRef.current?.clearSelection?.();
    }, [
        selectedCfi,
        selectedText,
        activeDocId,
        annotations,
        annotationsById,
        addAnnotation,
        debug,
        editingHighlightId,
        getCurrentChapterInfo,
        pendingHighlightColor,
        readerRef,
        setAnnotations,
        updateAnnotation,
        mergeSelectionIntoHighlights,
    ]);

    const handleBookmarkFromSelection = useCallback(() => {
        if (!selectedCfi || !activeDocId) return;

        const chapterInfo = getCurrentChapterInfo();
        const annotation: Annotation = {
            id: crypto.randomUUID(),
            bookId: activeDocId,
            referenceId: activeDocId,
            type: "bookmark",
            location: selectedCfi,
            selectedText,
            chapterTitle: chapterInfo.chapterTitle,
            chapterIndex: chapterInfo.chapterIndex,
            createdAt: new Date(),
        };

        addAnnotation(annotation);
        setAnnotations(prev => [...prev, annotation]);

        setShowColorPicker(false);
        setColorPickerMode("actions");
        setSelectedText("");
        setSelectedCfi("");

        readerRef.current?.clearSelection?.();
    }, [selectedCfi, selectedText, activeDocId, addAnnotation, getCurrentChapterInfo, readerRef, setAnnotations]);

    const handleAddPageBookmark = useCallback(() => {
        if (!activeDocId || !location) return;

        const existingBookmark = bookmarkByLocation.get(location.cfi);

        if (existingBookmark) {
            removeAnnotation(existingBookmark.id);
            setAnnotations(prev => prev.filter(a => a.id !== existingBookmark.id));
        } else {
            const chapterInfo = getCurrentChapterInfo();
            const annotation: Annotation = {
                id: crypto.randomUUID(),
                bookId: activeDocId,
                referenceId: activeDocId,
                type: "bookmark",
                location: location.cfi || "",
                selectedText: location.tocItem?.label || `Page ${location.pageInfo?.currentPage || 0}`,
                chapterTitle: chapterInfo.chapterTitle,
                chapterIndex: chapterInfo.chapterIndex,
                createdAt: new Date(),
            };

            addAnnotation(annotation);
            setAnnotations(prev => [...prev, annotation]);
        }
    }, [activeDocId, location, bookmarkByLocation, addAnnotation, removeAnnotation, getCurrentChapterInfo, setAnnotations]);

    const handleDeleteFromColorPicker = useCallback(async () => {
        if (!editingHighlightId) {
            return;
        }

        debug("[Reader] Deleting highlight:", editingHighlightId);

        try {
            await readerRef.current?.removeHighlight?.(editingHighlightId);
            debug("[Reader] Successfully removed highlight from viewport");
        } catch {
        }

        removeAnnotation(editingHighlightId);

        setAnnotations(prev => prev.filter(a => a.id !== editingHighlightId));

        setShowColorPicker(false);
        setColorPickerMode("actions");
        setEditingHighlightId(null);
        setActiveAnnotation(null);
        setSelectedText("");
        setSelectedCfi("");

        readerRef.current?.clearSelection?.();
    }, [debug, editingHighlightId, readerRef, removeAnnotation, setAnnotations]);

    return {
        showColorPicker,
        setShowColorPicker,
        colorPickerMode,
        setColorPickerMode,
        colorPickerPosition,
        selectedText,
        setSelectedText,
        setSelectedCfi,
        activeAnnotation,
        setActiveAnnotation,
        editingHighlightId,
        setEditingHighlightId,
        showNoteEditor,
        setShowNoteEditor,
        noteEditorPosition,
        editingNote,
        setEditingNote,
        setDictionaryLookupTerm,
        setDictionaryLookupResult,
        setDictionaryLookupError,
        setDictionaryLookupLoading,
        setDictionaryLookupSaved,
        handleTextSelected,
        handleDefineSelection,
        pdfSelection,
        handlePdfDefine,
        handlePdfCopy,
        closeDictionaryPicker,
        dictionaryView,
        handleColorSelect,
        handleAddNote,
        handleSaveNote,
        handleBookmarkFromSelection,
        handleAddPageBookmark,
        handleDeleteFromColorPicker,
    };
}
