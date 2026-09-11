# Cross-Page and Cross-Column Highlighting in Paginated EPUB Readers

## Executive Summary

Highlighting text across layout boundaries—such as CSS multi-column breaks, paginated viewport margins, and EPUB spine boundaries—is one of the most technically demanding challenges in modern digital reading systems.

In Theorem's EPUB reader, pagination is driven by **Foliate-js** (`src/features/reader/foliate-js-runtime/paginator.js`). Foliate establishes a paginated reading context by styling the reflowable chapter's `<html>` element as a CSS Multi-column container (`column-width`, `column-gap`, and fixed inline-height) inside an `<iframe>`, expanding the iframe horizontally to `pageCount * size`, and shifting pages via hardware-accelerated GPU translation (`transform: translate3d(-offset, 0, 0)`). Visual highlights are rendered via `Overlayer.js` using an `<svg>` element overlay.

This investigation explores the geometric behavior of `Range.getClientRects()`, compares highlight rendering architectures across **Foliate**, **Readium**, **Epub.js**, and the emerging **CSS Custom Highlight API**, and defines an optimal auto-paging coordination architecture for sentences spanning page boundaries during Immersion Reading (Text-to-Speech).

---

## 1. Geometric Behavior of `Range.getClientRects()` in CSS Multi-column & Paginated Views

### 1.1 Specification Mechanics (W3C CSSOM View & CSS Fragmentation)

According to the **W3C CSSOM View Module** (§11.1), `Range.prototype.getClientRects()` executes the following algorithm:
1. If the range is not in the document, return an empty `DOMRectList`.
2. For each element selected by the range whose parent is not selected by the range, append the border rectangles returned by invoking `getClientRects()` on that element.
3. For each text node (or portion thereof) selected by the range, append a `DOMRect` object representing each **line box fragment** in content order.

Under the **W3C CSS Multi-column Layout Module Level 1** (§2) and **W3C CSS Fragmentation Module Level 3** (§2):
- A multi-column container establishes an inline fragmentation context.
- Content that exceeds the block dimension of a column box breaks into the next column box.
- When an inline text node crosses from Column $N$ into Column $N+1$, the layout engine partitions the text into separate **box fragments**.
- Each box fragment generates its own distinct line boxes within its respective column box.

### 1.2 Does `range.getClientRects()` Produce Rects on Both Pages/Columns?

**Yes, unconditionally.** When a DOM `Range` spans across a column or page boundary in a CSS multi-column layout:
1. `range.getClientRects()` produces separate, disjoint `DOMRect` objects for every individual line fragment.
2. The rectangles corresponding to lines in Column $N$ (Page $N$) have horizontal coordinates $X \in [\text{col}_N.\text{left}, \text{col}_N.\text{right}]$ and vertical coordinates within Column $N$'s height.
3. The rectangles corresponding to lines in Column $N+1$ (Page $N+1$) have horizontal coordinates $X \in [\text{col}_{N+1}.\text{left}, \text{col}_{N+1}.\text{right}]$ and vertical coordinates at the top of Column $N+1$.
4. Both sets of rectangles are returned within the same `DOMRectList` in content order.

### 1.3 `getClientRects()` vs. `getBoundingClientRect()`

`Range.prototype.getBoundingClientRect()` computes the **smallest single rectangle that encloses all rectangles** in the `DOMRectList`.

In a CSS multi-column layout, invoking `getBoundingClientRect()` on a cross-column range produces catastrophic rendering bugs:
- It creates a single monolithic bounding box spanning from the left of Column $N$ to the right of Column $N+1$.
- It spans horizontally across the entire `column-gap`.
- It spans vertically from the top of the range in Column $N+1$ to the bottom of the range in Column $N$, highlighting unrelated text in both columns and drawing a solid colored block across the page gutter.

Reading systems must **always** iterate over `range.getClientRects()` and draw individual line rects. `getBoundingClientRect()` must **never** be used for visual highlighting in multi-column or paginated views.

---

## 2. Primary Source Citations & References

1. **W3C Specifications**:
   - **CSSOM View Module**: [W3C Working Draft - Range.prototype.getClientRects()](https://www.w3.org/TR/cssom-view-1/#dom-range-getclientrects)
   - **CSS Multi-column Layout Module Level 1**: [W3C Candidate Recommendation](https://www.w3.org/TR/css-multicol-1/)
   - **CSS Fragmentation Module Level 3**: [W3C Candidate Recommendation](https://www.w3.org/TR/css-break-3/)
   - **CSS Custom Highlight API Module Level 1**: [W3C Candidate Recommendation](https://www.w3.org/TR/css-highlight-api-1/)
2. **Foliate Codebase (`johnfactotum/foliate-js`)**:
   - Overlayer implementation: `src/features/reader/foliate-js-runtime/overlayer.js:4-174`
   - Paginator layout & CSS multi-column setup: `src/features/reader/foliate-js-runtime/paginator.js:336-368`
   - Page expansion & SVG alignment: `src/features/reader/foliate-js-runtime/paginator.js:421-444`
   - Visible range binary search: `src/features/reader/foliate-js-runtime/paginator.js:101-153`
3. **Readium Architecture**:
   - Readium Architecture Proposal 008: [Sidemark & Decoration API](https://readium.org/architecture/proposals/008-sidemark.html)
