// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button, Chip, IconButton, TextInput, ConfirmDialog } from "../src/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
});

const render = (node: React.ReactNode) => act(() => root.render(node));

describe("Button", () => {
    it("maps each variant onto its design-token class", () => {
        render(
            <>
                <Button>a</Button>
                <Button variant="primary">b</Button>
                <Button variant="ghost">c</Button>
                <Button variant="danger">d</Button>
            </>,
        );
        const classes = [...host.querySelectorAll("button")].map((b) => b.className);
        expect(classes[0]).toContain("ui-btn");
        expect(classes[1]).toContain("ui-btn-primary");
        expect(classes[2]).toContain("ui-btn-ghost");
        expect(classes[3]).toContain("ui-btn-danger");
    });

    it("never submits a surrounding form unless asked to", () => {
        const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
        render(
            <form onSubmit={onSubmit}>
                <Button>plain</Button>
                <Button type="submit">send</Button>
            </form>,
        );
        const [plain, send] = [...host.querySelectorAll("button")];
        expect(plain.type).toBe("button");
        act(() => plain.click());
        expect(onSubmit).not.toHaveBeenCalled();
        act(() => send.click());
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("lets a caller add classes and does not click while disabled", () => {
        const onClick = vi.fn();
        render(<Button className="w-full" disabled onClick={onClick}>x</Button>);
        const b = host.querySelector("button")!;
        expect(b.className).toContain("w-full");
        act(() => b.click());
        expect(onClick).not.toHaveBeenCalled();
    });
});

describe("IconButton", () => {
    it("is named by its label, both for screen readers and as a tooltip", () => {
        render(<IconButton label="Search" icon={<svg />} />);
        const b = host.querySelector("button")!;
        expect(b.getAttribute("aria-label")).toBe("Search");
        expect(b.title).toBe("Search");
        expect(b.className).toContain("ui-icon-btn");
        expect(b.type).toBe("button");
    });
});

describe("Chip", () => {
    it("reports its selected state through aria-pressed", () => {
        render(
            <>
                <Chip active>on</Chip>
                <Chip>off</Chip>
            </>,
        );
        const [on, off] = [...host.querySelectorAll("button")];
        expect(on.getAttribute("aria-pressed")).toBe("true");
        expect(off.getAttribute("aria-pressed")).toBe("false");
    });
});

describe("TextInput", () => {
    it("is a ui-input text field that forwards native props", () => {
        render(<TextInput aria-label="Title" placeholder="Title" className="mt-2" />);
        const i = host.querySelector("input")!;
        expect(i.type).toBe("text");
        expect(i.className).toContain("ui-input");
        expect(i.className).toContain("mt-2");
        expect(i.getAttribute("aria-label")).toBe("Title");
    });
});

describe("ConfirmDialog (built on Button)", () => {
    it("confirms and cancels through its two buttons, and styles a danger confirm as danger", () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        render(
            <ConfirmDialog
                isOpen
                title="Delete"
                message="Sure?"
                variant="danger"
                confirmLabel="Delete it"
                onConfirm={onConfirm}
                onCancel={onCancel}
            />,
        );
        const buttons = [...document.body.querySelectorAll("button")];
        const confirm = buttons.find((b) => b.textContent === "Delete it")!;
        const cancel = buttons.find((b) => b.textContent === "Cancel")!;
        expect(confirm.className).toContain("ui-btn-danger");
        expect(cancel.className).toContain("ui-btn-ghost");
        act(() => confirm.click());
        expect(onConfirm).toHaveBeenCalledTimes(1);
        act(() => cancel.click());
        expect(onCancel).toHaveBeenCalledTimes(1);
    });
});
