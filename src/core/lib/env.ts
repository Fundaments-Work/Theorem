
import { useEffect, useRef } from 'react';

export function isTauri(): boolean {
    return typeof window !== 'undefined' && (
        !!(window as any).__TAURI_INTERNALS__ ||
        !!(window as any).__TAURI__ ||
        !!(window as any).__TAURI_IPC__
    );
}

export function isMobile(): boolean {
    if (typeof window === 'undefined') return false;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
    );
}

export function isTauriMobile(): boolean {
    return isTauri() && isMobile();
}

export function isTauriDesktop(): boolean {
    return isTauri() && !isMobile();
}

export function isAndroid(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /Android/i.test(navigator.userAgent);
}

export function isWebKitBrowserEngine(): boolean {
    if (typeof navigator === 'undefined') return false;

    const userAgent = navigator.userAgent;
    const isWebKit = /AppleWebKit/i.test(userAgent);
    const isChromiumBased = /Chrome|Chromium|CriOS|Edg\//i.test(userAgent);
    const isFirefoxBased = /Firefox|FxiOS/i.test(userAgent);

    return isWebKit && !isChromiumBased && !isFirefoxBased;
}

export function isTouchDevice(): boolean {
    if (typeof window === 'undefined') return false;
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

import { registerBackHandler } from './back-navigation';

export function useAndroidBackButton(handler: () => boolean) {
    const handlerRef = useRef(handler);

    useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);

    useEffect(() => {
        return registerBackHandler(() => handlerRef.current());
    }, []); 
}
