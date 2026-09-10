import { PageLoader } from 'theorem';

export function WithMessage() {
    return (
        <div style={{ position: 'relative', width: '100%', height: 220 }}>
            <PageLoader message="Opening book…" className="" />
        </div>
    );
}

export function NoMessage() {
    return (
        <div style={{ position: 'relative', width: '100%', height: 220 }}>
            <PageLoader className="" />
        </div>
    );
}
