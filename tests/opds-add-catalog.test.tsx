// @vitest-environment jsdom
/**
 * Adding a catalog checks the address first, so a typo or a non-OPDS server is caught with a plain
 * reason instead of becoming a source that never loads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";

const probe = vi.fn();

vi.mock("../src/core/services/OpdsService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/core/services/OpdsService")>();
    return { ...actual, OpdsService: { ...actual.OpdsService, probe: (...a: unknown[]) => probe(...a), load: vi.fn(), search: vi.fn() } };
});

import { OpdsError } from "../src/core/services/OpdsService";
import { AddCatalogModal } from "../src/features/catalogs/opds/AddCatalogModal";
import { flush, makeFeed, render, setInputValue, unmountAll } from "./helpers/opds-browser-harness";

const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement;
const btn = (text: string) => Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const typeAddress = (v: string) => setInputValue(dialog(), 'input[inputmode="url"]', v);
const submit = async () => {
    await act(async () => {
        dialog().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
};

describe("add catalog", () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => unmountAll());

    const mount = (onAdd = vi.fn(), onClose = vi.fn()) => {
        render(<AddCatalogModal isOpen onClose={onClose} onAdd={onAdd} />);
        return { onAdd, onClose };
    };

    it("will not add until the address has been checked", async () => {
        const { onAdd } = mount();
        typeAddress("books.example.org/opds");
        expect(btn("Check address")).toBeDefined();
        expect(btn("Add catalog")).toBeUndefined();
        expect(onAdd).not.toHaveBeenCalled();
    });

    it("checks the address, describes what it found, fills in the name, and adds it", async () => {
        probe.mockResolvedValue({ feed: makeFeed({ title: "Home Library", dialect: "opds2", search: { href: "x", kind: "template" }, entries: [], navigation: [{ title: "A", href: "h", rel: "subsection" }] }), finalUrl: "https://books.example.org/opds/" });
        const { onAdd, onClose } = mount();
        typeAddress("books.example.org/opds");
        await submit();
        expect(probe).toHaveBeenCalledWith("https://books.example.org/opds", undefined);
        expect(dialog().textContent).toContain("Home Library");
        expect(dialog().textContent).toContain("OPDS 2.0");
        expect(dialog().textContent).toContain("1 section");
        expect(dialog().textContent).toContain("search");
        expect((dialog().querySelector('input:not([inputmode])') as HTMLInputElement).value).toBe("Home Library");
        await submit();
        // The address saved is where the catalog really lives (after redirects), not what was typed.
        expect(onAdd).toHaveBeenCalledWith({ title: "Home Library", url: "https://books.example.org/opds/", auth: undefined });
        expect(onClose).toHaveBeenCalled();
    });

    it("defaults a LAN address to http and says what is wrong when the server is not a catalog", async () => {
        probe.mockRejectedValue(new OpdsError("unsupported", "This address is a web page and does not advertise an OPDS catalog."));
        const { onAdd } = mount();
        typeAddress("192.168.1.10:8080");
        await submit();
        expect(probe).toHaveBeenCalledWith("http://192.168.1.10:8080", undefined);
        expect(dialog().textContent).toContain("does not advertise an OPDS catalog");
        expect(btn("Add anyway")).toBeUndefined();
        expect(onAdd).not.toHaveBeenCalled();
    });

    it("reveals sign-in fields when the server asks for them, and sends them with the next check", async () => {
        probe.mockRejectedValueOnce(new OpdsError("authRequired", "This catalog requires a sign-in."));
        const { onAdd } = mount();
        typeAddress("https://lib.example/opds");
        await submit();
        expect(dialog().textContent).toContain("asks for a sign-in");
        setInputValue(dialog(), 'input[autocomplete="username"]', "reader");
        setInputValue(dialog(), 'input[autocomplete="current-password"]', "pw");
        probe.mockResolvedValueOnce({ feed: makeFeed({ title: "Private" }), finalUrl: "https://lib.example/opds" });
        await submit();
        expect(probe).toHaveBeenLastCalledWith("https://lib.example/opds", { username: "reader", password: "pw" });
        await submit();
        expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ auth: { username: "reader", password: "pw" } }));
    });

    it("says when the sign-in details were not accepted", async () => {
        probe.mockRejectedValue(new OpdsError("authRequired", "needs login"));
        mount();
        typeAddress("https://lib.example/opds");
        await submit();
        setInputValue(dialog(), 'input[autocomplete="username"]', "reader");
        await submit();
        expect(dialog().textContent).toContain("not accepted");
    });

    it("lets you save a catalog that is only offline right now, but not one that is simply wrong", async () => {
        probe.mockRejectedValue(new OpdsError("network", "Could not reach the catalog."));
        const { onAdd } = mount();
        typeAddress("nas.local/opds");
        await submit();
        expect(dialog().textContent).toContain("Could not reach the catalog");
        act(() => btn("Add anyway")!.click());
        expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ url: "http://nas.local/opds", title: "nas.local" }));
    });

    it("forgets a result when the address is edited", async () => {
        probe.mockResolvedValue({ feed: makeFeed({ title: "Home" }), finalUrl: "https://a.example/opds" });
        mount();
        typeAddress("a.example/opds");
        await submit();
        expect(btn("Add catalog")).toBeDefined();
        typeAddress("b.example/opds");
        await flush();
        expect(btn("Add catalog")).toBeUndefined();
        expect(btn("Check address")).toBeDefined();
    });

    it("cannot be submitted empty", async () => {
        mount();
        expect(btn("Check address")!.disabled).toBe(true);
    });
});
