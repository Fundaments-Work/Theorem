// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    Button,
    Card,
    Checkbox,
    Chip,
    ConfirmDialog,
    IconButton,
    Select,
    Switch,
    TabPanel,
    Tabs,
    TextInput,
} from "../src/ui";

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

describe("Select", () => {
    it("renders its options and reports the chosen value", () => {
        const onChange = vi.fn();
        render(
            <Select
                aria-label="Sort"
                value="title"
                onChange={onChange}
                options={[
                    { value: "title", label: "Title" },
                    { value: "author", label: "Author", disabled: true },
                ]}
            />,
        );
        const select = host.querySelector("select")!;
        expect(select.className).toContain("ui-input");
        expect([...select.options].map((o) => o.textContent)).toEqual(["Title", "Author"]);
        expect(select.options[1].disabled).toBe(true);
        act(() => {
            select.value = "author";
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(onChange).toHaveBeenCalledWith("author");
    });
});

describe("Checkbox", () => {
    it("labels the box and toggles through the label", () => {
        const onChange = vi.fn();
        render(<Checkbox label="Keep unread" onChange={onChange} />);
        const box = host.querySelector('input[type="checkbox"]')!;
        const label = host.querySelector("label")!;
        expect(box.id).toBe("checkbox-keep-unread");
        expect(label.getAttribute("for")).toBe("checkbox-keep-unread");
        expect(label.textContent).toContain("Keep unread");
        act(() => label.click());
        expect(onChange).toHaveBeenCalled();
    });
});

describe("Switch", () => {
    it("is a named switch that reports its state and flips on click", () => {
        const onChange = vi.fn();
        render(<Switch checked={false} onChange={onChange} label="Auto sync" />);
        const sw = host.querySelector('[role="switch"]')!;
        expect(sw.getAttribute("aria-checked")).toBe("false");
        expect(sw.getAttribute("aria-label")).toBe("Auto sync");
        act(() => (sw as HTMLButtonElement).click());
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it("does nothing while disabled", () => {
        const onChange = vi.fn();
        render(<Switch checked onChange={onChange} label="Off limits" disabled />);
        act(() => (host.querySelector('[role="switch"]') as HTMLButtonElement).click());
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe("Tabs", () => {
    const items = [
        { id: "highlights", label: "Highlights" },
        { id: "notes", label: "Notes", count: 3 },
    ] as const;

    it("marks the active tab and wires it to its panel", () => {
        render(
            <>
                <Tabs label="Workbench" idBase="wb" items={items} value="highlights" onChange={() => {}} />
                <TabPanel idBase="wb" tab="highlights" active><p>H</p></TabPanel>
                <TabPanel idBase="wb" tab="notes" active={false}><p>N</p></TabPanel>
            </>,
        );
        const [first, second] = [...host.querySelectorAll('[role="tab"]')];
        expect(first.getAttribute("aria-selected")).toBe("true");
        expect(second.getAttribute("aria-selected")).toBe("false");
        expect(first.getAttribute("aria-controls")).toBe("wb-panel-highlights");
        const panel = host.querySelector("#wb-panel-highlights")!;
        expect(panel.getAttribute("aria-labelledby")).toBe("wb-tab-highlights");
        expect(host.querySelector("#wb-panel-notes")!.hasAttribute("hidden")).toBe(true);
        expect(second.textContent).toContain("3");
    });

    it("moves with the arrow keys, Home and End", () => {
        const onChange = vi.fn();
        render(<Tabs label="Workbench" idBase="wb" items={items} value="highlights" onChange={onChange} />);
        const list = host.querySelector('[role="tablist"]')!;
        act(() => {
            list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        });
        expect(onChange).toHaveBeenLastCalledWith("notes");
        act(() => {
            list.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
        });
        expect(onChange).toHaveBeenLastCalledWith("highlights");
        act(() => {
            list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        });
        expect(onChange).toHaveBeenLastCalledWith("notes");
    });
});

describe("Card", () => {
    it("frames content as a section and can render as another element", () => {
        render(
            <>
                <Card>one</Card>
                <Card as="section" variant="plain" data-x="y">two</Card>
            </>,
        );
        const [a, b] = [...host.children];
        expect(a.className).toContain("ui-section");
        expect(b.tagName).toBe("SECTION");
        expect(b.className).not.toContain("ui-section");
        expect(b.getAttribute("data-x")).toBe("y");
    });
});
