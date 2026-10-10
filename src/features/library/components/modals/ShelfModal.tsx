import type { SmartShelfDefinition, SmartShelfRule } from "../../../../core/types";
import { isTauri } from "../../../../core/lib/env";
import { useState, useEffect } from "react";
import { cn } from "../../../../core/lib/utils";
import { Modal, ModalBody, ModalFooter } from "../../../../ui";

interface ShelfModalProps {
    isOpen: boolean;
    shelf?: {
        id: string;
        name: string;
        description?: string;
        smartRules?: SmartShelfDefinition;
    };
    onClose: () => void;
    onSave: (name: string, description: string, smartRules?: SmartShelfDefinition) => void;
}

export function ShelfModal({ isOpen, shelf, onClose, onSave }: ShelfModalProps) {
    const [name, setName] = useState(shelf?.name || "");
    const [description, setDescription] = useState(shelf?.description || "");
    const isEditing = !!shelf;
    const [smart, setSmart] = useState(false);
    const [mode, setMode] = useState<"all" | "any">("all");
    const [conditions, setConditions] = useState<SmartShelfRule[]>([{ field: "tag", operator: "equals", value: "" }]);
    const valid = !smart || (conditions.length > 0 && conditions.every((rule) => rule.value.trim().length > 0 && rule.value.trim().length <= 256));
    const save = () => {
        if (name.trim() && valid) onSave(name.trim(), description.trim(), smart ? { mode, conditions: conditions.map((rule) => ({ ...rule, value: rule.value.trim() })) } : undefined);
    };
    const changeRule = (index: number, updates: Partial<SmartShelfRule>) => setConditions((rules) => rules.map((rule, i) => i === index ? { ...rule, ...updates } : rule));

    useEffect(() => {
        if (isOpen) {
            setName(shelf?.name || "");
            setDescription(shelf?.description || "");
            setSmart(!!shelf?.smartRules);
            setMode(shelf?.smartRules?.mode ?? "all");
            setConditions(shelf?.smartRules?.conditions.map((rule) => ({ ...rule })) ?? [{ field: "tag", operator: "equals", value: "" }]);
        }
    }, [isOpen, shelf]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        save();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md" showCloseButton={true}>
            <form onSubmit={handleSubmit}>
                <ModalBody>
                    <div className="space-y-4">
                        <div>
                            <label htmlFor="shelf-name" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                Name
                            </label>
                            <input
                                id="shelf-name"
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="e.g., To Read, Favorites, Sci-Fi"
                                className="ui-input"
                                autoFocus
                            />
                        </div>
                        <div>
                            <label htmlFor="shelf-description" className="block text-sm font-medium text-[color:var(--color-text-primary)] mb-1.5">
                                Description <span className="text-[color:var(--color-text-muted)] font-normal">(optional)</span>
                            </label>
                            <textarea
                                id="shelf-description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="Add a description for this shelf..."
                                className={cn(
                                    "ui-input",
                                    "resize-none min-h-[calc(var(--control-height-md)_*_2.1)]"
                                )}
                                rows={3}
                            />
                        </div>
                        <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={smart} disabled={!isTauri() && !smart} onChange={(event) => setSmart(event.target.checked)} />
                                Smart shelf
                            </label>
                            <p className="text-sm text-[color:var(--color-text-muted)]">Books automatically join or leave as their metadata and reading status change.</p>
                            {!isTauri() && <p className="text-sm">Smart shelves require the desktop or Android app.</p>}
                            {smart && <>
                                <label className="block text-sm">Match
                                    <select aria-label="Rule matching" value={mode} onChange={(event) => setMode(event.target.value as "all" | "any")} className="ui-input">
                                        <option value="all">All rules</option><option value="any">Any rule</option>
                                    </select>
                                </label>
                                {conditions.map((rule, index) => {
                                    const options = rule.field === "format" ? ["epub", "pdf", "mobi", "azw", "azw3", "fb2", "cbz", "cbr"]
                                        : rule.field === "status" ? ["unread", "reading", "completed"]
                                        : rule.field === "favorite" ? ["true", "false"] : null;
                                    return <div key={index} className="grid grid-cols-1 gap-2 border border-[var(--color-border)] p-3 sm:grid-cols-2">
                                        <select aria-label={`Rule ${index + 1} field`} value={rule.field} className="ui-input"
                                            onChange={(event) => {
                                                const field = event.target.value as SmartShelfRule["field"];
                                                changeRule(index, { field, operator: "equals", value: field === "status" ? "unread" : field === "format" ? "epub" : field === "favorite" ? "true" : "" });
                                            }}>
                                            <option value="tag">Tag</option><option value="category">Category</option><option value="author">Author</option>
                                            <option value="series">Series</option><option value="format">Format</option><option value="status">Reading status</option><option value="favorite">Favorite</option>
                                        </select>
                                        <select aria-label={`Rule ${index + 1} operator`} value={rule.operator} className="ui-input" disabled={!!options}
                                            onChange={(event) => changeRule(index, { operator: event.target.value as SmartShelfRule["operator"] })}>
                                            <option value="equals">Equals</option>{!options && <option value="contains">Contains</option>}
                                        </select>
                                        {options ? <select aria-label={`Rule ${index + 1} value`} value={rule.value} className="ui-input"
                                            onChange={(event) => changeRule(index, { value: event.target.value })}>
                                            {options.map((value) => <option key={value} value={value}>{rule.field === "favorite" ? value === "true" ? "Yes" : "No" : value}</option>)}
                                        </select> : <input aria-label={`Rule ${index + 1} value`} className="ui-input" value={rule.value} maxLength={256}
                                            placeholder="Value" onChange={(event) => changeRule(index, { value: event.target.value })} />}
                                        <button type="button" className="ui-btn-ghost" disabled={conditions.length === 1}
                                            onClick={() => setConditions((rules) => rules.filter((_, i) => i !== index))}>Remove rule {index + 1}</button>
                                    </div>;
                                })}
                                <button type="button" className="ui-btn-ghost" disabled={conditions.length >= 32}
                                    onClick={() => setConditions((rules) => [...rules, { field: "tag", operator: "equals", value: "" }])}>Add rule</button>
                            </>}
                        </div>
                    </div>
                </ModalBody>
                <ModalFooter>
                    <button
                        type="button"
                        onClick={onClose}
                        className="ui-btn-ghost"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!name.trim() || !valid}
                        className={cn(
                            "ui-btn-primary",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                        )}
                    >
                        {isEditing ? "Save Changes" : "Create Shelf"}
                    </button>
                </ModalFooter>
            </form>
        </Modal>
    );
}
