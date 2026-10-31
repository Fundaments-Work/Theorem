import { isTauri } from "./env";
import { remoteImageUrl } from "./url-safety";

export async function downloadCoverImage(input: string): Promise<Blob> {
    const url = remoteImageUrl(input);
    if (!url) throw new Error("Enter a complete HTTP or HTTPS image URL.");
    let source = url;
    if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        source = await invoke<string>("fetch_cover_image", { url });
    }
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Cover download returned HTTP ${response.status}.`);
    const image = await response.blob();
    if (!image.type.startsWith("image/")) throw new Error("URL did not return an image.");
    return image;
}
