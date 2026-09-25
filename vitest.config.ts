import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: ["./tests/setup.ts"],
        testTimeout: 15000,
        include: ["tests/**/*.test.{ts,tsx}"],
        clearMocks: true,
        restoreMocks: true,
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            reportsDirectory: "coverage",
            include: ["src/**/*.{ts,tsx}"],
            exclude: [
                "src/features/reader/foliate-js/**",
                "src/**/*.d.ts",
                "src/main.tsx",
                "src/features/reader/engines/**",
            ],
        },
    },
});
