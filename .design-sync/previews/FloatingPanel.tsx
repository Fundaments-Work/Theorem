import { FloatingPanel } from 'theorem';

export function TopRight() {
    return (
        <div style={{ position: 'relative', width: '100%', height: 260 }}>
            <FloatingPanel visible anchor="top-right">
                <div style={{ padding: 16, minWidth: 220 }}>
                    <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-primary)' }}>
                        Font size, theme, and margins for the current book.
                    </p>
                </div>
            </FloatingPanel>
        </div>
    );
}

export function Bottom() {
    return (
        <div style={{ position: 'relative', width: '100%', height: 260 }}>
            <FloatingPanel visible anchor="bottom">
                <div style={{ padding: 16, minWidth: 220 }}>
                    <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-primary)' }}>
                        Highlight color picker, anchored to the bottom on mobile.
                    </p>
                </div>
            </FloatingPanel>
        </div>
    );
}
