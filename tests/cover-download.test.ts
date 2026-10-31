import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/core/lib/env", () => ({ isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../src/core/lib/env";
import { downloadCoverImage } from "../src/core/lib/cover-download";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("cover downloads", () => {
    it("downloads through native Rust when the image site blocks browser CORS", async () => {
        vi.mocked(isTauri).mockReturnValue(true);
        vi.mocked(invoke).mockResolvedValue("data:image/jpeg;base64,/9j/");
        const fetcher = vi.fn(async (source: string) => {
            if (source.startsWith("https:")) throw new TypeError("Cross-origin request blocked");
            return new Response(new Uint8Array([255,216,255]), {headers:{"Content-Type":"image/jpeg"}});
        });
        vi.stubGlobal("fetch", fetcher);
        const image = await downloadCoverImage(" https://example.org/cover.jpg ");
        expect(invoke).toHaveBeenCalledExactlyOnceWith("fetch_cover_image", {url:"https://example.org/cover.jpg"});
        expect(fetcher).toHaveBeenCalledExactlyOnceWith("data:image/jpeg;base64,/9j/");
        expect(image.type).toBe("image/jpeg");
        expect(image.size).toBe(3);
    });
    it("rejects unsafe and incomplete URLs before fetching", async () => {
        const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
        for (const input of ["javascript:alert(1)","file:///tmp/image.png","data:image/png;base64,eA==","cover.png",""]) {
            await expect(downloadCoverImage(input)).rejects.toThrow("HTTP or HTTPS");
        }
        expect(invoke).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    });
    it("keeps browser fallback errors explicit", async () => {
        vi.mocked(isTauri).mockReturnValue(false);
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not an image", {headers:{"Content-Type":"text/html"}})));
        await expect(downloadCoverImage("https://example.org/cover")).rejects.toThrow("not return an image");
    });
});
