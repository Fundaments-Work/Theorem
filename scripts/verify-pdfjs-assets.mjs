// Post-build guard: pdf.js fetches these by fixed same-origin paths
// (PDFJS_ASSET_OPTIONS in src/core/lib/pdfjs-runtime.ts). If the copy step
// nests or drops them, CJK text, standard fonts and JPX/JBIG2/CCITT images
// silently render wrong or blank — so fail the build instead.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2] ?? "dist";
const required = [
    "pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap",
    "pdfjs/cmaps/UniGB-UCS2-H.bcmap",
    "pdfjs/standard_fonts/FoxitSerif.pfb",
    "pdfjs/standard_fonts/LiberationSans-Regular.ttf",
    "pdfjs/wasm/openjpeg.wasm",
    "pdfjs/wasm/openjpeg_nowasm_fallback.js",
    "pdfjs/wasm/jbig2.wasm",
    "pdfjs/wasm/jbig2_nowasm_fallback.js",
    "pdfjs/wasm/qcms_bg.wasm",
    "pdfjs/iccs/CGATS001Compat-v2-micro.icc",
];

const missing = required.filter((rel) => {
    const path = join(dist, rel);
    return !existsSync(path) || statSync(path).size === 0;
});

if (missing.length > 0) {
    console.error(`[verify-pdfjs-assets] missing from ${dist}/:\n  ${missing.join("\n  ")}`);
    process.exit(1);
}
console.log(`[verify-pdfjs-assets] ${required.length} pdf.js assets in place`);
