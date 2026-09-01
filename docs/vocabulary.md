# Vocabulary

## Two-Tier Architecture

Vocabulary lookups operate on a high-speed, local-first two-tier pipeline:

1. **Native StarDict Offline Fast-Path (< 1ms)** — Lookups check local StarDict dictionaries via native Rust memory-mapping (`stardict_lookup`). If definitions exist, the UI renders immediately without waiting for network timeouts.

2. **Online Fallback API** (`https://api.dictionaryapi.dev/`) — If no offline definitions are installed or matched, Theorem fetches from the online dictionary API with automatic fallback.

Results are cached in the in-memory `lookupCache` so repeated lookups of the same word are instantaneous.

## StarDict Native Rust Integration

StarDict dictionaries are managed natively for maximum lookup performance and zero memory bloat:

```
GitHub Release ZIP / User Import       StarDict Disk Storage
  │                                      │ (~/.local/share/.../dictionaries/)
  ▼                                      ▼
download_and_extract_stardict()       .ifo, .idx, .dict.dz / .dict files
  (Rust Tauri command)                   │
  │                                      ▼
  ├─ Download via reqwest (streaming)  stardict_lookup() (Rust Tauri command)
  ├─ Multi-threaded extraction           │
  ├─ Extract directly to disk            ├─ Memory-mapped binary search (memmap2)
  └─ Auto-inflates DictZip headers       ├─ Direct file seek & decompress
                                         ├─ Part-of-Speech cleaner & formatter
                                         └─ Result returned in < 1ms
```

### Key Technical Characteristics:
- **Memory Mapping (`memmap2`)**: `.idx` index tables are memory-mapped into process virtual address space, enabling sub-millisecond binary search across 800,000+ word dictionaries without loading multi-megabyte files into RAM.
- **DictZip (.dict.dz) Auto-Inflation**: Automatically detects GZIP / DictZip chunks and inflates requested definition byte ranges on demand.
- **Wiktionary Formatter**: Parses Wiktionary markup, cleans wiki links (`[[target|display]]`), and structures entries into clean Part of Speech sections (`[Noun]`, `[Verb]`, `[Adjective]`).
- **Disk-Only Storage**: Dictionaries live in the application data directory (`dictionaries/`) rather than SQLite BLOBs, shrinking the SQLite database footprint by > 140 MB. Legacy database blobs are automatically reclaimed on startup.

## Vocabulary Term Model

```typescript
interface VocabularyTerm {
    id: string;
    term: string;                        // The word as looked up
    normalizedTerm: string;              // Lowercased, trimmed
    language: string;
    phonetic?: string;                   // Pronunciation string
    audioUrl?: string;                   // TTS audio URL (online API)
    meanings: VocabularyMeaning[];       // Part-of-speech → definitions
    providerHistory: ("stardict" | "free-dictionary-api")[];
    lookupCount: number;                 // Incremented on each lookup
    contexts: string[];                  // Surrounding text (from reader)
    // ...
}
```

## Vocabulary Store

The `vocabularyStore` (Zustand, version 5, persisted) holds:
- `vocabularyTerms: VocabularyTerm[]` — All saved terms
- `installedDictionaries: InstalledDictionary[]` — StarDict dictionary manifests

The store provides:
- `lookupTerm`: Queries all available providers, merges results, saves if not already saved
- `saveVocabularyTerm`: Direct save (for manual entries)
- `deleteVocabularyTerm`: Remove a term
- `importDictionary` / `removeDictionary`: Manage StarDict dictionaries

## UI

The Vocabulary page (`src/features/vocabulary/Vocabulary.tsx`) shows:
- A searchable, filterable list of saved terms
- Each term card shows the word, phonetic, and primary definition
- Tapping opens a detail panel with all definitions, examples, and context sentences
- Terms can be deleted individually

Lookups can also be triggered from the reader — selecting text shows a "Define" option that opens a popover with the definition and a "Save to Vocabulary" button.
