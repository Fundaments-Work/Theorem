import type { FootnoteData } from "./foliate-engine";

export interface FoliateSelectionHost {
    getView: () => any;
    getBook: () => any;
    getCFIFromRange: (index: number, range: Range) => string;
    pendingTimeouts: Set<number>;
    setSelectionNavLockUntil: (until: number) => void;
    getLastAnnotationActivatedAt: () => number;
    onViewportTap?: () => void;
    shouldForceViewportTap?: () => boolean;
    onFootnote?: (data: FootnoteData) => void;
}

export class FoliateSelectionController {
    private iframeListenersAttached = new WeakSet<Document>();
    private selectionCheckInterval: ReturnType<typeof setInterval> | null = null;
    private postMessageHandler: ((event: MessageEvent) => void) | null = null;
    private lastTapNotifiedAt = 0;

    constructor(private readonly host: FoliateSelectionHost) {}

    getSelectionFromDocument(): { text: string; cfi: string; range: Range } | null {
        const view = this.host.getView();
        const book = this.host.getBook();
        if (!view || !book) {
            return null;
        }

        try {
            const contents = view.renderer?.getContents?.() || [];

            for (const content of contents) {
                if (!content || typeof content.index !== "number") continue;

                const doc = content.doc;
                if (!doc) continue;

                const selection = doc.getSelection();
                if (selection && !selection.isCollapsed) {
                    const text = selection.toString().trim();
                    if (text) {
                        const range = selection.getRangeAt(0);
                        const cfi = this.host.getCFIFromRange(content.index, range);
                        if (cfi) {
                            return { text, cfi, range };
                        }
                    }
                }
            }
        } catch {
        }
        return null;
    }

    isInteractiveTapTarget(target: EventTarget | null): boolean {
        if (!(target instanceof Element)) {
            return false;
        }

        if (
            target.closest(
                'a,button,input,textarea,select,summary,label,[role="button"],[contenteditable="true"],[data-no-viewport-tap]',
            )
        ) {
            return true;
        }

        if (target instanceof SVGElement) {
            return true;
        }

        return false;
    }

    notifyViewportTap(target: EventTarget | null): void {
        if (!this.host.onViewportTap) {
            return;
        }
        // A tap that just activated a highlight must not also toggle the
        // viewport chrome / close the annotation popover it opened. The
        // highlight overlay uses pointer-events:none, so event.target cannot
        // tell us this; use the activation timestamp instead.
        if (Date.now() - this.host.getLastAnnotationActivatedAt() < 420) {
            return;
        }
        if (this.isInteractiveTapTarget(target)) {
            return;
        }
        this.lastTapNotifiedAt = Date.now();
        this.host.onViewportTap();
    }

    private shouldForceViewportTap(): boolean {
        return this.host.shouldForceViewportTap?.() ?? false;
    }

