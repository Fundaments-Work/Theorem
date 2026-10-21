/**
 * The default vault note template, kept apart from `knap-templates.ts` so the
 * settings store (loaded at startup) can use it without pulling in the `knap`
 * engine (~74 kB), which only vault export and the template editor need.
 */
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
