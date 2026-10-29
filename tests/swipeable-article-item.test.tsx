// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { render, flush, unmountAll } from "./helpers/opds-browser-harness";
import { SwipeableArticleItem } from "../src/features/feeds/components/SwipeableArticleItem";

function pointerDown(el: HTMLElement, opts: { clientX: number; clientY: number; pointerId?: number }) {
    act(() => {
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, isPrimary: true, pointerId: opts.pointerId ?? 1, ...opts }));
    });
}

function pointerMove(el: HTMLElement, opts: { clientX: number; clientY: number; pointerId?: number }) {
    act(() => {
        el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, isPrimary: true, pointerId: opts.pointerId ?? 1, ...opts }));
    });
}

function pointerUp(el: HTMLElement, opts: { clientX: number; clientY: number; pointerId?: number }) {
    act(() => {
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, isPrimary: true, pointerId: opts.pointerId ?? 1, ...opts }));
    });
}

describe("SwipeableArticleItem", () => {
    afterEach(() => {
        unmountAll();
        vi.useRealTimers();
    });

    it("renders children without crashing", () => {
        const root = render(
            <SwipeableArticleItem>
                <div data-testid="card-content">Article Headline</div>
            </SwipeableArticleItem>
        );

        expect(root.textContent).toContain("Article Headline");
    });

    it("triggers onSwipeRight when swiped past threshold to the right", () => {
        const onSwipeRight = vi.fn();
        const onSwipeLeft = vi.fn();

        const root = render(
            <SwipeableArticleItem
                onSwipeRight={onSwipeRight}
                onSwipeLeft={onSwipeLeft}
                threshold={50}
            >
                <div>Article Headline</div>
            </SwipeableArticleItem>
        );

        const target = root.firstElementChild as HTMLElement;

        pointerDown(target, { clientX: 100, clientY: 100 });
        pointerMove(target, { clientX: 180, clientY: 102 });
        pointerUp(target, { clientX: 180, clientY: 102 });

        expect(onSwipeRight).toHaveBeenCalledTimes(1);
        expect(onSwipeLeft).not.toHaveBeenCalled();
    });

    it("triggers onSwipeLeft when swiped past threshold to the left", () => {
        vi.useFakeTimers();
        const onSwipeRight = vi.fn();
        const onSwipeLeft = vi.fn();

        const root = render(
            <SwipeableArticleItem
                onSwipeRight={onSwipeRight}
                onSwipeLeft={onSwipeLeft}
                threshold={50}
            >
                <div>Article Headline</div>
            </SwipeableArticleItem>
        );

        const target = root.firstElementChild as HTMLElement;

        pointerDown(target, { clientX: 200, clientY: 100 });
        pointerMove(target, { clientX: 120, clientY: 101 });
        pointerUp(target, { clientX: 120, clientY: 101 });

        act(() => {
            vi.advanceTimersByTime(250);
        });

        expect(onSwipeLeft).toHaveBeenCalledTimes(1);
        expect(onSwipeRight).not.toHaveBeenCalled();
    });

    it("does not trigger swipe when displacement is below threshold", () => {
        const onSwipeRight = vi.fn();
        const onSwipeLeft = vi.fn();

        const root = render(
            <SwipeableArticleItem
                onSwipeRight={onSwipeRight}
                onSwipeLeft={onSwipeLeft}
                threshold={50}
            >
                <div>Article Headline</div>
            </SwipeableArticleItem>
        );

        const target = root.firstElementChild as HTMLElement;

        pointerDown(target, { clientX: 100, clientY: 100 });
        pointerMove(target, { clientX: 120, clientY: 100 });
        pointerUp(target, { clientX: 120, clientY: 100 });

        expect(onSwipeRight).not.toHaveBeenCalled();
        expect(onSwipeLeft).not.toHaveBeenCalled();
    });

    it("locks to vertical scrolling and ignores horizontal swipe if vertical displacement dominates", () => {
        const onSwipeRight = vi.fn();
        const onSwipeLeft = vi.fn();

        const root = render(
            <SwipeableArticleItem
                onSwipeRight={onSwipeRight}
                onSwipeLeft={onSwipeLeft}
                threshold={50}
            >
                <div>Article Headline</div>
            </SwipeableArticleItem>
        );

        const target = root.firstElementChild as HTMLElement;

        pointerDown(target, { clientX: 100, clientY: 100 });
        pointerMove(target, { clientX: 105, clientY: 130 });
        pointerMove(target, { clientX: 200, clientY: 150 });
        pointerUp(target, { clientX: 200, clientY: 150 });

        expect(onSwipeRight).not.toHaveBeenCalled();
        expect(onSwipeLeft).not.toHaveBeenCalled();
    });

    it("does not start drag when clicking interactive button elements", () => {
        const onSwipeRight = vi.fn();

        const root = render(
            <SwipeableArticleItem onSwipeRight={onSwipeRight} threshold={50}>
                <div>
                    <button type="button" id="interactive-btn">Action Button</button>
                </div>
            </SwipeableArticleItem>
        );

        const btn = root.querySelector("#interactive-btn") as HTMLElement;

        pointerDown(btn, { clientX: 100, clientY: 100 });
        pointerMove(btn, { clientX: 200, clientY: 100 });
        pointerUp(btn, { clientX: 200, clientY: 100 });

        expect(onSwipeRight).not.toHaveBeenCalled();
    });

    it("does not trigger swipe actions when disabled", () => {
        const onSwipeRight = vi.fn();

        const root = render(
            <SwipeableArticleItem onSwipeRight={onSwipeRight} threshold={50} disabled>
                <div>Disabled Item</div>
            </SwipeableArticleItem>
        );

        const target = root.firstElementChild as HTMLElement;

        pointerDown(target, { clientX: 100, clientY: 100 });
        pointerMove(target, { clientX: 200, clientY: 100 });
        pointerUp(target, { clientX: 200, clientY: 100 });

        expect(onSwipeRight).not.toHaveBeenCalled();
    });
});
