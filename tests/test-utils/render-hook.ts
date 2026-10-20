import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Minimal renderHook: mounts a component that runs `hook`, returns the latest result and unmount. */
export function renderHook<T>(hook: () => T) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const result: { current: T | undefined } = { current: undefined };
    function Probe() {
        result.current = hook();
        return null;
    }
    act(() => {
        root.render(createElement(Probe));
    });
    return {
        result,
        unmount: () => {
            act(() => root.unmount());
            container.remove();
        },
    };
}
