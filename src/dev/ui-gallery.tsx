/**
 * UI gallery: every shared primitive and design token on one page, with no Tauri and no app
 * state. Run `pnpm dev` and open http://localhost:1420/ui-gallery.html.
 *
 * It is a separate Vite entry, so `pnpm build` (which builds only index.html) never ships it.
 * Add a section here whenever you add a component to `src/ui`; the page is also what a
 * reviewer opens to check a change against the design system in both themes.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Search, Trash2 } from "lucide-react";
import "../index.css";
import { applyAppTheme, DEFAULT_ACCENT_COLOR } from "../core/lib/design-tokens";
import {
    AlertDialog,
    Button,
    Chip,
    ConfirmDialog,
    Dropdown,
    IconButton,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Spinner,
    TextInput,
    TheoremBookCover,
} from "../ui";

const COLOR_TOKENS = [
    "--color-background",
    "--color-surface",
    "--color-surface-muted",
    "--color-surface-variant",
    "--color-text-primary",
    "--color-text-secondary",
    "--color-text-muted",
    "--color-border",
    "--color-border-strong",
    "--color-accent",
    "--color-accent-contrast",
    "--color-success",
    "--color-warning",
    "--color-error",
] as const;

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
    return (
        <section className="ui-section p-4 sm:p-6">
            <h2 className="ui-page-title !text-base">{title}</h2>
            {note && <p className="mt-1 mb-4 text-xs text-[color:var(--color-text-muted)]">{note}</p>}
            <div className="mt-4 flex flex-wrap items-start gap-3">{children}</div>
        </section>
    );
}

function Gallery() {
    const [theme, setTheme] = useState<"dark" | "light">("dark");
    const [chip, setChip] = useState("all");
    const [sort, setSort] = useState("title");
    const [modal, setModal] = useState<"none" | "modal" | "confirm" | "alert">("none");

    useEffect(() => {
        applyAppTheme(theme, DEFAULT_ACCENT_COLOR);
    }, [theme]);

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4 sm:p-8">
            <header className="flex items-center justify-between gap-4">
                <h1 className="ui-page-title">UI gallery</h1>
                <Button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                    Theme: {theme}
                </Button>
            </header>

            <Section title="Colour tokens" note="Use these through var(--color-...). Never a raw hex.">
                {COLOR_TOKENS.map((token) => (
                    <div key={token} className="w-36">
                        <div className="h-10 border border-[var(--color-border)]" style={{ background: `var(${token})` }} />
                        <code className="mt-1 block break-all text-[10px] text-[color:var(--color-text-muted)]">{token}</code>
                    </div>
                ))}
            </Section>

            <Section title="Button" note="One primary action per screen. Variants: default, primary, ghost, danger.">
                <Button>Default</Button>
                <Button variant="primary">Primary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger">Danger</Button>
                <Button disabled>Disabled</Button>
            </Section>

            <Section title="IconButton" note="Bare icon. Hover is the accent colour, never a background. `label` is required.">
                <IconButton label="Search" icon={<Search className="h-4 w-4" />} />
                <IconButton label="Delete" icon={<Trash2 className="h-4 w-4" />} />
                <IconButton label="Disabled" disabled icon={<Search className="h-4 w-4" />} />
            </Section>

            <Section title="Chip" note="Selected is a tonal step with an accent rule, not a lime fill.">
                {["all", "unread", "finished"].map((id) => (
                    <Chip key={id} active={chip === id} onClick={() => setChip(id)} className="!w-auto">
                        {id}
                    </Chip>
                ))}
            </Section>

            <Section title="TextInput" note="The border clears 3:1 contrast on purpose. Always give it a label.">
                <div className="w-64">
                    <TextInput aria-label="Title" placeholder="Title" />
                </div>
                <div className="w-64">
                    <TextInput aria-label="Disabled" placeholder="Disabled" disabled />
                </div>
            </Section>

            <Section title="Dropdown">
                <div className="w-48">
                    <Dropdown
                        value={sort}
                        onChange={setSort}
                        options={[
                            { value: "title", label: "Title" },
                            { value: "author", label: "Author" },
                            { value: "lastRead", label: "Last read" },
                        ]}
                    />
                </div>
            </Section>

            <Section title="Dialogs">
                <Button onClick={() => setModal("modal")}>Modal</Button>
                <Button onClick={() => setModal("confirm")}>ConfirmDialog</Button>
                <Button onClick={() => setModal("alert")}>AlertDialog</Button>
            </Section>

            <Section title="Spinner">
                <Spinner size="sm" />
                <Spinner />
                <Spinner size="lg" tone="accent" />
            </Section>

            <Section title="TheoremBookCover" note="The deterministic fallback cover for books without artwork.">
                <TheoremBookCover title="Children of Dune" author="Frank Herbert" className="h-40 w-28" />
                <TheoremBookCover title="A very long book title that has to truncate somewhere" className="h-40 w-28" />
            </Section>

            <Modal isOpen={modal === "modal"} onClose={() => setModal("none")} size="sm">
                <ModalHeader title="Modal" onClose={() => setModal("none")} />
                <ModalBody>
                    <p className="text-sm text-[color:var(--color-text-secondary)]">Header, body and footer.</p>
                </ModalBody>
                <ModalFooter>
                    <Button variant="primary" onClick={() => setModal("none")}>Done</Button>
                </ModalFooter>
            </Modal>
            <ConfirmDialog
                isOpen={modal === "confirm"}
                title="Delete book"
                message="This cannot be undone."
                variant="danger"
                confirmLabel="Delete"
                onConfirm={() => setModal("none")}
                onCancel={() => setModal("none")}
            />
            <AlertDialog
                isOpen={modal === "alert"}
                title="Heads up"
                message="Something worth knowing."
                onClose={() => setModal("none")}
            />
        </div>
    );
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Gallery />
    </StrictMode>,
);
