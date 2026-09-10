import { TheoremBookCover } from 'theorem';

// A small inline SVG placeholder cover so the "with cover art" story doesn't
// depend on a network fetch during headless capture.
const COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360">
  <rect width="240" height="360" fill="#2d6a6e"/>
  <rect x="18" y="18" width="204" height="324" fill="none" stroke="#f4ecd8" stroke-width="1.5" opacity="0.5"/>
  <text x="120" y="170" text-anchor="middle" font-family="Georgia, serif" font-size="22" fill="#f4ecd8">Meditations</text>
  <text x="120" y="200" text-anchor="middle" font-family="Georgia, serif" font-size="13" fill="#f4ecd8" opacity="0.8">Marcus Aurelius</text>
</svg>`;
const COVER_URL = `data:image/svg+xml,${encodeURIComponent(COVER_SVG)}`;

export function WithCover() {
    return (
        <div style={{ width: 160 }}>
            <TheoremBookCover title="Meditations" author="Marcus Aurelius" coverUrl={COVER_URL} />
        </div>
    );
}

export function NoCover() {
    return (
        <div style={{ width: 160 }}>
            <TheoremBookCover title="The Practice of Programming" author="Kernighan & Pike" />
        </div>
    );
}

export function WithBadge() {
    return (
        <div style={{ width: 160 }}>
            <TheoremBookCover title="Weekly Digest" author="RSS" badge="Feed" />
        </div>
    );
}
