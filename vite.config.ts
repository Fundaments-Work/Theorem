import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { readFileSync } from "node:fs";
import { onRequestGet as proxyGutenberg } from "./functions/api/gutenberg.ts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
    plugins: [
        react(),
        tailwindcss(),
        // Match the Pages Function during local web development.
        {
            name: "gutenberg-dev-proxy",
            configureServer(server: ViteDevServer) {
                server.middlewares.use(async (req, res, next) => {
                    if (!req.url?.startsWith("/api/gutenberg?")) return next();
                    try {
                        const request = new Request(new URL(req.url, "http://localhost:1420"));
                        const response = await proxyGutenberg({ request });
                        res.statusCode = response.status;
                        response.headers.forEach((value, name) => res.setHeader(name, value));
                        res.end(Buffer.from(await response.arrayBuffer()));
                    } catch {
                        res.statusCode = 502;
                        res.end("Gutenberg proxy failed");
                    }
                });
            },
        },
        // Copy PDF.js assets (cmaps and fonts) from node_modules to build output.
        // Only Adobe-* and Uni* cmaps are shipped: standard Unicode/Adobe tables
        // cover real-world PDFs, the ~100 legacy CJK tables (2.5 MB) are skipped.
        viteStaticCopy({
            targets: [
                {
                    src: [
                        "node_modules/pdfjs-dist/cmaps/Adobe-*.bcmap",
                        "node_modules/pdfjs-dist/cmaps/Uni*.bcmap",
                    ],
                    dest: "pdfjs/cmaps",
                    // v4 keeps the source path under dest unless stripped.
                    rename: { stripBase: true },
                },
                {
                    src: "node_modules/pdfjs-dist/standard_fonts/*",
                    dest: "pdfjs/standard_fonts",
                    rename: { stripBase: true },
                },
                // Image decoders pdf.js 6 loads from `wasmUrl`: openjpeg (JPX),
                // jbig2 (JBIG2 + CCITT fax), qcms (ICC). The *_nowasm_fallback.js
                // files cover runtimes without WebAssembly. quickjs-eval (PDF
                // scripting) is intentionally not shipped: isEvalSupported=false.
                {
                    src: [
                        "node_modules/pdfjs-dist/wasm/openjpeg.wasm",
                        "node_modules/pdfjs-dist/wasm/openjpeg_nowasm_fallback.js",
                        "node_modules/pdfjs-dist/wasm/jbig2.wasm",
                        "node_modules/pdfjs-dist/wasm/jbig2_nowasm_fallback.js",
                        "node_modules/pdfjs-dist/wasm/qcms_bg.wasm",
                        "node_modules/pdfjs-dist/wasm/LICENSE_*",
                    ],
                    dest: "pdfjs/wasm",
                    rename: { stripBase: true },
                },
                {
                    src: "node_modules/pdfjs-dist/iccs/*",
                    dest: "pdfjs/iccs",
                    rename: { stripBase: true },
                },
            ],
        }),
    ],
    // Optimize dependencies for faster dev server startup
    optimizeDeps: {
        exclude: [
            // Foliate-js handles its own imports
            "./src/features/reader/foliate-js/mobi.js",
            "./src/features/reader/foliate-js/fb2.js",
            "./src/features/reader/foliate-js/comic-book.js",
            "./src/features/reader/foliate-js/view.js",
        ],
        include: [
            // Pre-bundle PDF.js for better performance
            "pdfjs-dist",
        ],
    },

    // Build configuration
    build: {
        target: "esnext",
        assetsInlineLimit: 0,
        // Vite 8 uses rolldown — manualChunks must be a function
        rolldownOptions: {
            output: {
                manualChunks(id: string) {
                    // Separate PDF.js into its own chunk for better caching
                    if (id.includes("pdfjs-dist")) return "pdfjs";
                    // Separate icon library and error reporting to keep main app chunk lean
                    if (id.includes("lucide-react")) return "lucide";
                    if (id.includes("@sentry")) return "sentry";
                    // Virtualizer, toast, and Radix primitives change rarely — own cache entry
                    if (id.includes("@tanstack")) return "tanstack";
                    if (id.includes("sonner") || id.includes("@radix-ui")) return "ui-vendors";
                },
            },
        },
    },

    // Server configuration
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                protocol: "ws",
                host,
                port: 1421,
            }
            : undefined,
        watch: {
            ignored: ["**/src-tauri/**"],
        },
        fs: {
            allow: ["."],
        },
    },

    // Prevent Vite from obscuring rust errors
    clearScreen: false,

    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
}));