    setupIframeSelectionListener(
        callback: (cfi: string, text: string, rangeOrEvent: Range | MouseEvent) => void,
    ): void {
        const view = this.host.getView();
        if (!view?.renderer) return;

        if (!this.postMessageHandler) {
            this.postMessageHandler = (event: MessageEvent) => {
                const contents = this.host.getView()?.renderer?.getContents?.() || [];
                if (
                    event.source !== window
                    && !contents.some((c: any) => c.doc?.defaultView === event.source)
                ) {
                    return;
                }
                if (event.data?.type === "foliate-selection") {
                    const { sectionIndex, text, clientX, clientY, rect } = event.data;
                    const content = contents.find((c: any) => c.index === sectionIndex);

                    if (content?.doc) {
                        const doc = content.doc;
                        const selection = doc.getSelection();
                        const frameElement = doc.defaultView?.frameElement;
                        const frameRect = frameElement instanceof HTMLElement
                            ? frameElement.getBoundingClientRect()
                            : null;

                        if (selection && !selection.isCollapsed) {
                            try {
                                const range = selection.getRangeAt(0);
                                const cfi = this.host.getCFIFromRange(sectionIndex, range);

                                if (cfi) {
                                    try {
                                        callback(cfi, text, range.cloneRange());
                                    } catch {
                                        const syntheticEvent = new MouseEvent("mouseup", {
                                            clientX: (
                                                frameRect
                                                    ? frameRect.left + (clientX || (rect?.left + rect?.width / 2) || 0)
                                                    : (clientX || (rect?.left + rect?.width / 2) || 0)
                                            ),
                                            clientY: (
                                                frameRect
                                                    ? frameRect.top + (clientY || (rect?.top) || 0)
                                                    : (clientY || (rect?.top) || 0)
                                            ),
                                            bubbles: true,
                                        });
                                        callback(cfi, text, syntheticEvent);
                                    }
                                }
                            } catch {
                            }
                        }
                    }
                } else if (event.data?.type === "foliate-tap") {
                    const hasSelection = Boolean(event.data?.hasSelection);
                    if (hasSelection && !this.shouldForceViewportTap()) {
                        return;
                    }
                    this.notifyViewportTap(null);
                } else if (event.data?.type === "foliate-footnote") {
                    this.host.onFootnote?.({
                        text: event.data.text,
                        html: event.data.html,
                        title: event.data.title,
                        href: event.data.href,
                        rect: event.data.rect,
                    });
                }
            };

            window.addEventListener("message", this.postMessageHandler);
        }

        const contents = view.renderer.getContents?.() || [];

        for (const content of contents) {
            const doc = content.doc;
            const win = doc?.defaultView;
            if (!doc || !win) {
                continue;
            }

            if (this.iframeListenersAttached.has(doc)) {
                continue;
            }

            this.iframeListenersAttached.add(doc);

            const iframeElement = doc.defaultView?.frameElement as HTMLIFrameElement;
            if (iframeElement) {
                this.attachSelectionListenersToIframe(iframeElement, content.index, callback);
            } else {
                this.injectSelectionScript(doc, content.index);
            }
        }
    }

