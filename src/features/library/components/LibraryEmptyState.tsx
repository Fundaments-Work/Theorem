import { BookOpen, Compass, FolderOpen, Loader2, Plus, RefreshCw } from "lucide-react";
import { cn } from "../../../core/lib/utils";
import { Button } from "../../../ui";

export function EmptyLibrary({
    onAddBooks,
    onScanFolder,
    onBrowseDiscover,
    isImporting,
    isScanning,
}: {
    onAddBooks: () => void;
    onScanFolder?: () => void;
    onBrowseDiscover: () => void;
    isImporting: boolean;
    isScanning: boolean;
}) {
    return (
        <div className="mx-auto w-full max-w-[26rem] min-w-0 px-4 sm:px-6 flex flex-col items-center justify-center py-24 text-center animate-fade-in">
            <div className="w-16 h-16 bg-[var(--color-surface-muted)] flex items-center justify-center mb-6">
                <BookOpen className="w-6 h-6 text-[color:var(--color-text-secondary)]" />
            </div>
            <h2 className="w-full break-words text-balance text-lg text-[color:var(--color-text-primary)] mb-2">
                No Books Yet
            </h2>
            <p className="mx-auto w-full max-w-[24rem] break-words text-[color:var(--color-text-muted)] mb-8 text-sm leading-relaxed">
                Add EPUB, PDF, MOBI, FB2 or comic files from this device, or find free books in Discover.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
                <Button variant="primary"
                    onClick={onAddBooks}
                    disabled={isImporting}
                    className={cn("min-w-[10.5rem] whitespace-nowrap px-6 py-2.5")}
                >
                    {isImporting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <Plus className="w-4 h-4" />
                    )}
                    <span>{isImporting ? "Importing..." : "Import Books"}</span>
                </Button>

                {onScanFolder && (
                    <Button
                        onClick={onScanFolder}
                        disabled={isScanning}
                        className={cn("min-w-[10.5rem] whitespace-nowrap px-6 py-2.5")}
                    >
                        {isScanning ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                            <FolderOpen className="w-4 h-4" />
                        )}
                        <span>{isScanning ? "Scanning..." : "Scan Folder"}</span>
                    </Button>
                )}
            </div>
            <button
                type="button"
                onClick={onBrowseDiscover}
                className="mt-6 inline-flex items-center gap-2 text-sm text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-accent)] transition-colors"
            >
                <Compass className="w-4 h-4" />
                Browse free books in Discover
            </button>
        </div>
    );
}

export function ImportButton({
    onImport,
    isLoading,
}: {
    onImport: () => void;
    isLoading: boolean;
}) {
    return (
        <Button variant="primary"
            onClick={onImport}
            disabled={isLoading}
            className={cn("h-11 px-3.5 sm:h-10 sm:px-4")}
        >
            {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
                <Plus className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">Add Books</span>
            <span className="sm:hidden">Add</span>
        </Button>
    );
}
