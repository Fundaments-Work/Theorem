import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
    plugins: [
        react(),
        tailwindcss(),
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
                },
                {
                    src: "node_modules/pdfjs-dist/standard_fonts/*",
                    dest: "pdfjs/standard_fonts",
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
                },
            },
        },
    },

    // Server configuration
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        proxy: {},
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
