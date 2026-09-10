import { SplashScreen } from 'theorem';

// SplashScreen's root is `position: fixed`, not portalled — inside the
// single-card wrapper (a `transform` context, so it's the containing block
// for fixed descendants) that wrapper's own height comes only from in-flow
// content. With no in-flow sibling it collapses to 0 and `inset-0` resolves
// against a 0-tall box, so this wrapper div (plain, non-fixed) exists purely
// to give that containing block a real height. See NOTES.md.
export function Default() {
    return (
        <div style={{ height: 480 }}>
            <SplashScreen />
        </div>
    );
}

export function CustomMessage() {
    return (
        <div style={{ height: 480 }}>
            <SplashScreen message="Indexing your library…" />
        </div>
    );
}