    private attachSelectionListenersToIframe(
        iframe: HTMLIFrameElement,
        index: number,
        callback: (cfi: string, text: string, rangeOrEvent: Range | MouseEvent) => void,
    ): void {
        try {
            const doc = iframe.contentDocument;
            const win = iframe.contentWindow;

            if (!doc || !win) {
                return;
            }

            if ((doc as any).__theorem_selection_attached) {
                return;
            }
            (doc as any).__theorem_selection_attached = true;

            if (doc.documentElement) {
                doc.documentElement.style.touchAction = "manipulation";
            }
            if (doc.body) {
                doc.body.style.touchAction = "manipulation";
            }

            let lastSelectionKey = "";
            let pointerDownX = 0;
            let pointerDownY = 0;
            let pointerDownAt = 0;
            let pointerMoved = false;
            const SELECTION_CAPTURE_DELAY = 12;
            // Native selection handles move without any DOM touch events, so on
            // touch devices a selectionchange burst is a handle drag in progress.
            // Wait for it to settle instead of re-anchoring the toolbar every frame.
            const SELECTION_SETTLE_DELAY_TOUCH = 260;
            const isCoarsePointer = (): boolean => {
                try {
                    return Boolean(win.matchMedia?.("(pointer: coarse)").matches);
                } catch {
                    return false;
                }
            };
            const SELECTION_INTERACTION_SUPPRESS_MS = 420;
            const TAP_MAX_DISTANCE = 12;
            const TAP_MAX_DURATION = 350;
            let selectionCaptureTimeout: number | null = null;
            let lastSelectionCapturedAt = 0;
            // Track whether a touch gesture is active so the selection callback
            // is deferred to touchend rather than fired on every selectionchange
            // mid-drag (which caused the toolbar to flash while extending selection).
            let isTouchActive = false;

            const getEventPoint = (event?: MouseEvent | PointerEvent | TouchEvent): { x: number; y: number } | null => {
                if (!event) {
                    return null;
                }
                if ("changedTouches" in event && event.changedTouches.length > 0) {
                    const touch = event.changedTouches[0];
                    return { x: touch.clientX, y: touch.clientY };
                }
                if ("clientX" in event && typeof event.clientX === "number") {
                    return { x: event.clientX, y: event.clientY };
                }
                return null;
            };

            const scheduleSelectionCapture = (
                event?: MouseEvent | PointerEvent | TouchEvent,
                delay: number = SELECTION_CAPTURE_DELAY,
            ) => {
                if (selectionCaptureTimeout !== null) {
                    window.clearTimeout(selectionCaptureTimeout);
                    this.host.pendingTimeouts.delete(selectionCaptureTimeout);
                }
                const timerId = window.setTimeout(() => {
                    this.host.pendingTimeouts.delete(timerId);
                    selectionCaptureTimeout = null;
                    if (!this.host.getView()) {
                        return;
                    }
                    try {
                        const selection = doc.getSelection();
                        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
                            lastSelectionKey = "";
                            return;
                        }

                        const text = selection.toString().trim();
                        if (!text) {
                            return;
                        }

                        const range = selection.getRangeAt(0);
                        const cfi = this.host.getCFIFromRange(index, range);
                        if (!cfi) {
                            return;
                        }

                        const selectionKey = `${cfi}::${text}`;
                        if (selectionKey === lastSelectionKey) {
                            return;
                        }
                        lastSelectionKey = selectionKey;

                        lastSelectionCapturedAt = Date.now();

                        this.host.setSelectionNavLockUntil(Date.now() + 2000);
                        try {
                            callback(cfi, text, range.cloneRange());
                        } catch {
                            const rect = range.getBoundingClientRect();
                            const point = getEventPoint(event) ?? {
                                x: rect.left + rect.width / 2,
                                y: rect.top,
                            };
                            const iframeRect = iframe.getBoundingClientRect();
                            const syntheticEvent = new MouseEvent("mouseup", {
                                clientX: iframeRect.left + point.x,
                                clientY: iframeRect.top + point.y,
                                bubbles: true,
                            });
                            callback(cfi, text, syntheticEvent);
                        }
                    } catch {
                    }
                }, delay);
                selectionCaptureTimeout = timerId;
                this.host.pendingTimeouts.add(timerId);
            };

            doc.addEventListener(
                "contextmenu",
                (event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                },
                true,
            );

            win.addEventListener(
                "contextmenu",
                (event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                },
                true,
            );

            const suppressDoubleTapZoom = (event: Event) => {
                event.preventDefault();
            };

            doc.addEventListener("dblclick", suppressDoubleTapZoom, true);
            win.addEventListener("dblclick", suppressDoubleTapZoom, true);

            win.addEventListener(
                "pointerdown",
                (event: PointerEvent) => {
                    if (!event.isPrimary || event.button !== 0) {
                        return;
                    }
                    pointerDownX = event.clientX;
                    pointerDownY = event.clientY;
                    pointerDownAt = Date.now();
                    pointerMoved = false;
                },
                true,
            );

            win.addEventListener(
                "pointermove",
                (event: PointerEvent) => {
                    if (pointerDownAt === 0) {
                        return;
                    }
                    const distance = Math.hypot(
                        event.clientX - pointerDownX,
                        event.clientY - pointerDownY,
                    );
                    if (distance > TAP_MAX_DISTANCE) {
                        pointerMoved = true;
                    }
                },
                true,
            );

            win.addEventListener(
                "pointercancel",
                (event: PointerEvent) => {
                    pointerDownAt = 0;
                    pointerMoved = false;
                    isTouchActive = false;
                    // On mobile (Android), long-press triggers the native selection layer
                    // and cancels DOM pointer/touch events. Process the pending selection.
                    scheduleSelectionCapture(event, 30);
                    const timerId = window.setTimeout(() => {
                        this.host.pendingTimeouts.delete(timerId);
                        scheduleSelectionCapture(undefined, 0);
                    }, 80);
                    this.host.pendingTimeouts.add(timerId);
                },
                true,
            );

            win.addEventListener(
                "touchstart",
                () => {
                    isTouchActive = true;
                },
                { capture: true, passive: true },
            );

            win.addEventListener(
                "touchend",
                (event: TouchEvent) => {
                    isTouchActive = false;
                    scheduleSelectionCapture(event);
                },
                { capture: true, passive: true },
            );

            win.addEventListener(
                "touchcancel",
                (event: TouchEvent) => {
                    isTouchActive = false;
                    pointerDownAt = 0;
                    pointerMoved = false;
                    // On mobile (Android), long-press triggers the native selection layer
                    // and dispatches touchcancel. Capture the committed single-word selection.
                    scheduleSelectionCapture(event, 30);
                    const timerId = window.setTimeout(() => {
                        this.host.pendingTimeouts.delete(timerId);
                        scheduleSelectionCapture(undefined, 0);
                    }, 80);
                    this.host.pendingTimeouts.add(timerId);
                },
                { capture: true, passive: true },
            );

            doc.addEventListener("selectionchange", () => {
                const sel = doc.getSelection();
                // Always maintain the nav lock while selection is non-empty.
                if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                    this.host.setSelectionNavLockUntil(Date.now() + 2000);
                }
                // While a touch gesture is active, defer the selection callback to
                // touchend to prevent the toolbar from flashing during drag-to-select.
                // Mouse/keyboard selections process immediately as before.
                if (isTouchActive) {
                    return;
                }
                scheduleSelectionCapture(
                    undefined,
                    isCoarsePointer() ? SELECTION_SETTLE_DELAY_TOUCH : SELECTION_CAPTURE_DELAY,
                );
            }, true);

