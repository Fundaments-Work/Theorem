const createSVGElement = tag =>
    document.createElementNS('http://www.w3.org/2000/svg', tag)

export class Overlayer {
    #svg = createSVGElement('svg')
    #map = new Map()
    // Theorem: the live text selection, drawn from text-only rects so it hugs
    // the glyphs like PDF selection. Kept out of #map so hitTest ignores it.
    #selection = null
    constructor() {
        Object.assign(this.#svg.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%',
            pointerEvents: 'none',
        })
    }
    get element() {
        return this.#svg
    }
    add(key, range, draw, options) {
        if (this.#map.has(key)) this.remove(key)
        if (typeof range === 'function') range = range(this.#svg.getRootNode())
        const rects = range.getClientRects()
        const element = draw(rects, options)
        this.#svg.append(element)
        this.#map.set(key, { range, draw, options, element, rects })
    }
    remove(key) {
        if (!this.#map.has(key)) return
        this.#svg.removeChild(this.#map.get(key).element)
        this.#map.delete(key)
    }
    setSelection(getRects, color) {
        this.#selection?.element?.remove()
        this.#selection = getRects ? { getRects, color, element: null } : null
        this.#drawSelection()
    }
    #drawSelection() {
        const selection = this.#selection
        if (!selection) return
        selection.element?.remove()
        const g = createSVGElement('g')
        g.setAttribute('data-selection', 'true')
        g.style.fill = selection.color
        for (const { left, top, height, width } of selection.getRects()) {
            if (!(width > 0) || !(height > 0)) continue
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', top)
            el.setAttribute('height', height)
            el.setAttribute('width', width)
            el.setAttribute('rx', '2')
            g.append(el)
        }
        this.#svg.append(g)
        selection.element = g
    }
    redraw() {
        this.#selection?.element?.remove()
        if (this.#selection) this.#selection.element = null
        for (const obj of this.#map.values()) {
            const { range, draw, options, element } = obj
            this.#svg.removeChild(element)
            const rects = range.getClientRects()
            const el = draw(rects, options)
            this.#svg.append(el)
            obj.element = el
            obj.rects = rects
        }
        this.#drawSelection()
    }
    hitTest(point) {
        const x = point?.x ?? point?.clientX
        const y = point?.y ?? point?.clientY
        if (typeof x !== 'number' || typeof y !== 'number') return []
        const arr = Array.from(this.#map.entries())
        
        for (let i = arr.length - 1; i >= 0; i--) {
            const [key, obj] = arr[i]
            for (const { left, top, right, bottom } of obj.rects) {
                if (right <= left || bottom <= top) continue
                if (top <= y && left <= x && bottom > y && right > x)
                    return [key, obj.range]
            }
        }
        return []
    }
    static underline(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, top, height } of rects) {
                if (!height || height <= 0) continue
                const el = createSVGElement('rect')
                el.setAttribute('x', right - strokeWidth)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        else for (const { left, bottom, width } of rects) {
            if (!width || width <= 0) continue
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', bottom - strokeWidth)
            el.setAttribute('height', strokeWidth)
            el.setAttribute('width', width)
            g.append(el)
        }
        return g
    }
    static strikethrough(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, left, top, height } of rects) {
                if (!height || height <= 0) continue
                const el = createSVGElement('rect')
                el.setAttribute('x', (right + left) / 2)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        else for (const { left, top, bottom, width } of rects) {
            if (!width || width <= 0) continue
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', (top + bottom) / 2)
            el.setAttribute('height', strokeWidth)
            el.setAttribute('width', width)
            g.append(el)
        }
        return g
    }
    static squiggly(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        const block = strokeWidth * 1.5
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, top, height } of rects) {
                if (!height || height <= 0) continue
                const el = createSVGElement('path')
                const n = Math.max(1, Math.round(height / block / 1.5))
                const inline = height / n
                const ls = Array.from({ length: n },
                    (_, i) => `l${i % 2 ? -block : block} ${inline}`).join('')
                el.setAttribute('d', `M${right} ${top}${ls}`)
                g.append(el)
            }
        else for (const { left, bottom, width } of rects) {
            if (!width || width <= 0) continue
            const el = createSVGElement('path')
            const n = Math.max(1, Math.round(width / block / 1.5))
            const inline = width / n
            const ls = Array.from({ length: n },
                (_, i) => `l${inline} ${i % 2 ? block : -block}`).join('')
            el.setAttribute('d', `M${left} ${bottom}${ls}`)
            g.append(el)
        }
        return g
    }
    static highlight(rects, options = {}) {
        const { color = 'red' } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        g.setAttribute('data-highlight', 'true')
        g.style.opacity = 'var(--overlayer-highlight-opacity, .35)'
        g.style.mixBlendMode = 'var(--overlayer-highlight-blend-mode, normal)'
        for (const { left, top, height, width } of rects) {
            if (!width || !height || width <= 0 || height <= 0) continue
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', top)
            el.setAttribute('height', height)
            el.setAttribute('width', width)
            el.setAttribute('rx', '2')
            g.append(el)
        }
        return g
    }
    static outline(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 3, radius = 3 } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        for (const { left, top, height, width } of rects) {
            if (!width || !height || width <= 0 || height <= 0) continue
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', top)
            el.setAttribute('height', height)
            el.setAttribute('width', width)
            el.setAttribute('rx', radius)
            g.append(el)
        }
        return g
    }
    
    static copyImage([rect], options = {}) {
        const { src } = options
        const image = createSVGElement('image')
        const { left, top, height, width } = rect
        image.setAttribute('href', src)
        image.setAttribute('x', left)
        image.setAttribute('y', top)
        image.setAttribute('height', height)
        image.setAttribute('width', width)
        return image
    }
}
