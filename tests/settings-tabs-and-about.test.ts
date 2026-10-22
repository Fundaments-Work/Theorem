/**
 * Settings on a phone shows every tab at once (a sideways-scrolling row of
 * 10rem tabs hid four of six with no sign they were there), tabs report which
 * one is open, and About names the maker correctly without developer detail.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const settings = readFileSync(resolve("src/features/settings/Settings.tsx"), "utf-8");

describe("settings tabs", () => {
    it("wrap into a grid on phones instead of scrolling sideways", () => {
        expect(settings).toContain('<div className="grid grid-cols-3 gap-1">');
        expect(settings).not.toContain("min-w-[10rem]");
        expect(settings).not.toContain('className="flex gap-2 overflow-x-auto pb-1"');
    });

    it("mark the open tab as pressed on phones and desktop", () => {
        expect(settings.match(/aria-pressed=\{activeTab === tab\.id\}/g)).toHaveLength(2);
    });
});

describe("about", () => {
    it("names Fundaments and leaves out the tech stack", () => {
        expect(settings).not.toContain(">Fundamentals<");
        expect(settings).toContain(">Fundaments<");
        expect(settings).not.toContain("React 19 + Tauri 2 + Rust");
    });
});
