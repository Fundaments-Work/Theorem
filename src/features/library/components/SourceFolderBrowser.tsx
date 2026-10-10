import type { buildSourceFolderIndex, SourceFolderSelection } from "../../../core/lib/source-folders";

export function SourceFolderBrowser({ index, selected, onSelect }: {
    index: ReturnType<typeof buildSourceFolderIndex>;
    selected: SourceFolderSelection | null;
    onSelect: (folder: SourceFolderSelection | null) => void;
}) {
    if (!index.size) return null;
    const root = selected ? index.get(selected.root) : undefined;
    const prefix = selected?.path ? `${selected.path}/` : "";
    const children = root ? [...root.folders.keys()].filter((path) => path && path.startsWith(prefix)
        && !path.slice(prefix.length).includes("/")).sort((a, b) => a.localeCompare(b)) : [];
    const parts = selected?.path.split("/").filter(Boolean) ?? [];
    return (
        <nav aria-label="Source folders" className="my-4 space-y-2 text-sm">
            <label className="flex items-center gap-3">
                <span className="font-medium">Source folders</span>
                <select className="ui-input min-w-0 flex-1" value={selected?.root ?? ""}
                    onChange={(event) => onSelect(event.target.value ? { root: event.target.value, path: "" } : null)}>
                    <option value="">All library books</option>
                    {[...index].map(([key, value]) => <option key={key} value={key}>{value.name} — {key}</option>)}
                </select>
            </label>
            {root && selected && <>
                <div className="flex flex-wrap items-center gap-2" aria-label="Folder breadcrumb">
                    <button className="hover:underline" onClick={() => onSelect({ root: selected.root, path: "" })}>{root.name}</button>
                    {parts.map((part, i) => <span key={i} className="flex gap-2"><span aria-hidden="true">/</span>
                        <button className="hover:underline" onClick={() => onSelect({ root: selected.root, path: parts.slice(0, i + 1).join("/") })}>{part}</button>
                    </span>)}
                    <span className="text-[color:var(--color-text-secondary)]">(including subfolders)</span>
                </div>
                {children.length > 0 && <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto">
                    {children.map((path) => <button key={path} className="ui-btn text-sm" onClick={() => onSelect({ root: selected.root, path })}>
                        {path.slice(prefix.length)} <span className="text-[color:var(--color-text-secondary)]">({root.folders.get(path)?.size})</span>
                    </button>)}
                </div>}
            </>}
        </nav>
    );
}
