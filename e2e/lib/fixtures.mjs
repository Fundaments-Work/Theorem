// Generated test books. Each EPUB has a unique title/author and enough text
// per chapter to span several pages, so page turns are observable.
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { REPO } from "./app.mjs";

const LOREM = [
    "The lamplighter walked the long avenue at dusk, counting the posts as he went.",
    "Every evening the harbour bells rang twice before the fishing boats came home.",
    "She kept a ledger of the clouds, noting their shapes in a neat and patient hand.",
    "Rain had softened the road, and the cart wheels left deep ribbons in the clay.",
    "In the library the clocks disagreed, so the readers trusted the window light instead.",
];

function paragraphs(chapter, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push(`<p>${LOREM[(i + chapter) % LOREM.length]} Paragraph ${chapter}.${i + 1} continues with a quiet sentence about the town, its weather and its people.</p>`);
    }
    return out.join("\n");
}

/** Write an EPUB 3 file. `marker` is a sentence placed at the start of chapter 1 (handy to select/highlight). */
export function makeEpub(file, { title, author, chapters = 4, paragraphsPerChapter = 40, marker } = {}) {
    const id = `urn:uuid:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const files = {
        mimetype: [strToU8("application/epub+zip"), { level: 0 }],
        "META-INF/container.xml": strToU8(
            `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        ),
    };
    const manifest = [];
    const spine = [];
    const navItems = [];
    for (let c = 1; c <= chapters; c++) {
        const body = `${c === 1 && marker ? `<p id="marker">${marker}</p>\n` : ""}${paragraphs(c, paragraphsPerChapter)}`;
        files[`OEBPS/ch${c}.xhtml`] = strToU8(
            `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Chapter ${c}</title></head><body><section epub:type="chapter"><h1>Chapter ${c}</h1>\n${body}</section></body></html>`,
        );
        manifest.push(`<item id="ch${c}" href="ch${c}.xhtml" media-type="application/xhtml+xml"/>`);
        spine.push(`<itemref idref="ch${c}"/>`);
        navItems.push(`<li><a href="ch${c}.xhtml">Chapter ${c}</a></li>`);
    }
    files["OEBPS/nav.xhtml"] = strToU8(
        `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>${navItems.join("")}</ol></nav></body></html>`,
    );
    files["OEBPS/content.opf"] = strToU8(
        `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
    );
    writeFileSync(file, zipSync(files));
    return file;
}

export const BOOKS = {
    lamplighter: { title: "The Lamplighter Ledger", author: "Ada Quill", marker: "Marker sentence for the highlight test." },
    harbour: { title: "Harbour Bells", author: "Bram Vale" },
    clouds: { title: "A Census of Clouds", author: "Cora Wren" },
};

/** Write the standard set into `dir`; returns { key: path }. */
export function writeStandardBooks(dir) {
    const out = {};
    for (const [key, meta] of Object.entries(BOOKS)) out[key] = makeEpub(join(dir, `${key}.epub`), meta);
    return out;
}

/** Copy a fixture from tests/fixtures (e.g. "pdf/page-labels.pdf"). */
export function copyFixture(rel, dest) {
    copyFileSync(join(REPO, "tests", "fixtures", rel), dest);
    return dest;
}
