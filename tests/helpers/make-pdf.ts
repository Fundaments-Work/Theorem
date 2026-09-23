/**
 * Minimal PDF writer for test fixtures generated at test time (no binaries to
 * commit): uncompressed objects, classic xref table, Helvetica text.
 */

export interface FixturePage {
    /** MediaBox width/height in points. */
    width?: number;
    height?: number;
    rotate?: 0 | 90 | 180 | 270;
    /** Text drawn near the top-left corner. */
    text?: string;
    /** Image XObject drawn at (0,0) with this size in points. */
    image?: { dict: string; data: Uint8Array; width: number; height: number };
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const escapeText = (s: string) => s.replace(/[\\()]/g, "\\$&");

export function makePdf(pages: FixturePage[]): Uint8Array {
    const objects: Uint8Array[][] = [];
    const add = (...parts: (string | Uint8Array)[]) => {
        objects.push(parts.map((p) => (typeof p === "string" ? latin1(p) : p)));
        return objects.length;
    };
    const stream = (dict: string, data: Uint8Array) =>
        add(`<< ${dict} /Length ${data.length} >>\nstream\n`, data, "\nendstream");

    const catalog = add(""); // patched below
    const pagesObj = add("");
    const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const kids: number[] = [];
    for (const page of pages) {
        const w = page.width ?? 200;
        const h = page.height ?? 300;
        let content = "";
        let resources = `/Font << /F1 ${font} 0 R >>`;
        if (page.image) {
            const img = stream(page.image.dict, page.image.data);
            resources += ` /XObject << /Im1 ${img} 0 R >>`;
            content += `q ${page.image.width} 0 0 ${page.image.height} 0 0 cm /Im1 Do Q\n`;
        }
        if (page.text) content += `BT /F1 12 Tf 10 ${h - 20} Td (${escapeText(page.text)}) Tj ET\n`;
        const contents = stream("", latin1(content));
        kids.push(add(
            `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w} ${h}]`
            + (page.rotate ? ` /Rotate ${page.rotate}` : "")
            + ` /Resources << ${resources} >> /Contents ${contents} 0 R >>`,
        ));
    }
    objects[catalog - 1] = [latin1(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`)];
    objects[pagesObj - 1] = [latin1(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`)];

    const chunks: Uint8Array[] = [latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
    let offset = chunks[0].length;
    const offsets: number[] = [];
    objects.forEach((parts, i) => {
        offsets.push(offset);
        for (const part of [latin1(`${i + 1} 0 obj\n`), ...parts, latin1("\nendobj\n")]) {
            chunks.push(part);
            offset += part.length;
        }
    });
    const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
        + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
        + `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
    chunks.push(latin1(xref));

    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

function jbig2Segment(number: number, type: number, data: number[]): number[] {
    // number, flags (type; 1-byte page association), no referred-to segments,
    // page 1, data length.
    return [...u32(number), type & 0x3f, 0x00, 0x01, ...u32(data.length), ...data];
}

/**
 * Embedded JBIG2 stream (no file header, as in PDF `/JBIG2Decode`) holding one
 * immediate generic region coded with MMR, i.e. CCITT T.6 (Group 4) data.
 */
export function jbig2FromG4(g4: Uint8Array, width: number, height: number): Uint8Array {
    const pageInfo = [...u32(width), ...u32(height), ...u32(0), ...u32(0), 0x00, 0x00, 0x00];
    const region = [
        ...u32(width), ...u32(height), ...u32(0), ...u32(0), 0x00, // region info, OR
        0x01, // generic region flags: MMR
        ...g4,
    ];
    return Uint8Array.from([
        ...jbig2Segment(0, 48, pageInfo), // page information
        ...jbig2Segment(1, 38, region), // immediate generic region
        ...jbig2Segment(2, 49, []), // end of page
    ]);
}
