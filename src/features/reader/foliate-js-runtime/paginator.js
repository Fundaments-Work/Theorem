const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        if (document.hidden) {
            render(lerp(a, b, 1))
            return resolve()
        }
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    if (document.hidden) {
        render(lerp(a, b, 1))
        return resolve()
    }
    requestAnimationFrame(step)
})

const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            
            if (right < start || left > end) return FILTER_REJECT
            
            if (left >= start && right <= end) return FILTER_ACCEPT
            
        } else {
            
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            background: 'transparent',
            backgroundColor: 'transparent',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
            background: 'transparent',
            backgroundColor: 'transparent',
            colorScheme: 'inherit',
        })
        
        this.#iframe.setAttribute('allowtransparency', 'true')
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                const { vertical, rtl } = getDirection(doc)
                const background = getBackground(doc)

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)

                void this.container.offsetWidth

                const layout = beforeRender?.({ vertical, rtl, background })

                // Pre-layout image settlement barrier: wait for all images
                // to finish GPU decoding (max 120ms) before measuring column
                // geometry. Without this, images start at 0px height, column
                // page count is calculated wrong, and the reader jumps/reflows
                // when images finish loading asynchronously.
                const images = Array.from(doc.body.querySelectorAll('img'))
                const decodeAll = images.map(img =>
                    img.complete
                        ? Promise.resolve()
                        : img.decode().catch(() => {}))
                const timeout = new Promise(r => setTimeout(r, 120))
                Promise.race([
                    Promise.allSettled(decodeAll),
                    timeout,
                ]).then(() => {
                    this.render(layout)
                    this.#iframe.style.display = 'block'
                    this.#observer.observe(doc.body)
                    doc.fonts.ready.then(() => this.expand())
                    resolve()
                })
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        if (!layout) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        if (!doc?.documentElement || !doc?.body) return
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${gap}px 0` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
            'overflow': 'visible',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        if (!doc?.documentElement || !doc?.body) return
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${gap / 2}px 0` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            
            'overflow-wrap': 'break-word',
            
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        if (!doc?.body || !doc?.defaultView) return
        // Leave a 32px safety buffer below image max so parent paragraph margins
        // and captions never push the total block past the column height, which
        // would force the browser to fragment the image across two columns.
        const safeHeight = Math.max(100, height - margin * 2 - 32)
        const safeWidth = Math.max(100, width - margin * 2)
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${safeHeight}px`,
                'max-width': vertical
                    ? `${safeWidth}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'height': 'auto',
                'width': 'auto',
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                '-webkit-column-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
                'display': 'block',
            })
        }
        // Apply break-inside: avoid to common EPUB image parent containers
        // (figure, p, div, section) so the container block itself is also
        // prevented from being split across column boundaries.
        const breakAvoidStyles = {
            'page-break-inside': 'avoid',
            '-webkit-column-break-inside': 'avoid',
            'break-inside': 'avoid',
        }
        for (const el of doc.body.querySelectorAll('figure')) {
            setStylesImportant(el, breakAvoidStyles)
        }
        // Target paragraphs and divs that directly contain an img/svg child
        for (const el of doc.body.querySelectorAll('p > img, p > svg, p > video, div > img, div > svg, section > img')) {
            const parent = el.parentElement
            if (parent && parent !== doc.body) {
                setStylesImportant(parent, breakAvoidStyles)
            }
        }
    }
    expand() {
        const doc = this.document
        if (!doc?.documentElement || !doc?.body) return
        const { documentElement } = doc
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin } = this.#layout
            // Add a generous bottom buffer (64px) in scrolled mode so fixed bottom chrome never obscures the last lines of text
            const padding = this.#vertical ? `0 ${margin + 64}px 0 ${margin}px` : `${margin}px 0 ${margin + 64}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        if (this.document?.body) this.#observer.unobserve(this.document.body)
        this.#observer.disconnect()
    }
}

