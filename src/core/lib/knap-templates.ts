import {
    createEngine,
    standardFilters,
    standardFilterMetadata,
    validateFilters,
    type TemplateEngine,
} from "knap";

export interface KnapHighlightItem {
    id: string;
    text: string;
    note: string | null;
    color?: string;
    createdAt?: string;
    updatedAt?: string;
    chapterTitle?: string;
    progress?: number;
}

export interface KnapBookData {
    id: string;
    title: string;
    author: string;
    format: string;
    filePath?: string;
    highlights: KnapHighlightItem[];
    totalHighlights: number;
    syncDate: string;
    tags: string[];
}

export const DEFAULT_KNAP_TEMPLATE = `---
title: {{ title | yaml }}
author: {{ author | yaml }}
format: {{ format | yaml }}
total_highlights: {{ highlights | length }}
tags:
  - reading/highlights
  - theorem
---

# {{ title }}
{% if author %}
*By {{ author | wikilink }}*
{% endif %}

## Highlights

{% for item in highlights %}
{% if item.text %}
> {{ item.text | highlight }}
{% endif %}
{% if item.note %}

**Note**: {{ item.note }}
{% endif %}

{% endfor %}`.trim();

let cachedEngine: TemplateEngine | null = null;

export function getKnapEngine(): TemplateEngine {
    if (!cachedEngine) {
        cachedEngine = createEngine({
            filters: {
                ...standardFilters,
                default: (val: unknown, fallback?: unknown) => {
                    if (val !== null && val !== undefined && String(val).trim().length > 0) {
                        return val;
                    }
                    return fallback ?? "";
                },
            },
        });
    }
    return cachedEngine;
}

export interface KnapValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validates syntax, control structures, and filter invocations in a template.
 */
export function validateKnapTemplate(template: string): KnapValidationResult {
    if (!template || !template.trim()) {
        return { valid: false, errors: ["Template cannot be empty."] };
    }

    const engine = getKnapEngine();
    const parseResult = engine.parse(template);

    const errors: string[] = [];
    if (parseResult.errors && parseResult.errors.length > 0) {
        for (const err of parseResult.errors) {
            errors.push(`Line ${err.line}, col ${err.column}: ${err.message}`);
        }
    }

    if (parseResult.ast && parseResult.ast.length > 0) {
        const filterErrors = validateFilters(parseResult.ast, {
            ...standardFilterMetadata,
            default: { example: "value | default: 'fallback'" },
        });
        for (const err of filterErrors) {
            errors.push(`Line ${err.line}, col ${err.column}: ${err.message}`);
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

/**
 * Renders a book note with the provided template and book variables.
 * Falls back to basic Markdown if rendering fails or returns errors.
 */
export async function renderKnapBookPage(
    template: string,
    data: KnapBookData,
): Promise<{ output: string; errors: string[] }> {
    const engine = getKnapEngine();
    try {
        const res = await engine.render(template, {
            variables: {
                id: data.id,
                title: data.title || "Untitled",
                author: data.author || "",
                format: data.format || "",
                filePath: data.filePath || "",
                highlights: data.highlights || [],
                totalHighlights: data.totalHighlights ?? (data.highlights?.length ?? 0),
                syncDate: data.syncDate || new Date().toISOString(),
                tags: data.tags || ["reading/highlights", "theorem"],
            },
        });

        const errorMessages = res.errors?.map((e) => `Line ${e.line}: ${e.message}`) || [];
        return {
            output: res.output,
            errors: errorMessages,
        };
    } catch (err) {
        return {
            output: "",
            errors: [err instanceof Error ? err.message : String(err)],
        };
    }
}