            win.addEventListener("mouseup", (event: MouseEvent) => {
                scheduleSelectionCapture(event);
            }, true);

            win.addEventListener(
                "pointerup",
                (event: PointerEvent) => {
                    if (!event.isPrimary || event.button !== 0) {
                        pointerDownAt = 0;
                        pointerMoved = false;
                        return;
                    }

                    const elapsed = Date.now() - pointerDownAt;
                    const distance = Math.hypot(
                        event.clientX - pointerDownX,
                        event.clientY - pointerDownY,
                    );
                    const isTap =
                        pointerDownAt > 0
                        && !pointerMoved
                        && elapsed <= TAP_MAX_DURATION
                        && distance <= TAP_MAX_DISTANCE;

                    pointerDownAt = 0;
                    pointerMoved = false;
                    scheduleSelectionCapture(event);

                    if (!isTap) {
                        return;
                    }

                    const TAP_DEDUP_MS = 150;
                    if (Date.now() - this.lastTapNotifiedAt < TAP_DEDUP_MS) {
                        return;
                    }

                    const shouldSuppressInteraction =
                        Date.now() - lastSelectionCapturedAt < SELECTION_INTERACTION_SUPPRESS_MS;
                    if (shouldSuppressInteraction) {
                        return;
                    }

                    const selection = doc.getSelection();
                    const hasSelection = Boolean(
                        selection
                        && !selection.isCollapsed
                        && selection.toString().trim().length > 0,
                    );
                    if (hasSelection && !this.shouldForceViewportTap()) {
                        return;
                    }
                    this.notifyViewportTap(event.target);
                },
                true,
            );
        } catch {
        }
    }

    private injectSelectionScript(doc: Document, index: number): void {
        const script = doc.createElement("script");
        script.textContent = `
            (function() {
                let lastSelection = '';
                let pointerDownX = 0;
                let pointerDownY = 0;
                let pointerDownAt = 0;
                let pointerMoved = false;
                const SELECTION_CAPTURE_DELAY = 24;
                const TAP_MAX_DISTANCE = 12;
                const TAP_MAX_DURATION = 350;

                function postSelection(clientX, clientY) {
                    var selection = document.getSelection();
                    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
                        lastSelection = '';
                        return false;
                    }

                    var text = selection.toString().trim();
                    if (!text || text === lastSelection) {
                        return false;
                    }

                    lastSelection = text;
                    var range = selection.getRangeAt(0);
                    var rect = range.getBoundingClientRect();
                    window.parent.postMessage({
                        type: 'foliate-selection',
                        sectionIndex: ${index},
                        text: text,
                        clientX: Number.isFinite(clientX) ? clientX : rect.left + rect.width / 2,
                        clientY: Number.isFinite(clientY) ? clientY : rect.top,
                        rect: {
                            left: rect.left,
                            top: rect.top,
                            width: rect.width,
                            height: rect.height
                        }
                    }, '*');
                    return true;
                }

                document.addEventListener('pointerdown', function(e) {
                    if (!e.isPrimary || e.button !== 0) {
                        return;
                    }
                    pointerDownX = e.clientX;
                    pointerDownY = e.clientY;
                    pointerDownAt = Date.now();
                    pointerMoved = false;
                });

                document.addEventListener('pointermove', function(e) {
                    if (pointerDownAt === 0) {
                        return;
                    }
                    var distance = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);
                    if (distance > TAP_MAX_DISTANCE) {
                        pointerMoved = true;
                    }
                });

                function handleCancel(e) {
                    pointerDownAt = 0;
                    pointerMoved = false;
                    var touch = e && e.changedTouches && e.changedTouches.length > 0
                        ? e.changedTouches[0]
                        : null;
                    var clientX = touch ? touch.clientX : (e && typeof e.clientX === 'number' ? e.clientX : undefined);
                    var clientY = touch ? touch.clientY : (e && typeof e.clientY === 'number' ? e.clientY : undefined);
                    setTimeout(function() {
                        postSelection(clientX, clientY);
                    }, 30);
                    setTimeout(function() {
                        postSelection();
                    }, 80);
                }

                document.addEventListener('pointercancel', handleCancel, true);
                document.addEventListener('touchcancel', handleCancel, { passive: true });

                document.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                }, true);

                document.addEventListener('pointerup', function(e) {
                    const elapsed = Date.now() - pointerDownAt;
                    const distance = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY);
                    const isTap =
                        pointerDownAt > 0
                        && !pointerMoved
                        && elapsed <= TAP_MAX_DURATION
                        && distance <= TAP_MAX_DISTANCE;
                    pointerDownAt = 0;
                    pointerMoved = false;

                    if (isTap) {
                        var sel = document.getSelection();
                        var hasSel = Boolean(
                            sel
                            && !sel.isCollapsed
                            && sel.toString().trim().length > 0,
                        );
                        if (!hasSel) {
                            window.parent.postMessage({
                                type: 'foliate-tap',
                                sectionIndex: ${index},
                                hasSelection: false,
                            }, '*');
                            return;
                        }
                    }

                    // Check selection after a short delay
                    setTimeout(function() {
                        var hasSelection = postSelection(e.clientX, e.clientY);
                        if (isTap) {
                            window.parent.postMessage({
                                type: 'foliate-tap',
                                sectionIndex: ${index},
                                hasSelection: hasSelection,
                            }, '*');
                        }
                    }, SELECTION_CAPTURE_DELAY);
                });

                document.addEventListener('touchend', function(e) {
                    setTimeout(function() {
                        var touch = e.changedTouches && e.changedTouches.length > 0
                            ? e.changedTouches[0]
                            : null;
                        postSelection(touch ? touch.clientX : undefined, touch ? touch.clientY : undefined);
                    }, SELECTION_CAPTURE_DELAY);
                }, { passive: true });

                document.addEventListener('selectionchange', function() {
                    setTimeout(function() {
                        postSelection();
                    }, SELECTION_CAPTURE_DELAY);
                });
            })();
        `;

        if (doc.head) {
            doc.head.appendChild(script);
        } else if (doc.body) {
            doc.body.appendChild(script);
        }
    }

    clearSelection(): void {
        const view = this.host.getView();
        if (!view) return;

        try {
            const contents = view.renderer?.getContents?.() || [];
            for (const content of contents) {
                const doc = content.doc;
                if (doc) {
                    doc.getSelection()?.removeAllRanges();
                }
            }
        } catch {
        }
    }

    destroy(): void {
        if (this.selectionCheckInterval) {
            clearInterval(this.selectionCheckInterval);
            this.selectionCheckInterval = null;
        }
        if (this.postMessageHandler) {
            window.removeEventListener("message", this.postMessageHandler);
            this.postMessageHandler = null;
        }
    }
}