export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 
    #justAnchored = false
    #locked = false 
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    
    #selectionActiveUntil = 0
    
    #pageOffset = 0
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            grid-template-rows:
                minmax(var(--_margin), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
         #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            /* clip (not hidden) makes #container a non-scroll container:
             * scrollLeft/scrollTop become inert, so Android WebView's
             * OS-level auto-scroll during native text selection can no
             * longer move the page (#20). Pages are instead positioned
             * via transform on the view element (#setViewPosition). */
            overflow: clip;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            /* scrolled mode keeps real scrolling */
            overflow-y: auto;
            overflow-x: hidden;
            scrollbar-width: thin;
            scrollbar-color: color-mix(in srgb, currentColor 30%, transparent) transparent;
        }
        :host([flow="scrolled"]) #container::-webkit-scrollbar {
            width: 5px;
            height: 5px;
        }
        :host([flow="scrolled"]) #container::-webkit-scrollbar-track {
            background: transparent;
        }
        :host([flow="scrolled"]) #container::-webkit-scrollbar-thumb {
            background: color-mix(in srgb, currentColor 30%, transparent);
            border: none;
            border-radius: 9999px;
            transition: background-color 0.15s ease-out;
        }
        :host([flow="scrolled"]) #container::-webkit-scrollbar-thumb:hover {
            background: color-mix(in srgb, currentColor 60%, transparent);
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => this.dispatchEvent(new Event('scroll')))
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            
            const checkPointerSelection = debounce((_range, _sel) => {}, 700)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const sel = doc.getSelection()
                if (!sel?.rangeCount) return
                
                if (!sel.isCollapsed && sel.toString().trim().length > 0) {
                    this.#selectionActiveUntil = Date.now() + 1500
                }
                if (isPointerSelecting && sel.type === 'Range') {
                    const range = this.#lastVisibleRange
                    if (range) checkPointerSelection(range, sel)
                }
                else if (isKeyboardSelecting) {
                    const range = this.#lastVisibleRange
                    if (!range) return
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => {
                if (this.scrolled) return
                
                if (e.target === doc.body || e.target === doc.documentElement) return
                
                if (isPointerSelecting) return
                if (Date.now() < this.#selectionActiveUntil) return
                
                requestAnimationFrame(() => this.#scrollToAnchor(e.target))
            })
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#background.style.background = getBackground(this.#view.document)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                break
            case 'max-inline-size':
                
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                
                .replace(/(?<=[{\s;])-epub-/gi, '')
                
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView() {
        if (this.#view) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
        }
        this.#view = new View({
            container: this,
            onExpand: () => this.#scrollToAnchor(this.#anchor),
        })
        this.#container.append(this.#view.element)
        return this.#view
    }
    #beforeRender({ vertical, rtl, background }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        this.#background.style.background = background

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = (size / divisor) - gap
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth }
    }
    render() {
        if (!this.#view) return
        
        void this.offsetWidth
        const { width, height } = this.#container.getBoundingClientRect()
        const measuredSize = this.#vertical ? height : width
        if (this.getAttribute('flow') !== 'scrolled' && measuredSize === 0) {
            
            requestAnimationFrame(() => this.render())
            return
        }
        if (this.getAttribute('flow') === 'scrolled') {
            this.#pageOffset = 0
            const el = this.#view.element
            if (el) {
                el.style.transform = ''
                el.style.transition = ''
            }
        }
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#scrollToAnchor(this.#anchor)
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        
        return this.scrolled
            ? Math.abs(this.#container[this.scrollProp])
            : Math.abs(this.#pageOffset)
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    
    #setViewPosition(offset, animate = true) {
        const prev = this.#pageOffset
        this.#pageOffset = offset
        const el = this.#view?.element
        if (el) {
            const vertical = this.#vertical
            // Use translate3d to force GPU layer promotion, preventing CPU
            // re-rasterization of large multi-column/image layouts on every
            // frame of the transition animation.
            el.style.transition = animate
                ? 'transform 0.3s cubic-bezier(0, 0, 0.58, 1)'
                : 'none'
            el.style.transform = vertical
                ? `translate3d(0, ${-offset}px, 0)`
                : `translate3d(${-offset}px, 0, 0)`
        }
        this.dispatchEvent(new Event('scroll'))
    }
    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        if (this.scrolled) {
            const element = this.#container
            const { scrollProp } = this
            element[scrollProp] = Math.max(min, Math.min(max,
                element[scrollProp] + delta))
        } else {
            
            const next = Math.max(min, Math.min(max, this.#pageOffset + delta))
            this.#setViewPosition(next, false)
        }
    }
    snap(vx, vy) {
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            startX: touch?.screenX, startY: touch?.screenY,
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, vy: 0,
            // Accumulated displacement from start of gesture
            totalDx: 0, totalDy: 0,
            // Axis locked once determined ('h' = horizontal, 'v' = vertical, null = undecided)
            axis: null,
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (!state) return
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }

        // Bail immediately if user has active text selection (highlight drag)
        if (Date.now() < this.#selectionActiveUntil) return
        const sel = this.#view?.document?.getSelection?.()
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
            this.#selectionActiveUntil = Date.now() + 1500
            return
        }

        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t

        // Determine axis lock on first movement past 8px
        if (!state.axis) {
            const absDx = Math.abs(state.startX - x)
            const absDy = Math.abs(state.startY - y)
            if (absDx > 8 || absDy > 8) {
                state.axis = absDx > absDy ? 'h' : 'v'
            }
        }

        // If scrolled mode or vertical axis gesture, don't intercept
        if (this.scrolled || state.axis === 'v') return

        // Only act on horizontal swipe
        if (state.axis !== 'h') return

        e.preventDefault()

        // Update rolling velocity (exponential smoothing for stability)
        if (dt > 0) {
            const alpha = 0.7
            state.vx = alpha * (dx / dt) + (1 - alpha) * (state.vx || 0)
            state.vy = alpha * (dy / dt) + (1 - alpha) * (state.vy || 0)
        }

        state.totalDx = x - state.startX
        state.x = x
        state.y = y
        state.t = e.timeStamp

        // Real-time 1:1 finger tracking: translate the view under the finger
        // Apply rubberband resistance factor when overscrolling at chapter edges
        const [offset, a, b] = this.#scrollBounds
        const rawDelta = this.#rtl ? state.totalDx : -state.totalDx
        const atBoundary = (rawDelta < 0 && a === 0) || (rawDelta > 0 && b === 0)
        const delta = atBoundary ? rawDelta * 0.3 : rawDelta
        const next = Math.max(
            this.#rtl ? offset - b : offset - a,
            Math.min(
                this.#rtl ? offset + a : offset + b,
                offset + delta,
            ),
        )
        this.#setViewPosition(next, false)
        this.#touchScrolled = true
    }
    #onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return
        if (!this.#touchState) return

        // Don't snap if user had an active text selection
        if (Date.now() < this.#selectionActiveUntil) return
        const sel = this.#view?.document?.getSelection?.()
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
            this.#selectionActiveUntil = Date.now() + 1500
            return
        }

        // Only snap on horizontal swipes
        if (this.#touchState.axis !== 'h') return

        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale !== 1) return
            const state = this.#touchState
            const size = this.size
            // Commit the page turn if:
            //   - displacement exceeded 25% of screen width (slow drag completion), OR
            //   - flick velocity exceeded 0.25 px/ms (quick swipe)
            const totalDx = state.totalDx ?? 0
            const velocity = state.vx ?? 0
            const displaced = Math.abs(totalDx) > size * 0.25
            const flicked = Math.abs(velocity) > 0.25
            if (displaced || flicked) {
                // Use velocity for snap direction; fall back to displacement direction
                const effectiveVx = Math.abs(velocity) > 0.05
                    ? velocity
                    : (this.#rtl ? totalDx : -totalDx) > 0 ? 0.5 : -0.5
                this.snap(effectiveVx, state.vy ?? 0)
            } else {
                // Snap back to current page
                this.#scrollToPage(this.page, 'snap')
            }
        })
    }
    
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const { size } = this
        const scrolled = this.scrolled
        
        const cur = () => scrolled
            ? this.#container[this.scrollProp]
            : this.#pageOffset
        const apply = x => scrolled
            ? this.#container[this.scrollProp] = x
            : this.#setViewPosition(x)
        if (cur() === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            
            if (!scrolled) apply(offset)
            return
        }
        
        if (scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            cur(), offset, 300, easeOutQuad,
            apply,
        ).then(() => {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            apply(offset)
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        this.#anchor = anchor
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(anchor * this.viewSize, reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const textPages = pages - 2
        const newPage = Math.round(anchor * (textPages - 1))
        await this.#scrollToPage(newPage + 1, reason)
    }
    #getVisibleRange() {
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select } = await promise
        this.#index = index
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            const view = this.#createView()
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    // Eagerly inject any already-active styles so the new
                    // chapter document inherits zoom/font-size/theme on its
                    // very first rendered frame, eliminating the post-turn
                    // style-injection workaround in the engine layer.
                    if (this.#styles) {
                        if (Array.isArray(this.#styles)) {
                            $styleBefore.textContent = this.#styles[0] ?? ''
                            $style.textContent = this.#styles[1] ?? ''
                        } else {
                            $style.textContent = this.#styles
                        }
                    }
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.#view = view
        }
        await this.scrollToAnchor((typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0, select)
        if (hasFocus) this.focusView()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select}) {
        if (index === this.#index) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(src => ({ index, src, anchor, onLoad, select }))
                .catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (this.#canGoToIndex(resolved.index)) return this.#goTo(resolved)
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return true
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) return this.#scrollTo(
                Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
            return true
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        const prev = dir === -1
        const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
        if (shouldGo) await this.#goTo({
            index: this.#adjacentIndex(dir),
            anchor: prev ? () => 1 : () => 0,
        })
        if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        this.#locked = false
    }
    prev(distance) {
        return this.#turnPage(-1, distance)
    }
    next(distance) {
        return this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    setStyles(styles) {
        this.#styles = styles
        const $$styles = this.#styleMap.get(this.#view?.document)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles

        requestAnimationFrame(() =>
            this.#background.style.background = getBackground(this.#view.document))

        this.#view?.document?.fonts?.ready?.then(() => this.#view.expand())
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        this.#observer.unobserve(this)
        this.#view.destroy()
        this.#view = null
        this.sections[this.#index]?.unload?.()
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
