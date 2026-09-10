import { Backdrop } from 'theorem';

export function Default() {
    return (
        <div style={{ position: 'relative', width: '100%', height: 220, background: 'var(--color-surface-elevated)' }}>
            <Backdrop visible />
        </div>
    );
}

export function Blurred() {
    return (
        <div style={{ position: 'relative', width: '100%', height: 220, background: 'var(--color-surface-elevated)' }}>
            <Backdrop visible blur />
        </div>
    );
}
