import { Spinner } from 'theorem';

export function Default() {
    return <Spinner />;
}

export function Sizes() {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <Spinner size="sm" />
            <Spinner size="md" />
            <Spinner size="lg" />
        </div>
    );
}

export function AccentTone() {
    return <Spinner tone="accent" size="lg" label="Syncing…" />;
}
