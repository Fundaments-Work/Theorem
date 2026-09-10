import { RouteErrorBoundary } from 'theorem';

function Bomb(): React.ReactElement {
    throw new Error("Failed to parse EPUB table of contents");
}

export function Normal() {
    return (
        <RouteErrorBoundary>
            <div style={{ padding: 24, fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                Page content renders normally when there's no error.
            </div>
        </RouteErrorBoundary>
    );
}

export function Errored() {
    return (
        <RouteErrorBoundary>
            <Bomb />
        </RouteErrorBoundary>
    );
}
