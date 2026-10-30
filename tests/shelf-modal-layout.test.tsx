// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShelfModal } from "../src/features/library/components/modals/ShelfModal";

describe("ShelfModal layout", () => {
    let root: Root | null = null;
    let host: HTMLDivElement | null = null;

    beforeEach(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(() => {
        if (root && host) {
            act(() => root?.unmount());
            host?.remove();
        }
        root = null;
        host = null;
        document.body.className = "";
        document.querySelectorAll('[role="dialog"], [data-portal], .fixed').forEach((el) => el.remove());
    });

        it("renders form as flex flex-col container enclosing header, body and footer", () => {
            const onClose = vi.fn();
            const onSave = vi.fn();

            act(() => {
                root?.render(
                    <ShelfModal
                        isOpen={true}
                        onClose={onClose}
                        onSave={onSave}
                    />,
                );
            });

            const form = document.body.querySelector("form");
            expect(form).not.toBeNull();
            expect(form?.className).toContain("flex");
            expect(form?.className).toContain("flex-col");
            expect(form?.className).toContain("min-h-0");
            expect(form?.className).toContain("flex-1");

            // Verify body is inside form and has flex-1 overflow-y-auto
            const body = form?.querySelector(".overflow-y-auto");
            expect(body).not.toBeNull();
            expect(body?.className).toContain("flex-1");

            const saveBtn = form?.querySelector('button[type="submit"]');
            expect(saveBtn).not.toBeNull();
        });
});
