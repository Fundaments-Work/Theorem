//! Supertonic 3 neural TTS inference — desktop only.
//!
//! Ported from the official ONNX reference (supertone-inc/supertonic,
//! `rust/src/helper.rs`, MIT). Pipeline: text → unicode ids → duration
//! predictor → text encoder → vector estimator (iterative denoising) →
//! vocoder → 44.1kHz mono f32 PCM.
//!
//! The ONNX Runtime shared library is loaded at runtime (`load-dynamic`)
//! from `tts/runtime/`, which is downloaded by `tts_model.rs` — nothing
//! ships with the binary.

// Everything below is desktop-only: the engine, its heavy dependencies, and
// the real command bodies. Android uses the companion TTS engine app instead
// (audiobook plan §0.3), so this module compiles to no-op command stubs there.
#[cfg(not(target_os = "android"))]
pub mod desktop {
    use ndarray::{Array2, Array3};
    use ort::session::Session;
    use ort::value::Value;
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use unicode_normalization::UnicodeNormalization;

    pub const SAMPLE_RATE: f32 = 44_100.0;
    /// Subset of tts.json required by the pipeline (reference: py/helper.py).
    #[derive(serde::Deserialize)]
    struct TtsConfig {
        #[serde(default)]
        ttl: TtlSection,
        #[serde(default)]
        ae: AeSection,
    }

    #[derive(serde::Deserialize, Default)]
    struct TtlSection {
        #[serde(default = "default_latent_dim")]
        latent_dim: u32,
        #[serde(default = "default_chunk_compress_factor")]
        chunk_compress_factor: u32,
    }

    fn default_latent_dim() -> u32 {
        24
    }
    fn default_chunk_compress_factor() -> u32 {
        6
    }

    #[derive(serde::Deserialize, Default)]
    struct AeSection {
        #[serde(default = "default_sample_rate")]
        sample_rate: u32,
        #[serde(default = "default_base_chunk_size")]
        base_chunk_size: u32,
    }

    fn default_sample_rate() -> u32 {
        44_100
    }
    fn default_base_chunk_size() -> u32 {
        512
    }

    /// Codepoint → token id table: unicode_indexer.json is a bare JSON list
    /// of 65536 entries indexed by unicode codepoint.
    #[derive(serde::Deserialize)]
    #[serde(transparent)]
    struct UnicodeIndexer {
        table: Vec<i32>,
    }

    pub struct TextToSpeech {
        dp: Session,
        text_encoder: Session,
        vector_estimator: Session,
        vocoder: Session,
        config: TtsConfig,
        unicode_indexer: UnicodeIndexer,
        pub sample_rate: u32,
    }

    /// Voice style vectors loaded from a `voices/<name>.json` file.
    pub struct Style {
        pub ttl: Array3<f32>,
        pub dp: Array3<f32>,
    }

    fn preprocess_text(text: &str, lang: &str) -> String {
        // Reference: UnicodeProcessor._preprocess_text (py/helper.py).
        let normalized = crate::text_normalizer::normalize_speech_text(text, lang);
        let mut processed: String = normalized.nfkd().collect();
        processed = processed.chars().filter(|c| !is_emoji(*c)).collect();

        const REPLACEMENTS: &[(&str, &str)] = &[
            ("–", "-"),
            ("‑", "-"),
            ("—", "-"),
            ("_", " "),
            ("\u{201C}", "\""),
            ("\u{201D}", "\""),
            ("\u{2018}", "'"),
            ("\u{2019}", "'"),
            ("´", "'"),
            ("`", "'"),
            ("[", " "),
            ("]", " "),
            ("|", " "),
            ("/", " "),
            ("#", " "),
            ("→", " "),
            ("←", " "),
        ];
        for (from, to) in REPLACEMENTS {
            processed = processed.replace(from, to);
        }
        processed = processed.replace(['♥', '☆', '♡', '©', '\\'], "");

        const EXPRESSIONS: &[(&str, &str)] = &[
            ("@", " at "),
            ("e.g.,", "for example, "),
            ("i.e.,", "that is, "),
        ];
        for (from, to) in EXPRESSIONS {
            processed = processed.replace(from, to);
        }

        // Spacing around punctuation.
        for (from, to) in [
            (" ,", ","),
            (" .", "."),
            (" !", "!"),
            (" ?", "?"),
            (" ;", ";"),
            (" :", ":"),
            (" '", "'"),
        ] {
            processed = processed.replace(from, to);
        }
        while processed.contains("\"\"") {
            processed = processed.replace("\"\"", "\"");
        }
        while processed.contains("''") {
            processed = processed.replace("''", "'");
        }
        while processed.contains("``") {
            processed = processed.replace("``", "`");
        }

        // Collapse whitespace runs.
        let mut cleaned = String::with_capacity(processed.len());
        let mut last_ws = false;
        for ch in processed.chars() {
            if ch.is_whitespace() {
                if !last_ws {
                    cleaned.push(' ');
                }
                last_ws = true;
            } else {
                cleaned.push(ch);
                last_ws = false;
            }
        }
        let mut cleaned = cleaned.trim().to_string();
        const END_PUNCT: &str = ".!?;:,'\")]}…。」』】〉》›»";
        if !cleaned
            .chars()
            .last()
            .map(|c| END_PUNCT.contains(c))
            .unwrap_or(false)
        {
            cleaned.push('.');
        }
        format!("<{lang}>{cleaned}</{lang}>")
    }

    /// Ranges removed by the reference emoji regex.
    fn is_emoji(c: char) -> bool {
        matches!(c,
            '\u{1F300}'..='\u{1F5FF}'
            | '\u{1F600}'..='\u{1F64F}'
            | '\u{1F680}'..='\u{1F6FF}'
            | '\u{1F700}'..='\u{1F77F}'
            | '\u{1F780}'..='\u{1F7FF}'
            | '\u{1F800}'..='\u{1F8FF}'
            | '\u{1F900}'..='\u{1F9FF}'
            | '\u{1FA00}'..='\u{1FA6F}'
            | '\u{1FA70}'..='\u{1FAFF}'
            | '\u{2600}'..='\u{26FF}'
            | '\u{2700}'..='\u{27BF}'
            | '\u{1F1E6}'..='\u{1F1FF}'
        )
    }

    impl TextToSpeech {
        /// Reference: UnicodeProcessor.__call__ — ids are codepoint-indexed,
        /// no BOS/EOS; mask is (B, 1, T).
        fn tokenize(&self, text: &str) -> (Array2<i64>, Array3<f32>, usize) {
            let mut ids: Vec<i64> = Vec::with_capacity(text.len());
            for ch in text.chars() {
                let cp = ch as usize;
                let id = if cp < self.unicode_indexer.table.len() {
                    self.unicode_indexer.table[cp]
                } else {
                    -1
                };
                ids.push(id as i64);
            }
            let len = ids.len().max(1);
            let ids = Array2::from_shape_vec((1, len), ids).expect("ids shape");
            let mask = Array3::from_elem((1, 1, len), 1.0f32);
            (ids, mask, len)
        }

        /// Synthesize one chunk (≤ ~300 chars) to f32 PCM.
        /// Reference: TextToSpeech._infer (py/helper.py).
        fn infer_chunk(
            &mut self,
            chunk: &str,
            lang: &str,
            style: &Style,
            total_step: usize,
            speed: f32,
        ) -> Result<Vec<f32>, String> {
            let processed = preprocess_text(chunk, lang);
            let (text_ids, text_mask, _text_len) = self.tokenize(&processed);

            // 1. Duration prediction — the model outputs total seconds;
            //    speed DIVIDES (higher speed = shorter audio).
            let dp_out = self
                .dp
                .run(ort::inputs![
                    "text_ids" => Value::from_array(text_ids.clone()).map_err(|e| e.to_string())?,
                    "style_dp" => Value::from_array(style.dp.clone()).map_err(|e| e.to_string())?,
                    "text_mask" => Value::from_array(text_mask.clone()).map_err(|e| e.to_string())?
                ])
                .map_err(|e| format!("duration predictor failed: {e}"))?;
            // Model output shape is (batch,) — 1-D.
            let duration: ndarray::Array1<f32> = dp_out["duration"]
                .try_extract_array::<f32>()
                .map_err(|e| e.to_string())?
                .into_dimensionality::<ndarray::Ix1>()
                .map_err(|e| e.to_string())?
                .to_owned();
            let duration_total = duration[0] / speed;

            // 2. Text embedding
            let te_out = self
                .text_encoder
                .run(ort::inputs![
                    "text_ids" => Value::from_array(text_ids).map_err(|e| e.to_string())?,
                    "style_ttl" => Value::from_array(style.ttl.clone()).map_err(|e| e.to_string())?,
                    "text_mask" => Value::from_array(text_mask.clone()).map_err(|e| e.to_string())?,
                ])
                .map_err(|e| format!("text encoder failed: {e}"))?;
            let text_emb: Array3<f32> = te_out["text_emb"]
                .try_extract_array::<f32>()
                .map_err(|e| e.to_string())?
                .into_dimensionality::<ndarray::Ix3>()
                .map_err(|e| e.to_string())?
                .to_owned();

            // 3. Noisy latent + latent mask (reference sample_noisy_latent):
            //    latent length = ceil(wav_len / (base_chunk * ttl_compress)),
            //    latent channels = latent_dim * ttl_compress.
            let wav_len = duration_total * self.sample_rate as f32;
            let chunk_size =
                (self.config.ae.base_chunk_size * self.config.ttl.chunk_compress_factor) as f32;
            let latent_len = ((wav_len + chunk_size - 1.0) / chunk_size).ceil().max(1.0) as usize;
            let latent_mask = Array3::from_elem((1, 1, latent_len), 1.0f32);
            let latent_dim_total =
                (self.config.ttl.latent_dim * self.config.ttl.chunk_compress_factor) as usize;
            let mut current_latent = sample_noisy_latent(latent_dim_total, latent_len);
            current_latent *= &latent_mask;

            // 4. Iterative denoising (vector estimator); steps are (B,) f32.
            for step in 0..total_step {
                let current_step = ndarray::Array1::from_vec(vec![step as f32]);
                let total_step_arr = ndarray::Array1::from_vec(vec![total_step as f32]);
                let ve_out = self
                    .vector_estimator
                    .run(ort::inputs![
                        "noisy_latent" => Value::from_array(current_latent.clone()).map_err(|e| e.to_string())?,
                        "text_emb" => Value::from_array(text_emb.clone()).map_err(|e| e.to_string())?,
                        "style_ttl" => Value::from_array(style.ttl.clone()).map_err(|e| e.to_string())?,
                        "latent_mask" => Value::from_array(latent_mask.clone()).map_err(|e| e.to_string())?,
                        "text_mask" => Value::from_array(text_mask.clone()).map_err(|e| e.to_string())?,
                        "current_step" => Value::from_array(current_step).map_err(|e| e.to_string())?,
                        "total_step" => Value::from_array(total_step_arr).map_err(|e| e.to_string())?,
                    ])
                    .map_err(|e| format!("vector estimator failed: {e}"))?;
                current_latent = ve_out["denoised_latent"]
                    .try_extract_array::<f32>()
                    .map_err(|e| e.to_string())?
                    .into_dimensionality::<ndarray::Ix3>()
                    .map_err(|e| e.to_string())?
                    .to_owned();
            }

            // 5. Vocoder → (1, T) waveform, trimmed to the predicted duration.
            let voc_out = self
                .vocoder
                .run(ort::inputs![
                    "latent" => Value::from_array(current_latent).map_err(|e| e.to_string())?,
                ])
                .map_err(|e| format!("vocoder failed: {e}"))?;
            let wav: Array2<f32> = voc_out["wav_tts"]
                .try_extract_array::<f32>()
                .map_err(|e| e.to_string())?
                .into_dimensionality::<ndarray::Ix2>()
                .map_err(|e| e.to_string())?
                .to_owned();

            let mut samples: Vec<f32> = wav.iter().copied().collect();
            let trim_len = (duration_total * self.sample_rate as f32) as usize;
            samples.truncate(trim_len.min(samples.len()));
            Ok(samples)
        }

        /// Synthesize arbitrary text: chunks long input and joins with silence.
        pub fn synthesize(
            &mut self,
            text: &str,
            lang: &str,
            style: &Style,
            total_step: usize,
            speed: f32,
        ) -> Result<Vec<f32>, String> {
            let chunks = chunk_text(text, max_chunk_chars(lang));
            let mut out: Vec<f32> = Vec::new();
            let silence_len = (0.08 * self.sample_rate as f32) as usize;
            for (index, chunk) in chunks.iter().enumerate() {
                let mut samples = self.infer_chunk(chunk, lang, style, total_step, speed)?;
                if index + 1 < chunks.len() {
                    samples.extend(std::iter::repeat_n(0.0f32, silence_len));
                }
                out.extend(samples);
            }
            Ok(out)
        }
    }

    /// Standard-normal latent noise (reference uses np.random.randn).
    fn sample_noisy_latent(dim: usize, len: usize) -> Array3<f32> {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let mut latent = Array3::<f32>::zeros((1, dim, len.max(1)));
        for v in latent.iter_mut() {
            // Box–Muller over two uniforms.
            let u1: f32 = rng.gen_range(0.0..1.0f32).max(f32::MIN_POSITIVE);
            let u2: f32 = rng.gen_range(0.0..1.0f32);
            *v = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
        }
        latent
    }

    /// Longest chunk the model is given at once, in characters. Korean and
    /// Japanese pack far more speech into each character, so they get less.
    pub fn max_chunk_chars(lang: &str) -> usize {
        if lang == "ko" || lang == "ja" {
            120
        } else {
            300
        }
    }

    /// Sentence-final punctuation in alphabetic scripts (a run such as `...`,
    /// `?!` or `…` counts as one terminator).
    const TERMINATORS: &[char] = &['.', '!', '?', '…', '‼', '⁇', '⁈', '⁉'];
    /// Full-width terminators: CJK writes no space after them, so they always end a sentence.
    const CJK_TERMINATORS: &[char] = &['。', '！', '？', '｡'];
    /// Closing quotes and brackets that belong to the sentence they follow.
    const CLOSERS: &[char] = &[
        '"', '\'', '”', '’', ')', ']', '}', '»', '›', '」', '』', '）', '】', '〉', '》', '〕',
        '］', '｝',
    ];
    /// Opening quotes and brackets, skipped when looking at the next word.
    const OPENERS: &[char] = &[
        '"', '\'', '“', '‘', '(', '[', '{', '«', '‹', '「', '『', '（', '【', '〈', '《', '〔',
    ];
    /// Where an over-long sentence may be divided (the mark stays on the left).
    const CLAUSE_BREAKS: &[char] = &[',', ';', ':', '、', '，', '；', '：'];
    /// A line this short with no closing punctuation, followed by a capitalised
    /// line, is a heading rather than a wrapped line of prose.
    const HEADING_MAX_CHARS: usize = 60;
    /// Abbreviations that do not end a sentence even before a capital letter
    /// (compared lowercase, without the final dot).
    const NON_TERMINAL_ABBREVIATIONS: &[&str] = &[
        "mr", "mrs", "ms", "mx", "dr", "prof", "st", "gen", "col", "lt", "capt", "cpt", "sgt",
        "rev", "hon", "maj", "cmdr", "adm", "gov", "pres", "sen", "rep", "fr", "mt", "ft", "jr",
        "sr", "vs", "v", "e.g", "i.e", "cf", "fig", "figs", "pp", "p", "ch", "chap", "vol", "vols",
        "approx", "dept", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
        "nov", "dec", "u.s", "u.k", "u.n", "u.s.a", "e.u",
    ];
    /// Abbreviations that only stay inside the sentence before a number ("No. 5"):
    /// "no." is also an ordinary word that ends sentences.
    const NUMBER_ABBREVIATIONS: &[&str] = &["no", "nos"];

    fn is_terminator(c: char) -> bool {
        TERMINATORS.contains(&c) || CJK_TERMINATORS.contains(&c)
    }

    fn has_speech(text: &str) -> bool {
        text.chars().any(char::is_alphanumeric)
    }

    /// Split text into synthesis chunks, one sentence each: blocks (paragraphs
    /// and headings) → sentences → for a sentence over `max_chars`, clauses
    /// packed greedily → words → characters. Chunks are slices of the input,
    /// trimmed; nothing is added, and chunks with nothing to say are dropped.
    pub fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
        let max_chars = max_chars.max(1);
        let mut chunks = Vec::new();
        for block in split_blocks(text) {
            for sentence in split_sentences(&block) {
                if sentence.chars().count() <= max_chars {
                    chunks.push(sentence.to_string());
                } else {
                    pack_long_sentence(sentence, max_chars, &mut chunks);
                }
            }
        }
        chunks.retain(|c| has_speech(c));
        chunks
    }

    /// Paragraphs (blank lines) and headings (a short unpunctuated line before
    /// a capitalised one) each start a new block; other line breaks are wraps.
    fn split_blocks(text: &str) -> Vec<String> {
        let lines: Vec<&str> = text.split('\n').map(str::trim).collect();
        let mut blocks = Vec::new();
        let mut current = String::new();
        for (index, line) in lines.iter().enumerate() {
            if line.is_empty() {
                if !current.is_empty() {
                    blocks.push(std::mem::take(&mut current));
                }
                continue;
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(line);
            if is_heading_line(line, lines.get(index + 1).copied()) {
                blocks.push(std::mem::take(&mut current));
            }
        }
        if !current.is_empty() {
            blocks.push(current);
        }
        blocks
    }

    fn is_heading_line(line: &str, next: Option<&str>) -> bool {
        let Some(next) = next.filter(|n| !n.is_empty()) else {
            return false;
        };
        if line.chars().count() > HEADING_MAX_CHARS {
            return false;
        }
        let core = line.trim_end_matches(CLOSERS);
        match core.chars().last() {
            Some(c) if is_terminator(c) || CLAUSE_BREAKS.contains(&c) || c == '-' => return false,
            None => return false,
            _ => {}
        }
        // Capitalised (or caseless, as in CJK) next line: a new block starts.
        next.chars()
            .find(|c| !OPENERS.contains(c))
            .is_some_and(|c| (c.is_alphabetic() && !c.is_lowercase()) || c.is_numeric())
    }

    /// Sentences of one block, as trimmed slices. A terminator run ends a
    /// sentence (with any closing quotes/brackets) when whitespace and a word
    /// that is not lowercase follow, unless the word before it is an
    /// abbreviation or an initial. Full-width terminators always end one.
    fn split_sentences(block: &str) -> Vec<&str> {
        let mut sentences: Vec<&str> = Vec::new();
        let mut start = 0usize;
        let mut i = 0usize;
        while let Some(ch) = block[i..].chars().next() {
            if !is_terminator(ch) {
                i += ch.len_utf8();
                continue;
            }
            let run_start = i;
            let mut cjk = false;
            let mut j = i;
            while let Some(c) = block[j..].chars().next().filter(|c| is_terminator(*c)) {
                cjk |= CJK_TERMINATORS.contains(&c);
                j += c.len_utf8();
            }
            let run_end = j;
            while let Some(c) = block[j..].chars().next().filter(|c| CLOSERS.contains(c)) {
                j += c.len_utf8();
            }
            let end = j;
            let rest = &block[end..];
            let after = rest.trim_start();
            let spaced = after.len() < rest.len();
            // No space after it ("3.5", "example.com") or a lowercase word next
            // ("Wait... what?", "\"Stop!\" she cried"): the sentence goes on.
            let continues = !spaced
                || after
                    .chars()
                    .find(|c| !OPENERS.contains(c))
                    .is_some_and(char::is_lowercase);
            let ends = if after.is_empty() || cjk {
                true
            } else if continues {
                false
            } else if &block[run_start..run_end] == "." && end == run_end {
                !is_non_terminal_abbreviation(&block[start..run_start], after)
            } else {
                true
            };
            if ends {
                push_sentence(&mut sentences, block, start, end);
                start = end;
            }
            i = end;
        }
        push_sentence(&mut sentences, block, start, block.len());
        sentences
    }

    /// Adds `block[start..end]`; a piece with nothing to say (a lone `...`)
    /// joins the sentence before it instead of becoming a chunk.
    fn push_sentence<'a>(sentences: &mut Vec<&'a str>, block: &'a str, start: usize, end: usize) {
        let piece = block[start..end].trim();
        if piece.is_empty() {
            return;
        }
        if !has_speech(piece) {
            if let Some(last) = sentences.last_mut() {
                // Both are slices of `block`: widen the previous one over the piece.
                let last_start = last.as_ptr() as usize - block.as_ptr() as usize;
                *last = block[last_start..end].trim();
            }
            return;
        }
        sentences.push(piece);
    }

    fn is_non_terminal_abbreviation(before: &str, after: &str) -> bool {
        let token = before
            .rsplit(char::is_whitespace)
            .next()
            .unwrap_or("")
            .trim_start_matches(OPENERS);
        let mut letters = token.chars();
        if let (Some(c), None) = (letters.next(), letters.next()) {
            // An initial ("J. R. R. Tolkien"), but "I." is the pronoun.
            return c.is_uppercase() && c != 'I';
        }
        let lower = token.to_lowercase();
        if NON_TERMINAL_ABBREVIATIONS.contains(&lower.as_str()) {
            return true;
        }
        NUMBER_ABBREVIATIONS.contains(&lower.as_str())
            && after.chars().next().is_some_and(|c| c.is_ascii_digit())
    }

    /// Divide an over-long sentence at clause marks, packing as many clauses
    /// into each chunk as fit; a clause that alone is too long is word-wrapped.
    fn pack_long_sentence(sentence: &str, max_chars: usize, out: &mut Vec<String>) {
        let mut clause_ends: Vec<usize> = sentence
            .char_indices()
            .filter(|(_, c)| CLAUSE_BREAKS.contains(c))
            .map(|(i, c)| i + c.len_utf8())
            .collect();
        if clause_ends.last() != Some(&sentence.len()) {
            clause_ends.push(sentence.len());
        }
        let mut chunk_start = 0usize;
        let mut chunk_end = 0usize;
        for clause_end in clause_ends {
            let candidate = sentence[chunk_start..clause_end].trim();
            if candidate.chars().count() <= max_chars {
                chunk_end = clause_end;
                continue;
            }
            if chunk_end > chunk_start {
                out.push(sentence[chunk_start..chunk_end].trim().to_string());
                chunk_start = chunk_end;
            }
            let clause = sentence[chunk_start..clause_end].trim();
            if clause.chars().count() <= max_chars {
                chunk_end = clause_end;
            } else {
                wrap_words(clause, max_chars, out);
                chunk_start = clause_end;
                chunk_end = clause_end;
            }
        }
        if chunk_end > chunk_start {
            let tail = sentence[chunk_start..chunk_end].trim();
            if !tail.is_empty() {
                out.push(tail.to_string());
            }
        }
    }

    /// Last resort: wrap at spaces, and cut words (or unspaced CJK runs) longer
    /// than the limit by characters.
    fn wrap_words(text: &str, max_chars: usize, out: &mut Vec<String>) {
        let mut current = String::new();
        let mut current_len = 0usize;
        for word in text.split_whitespace() {
            let word_len = word.chars().count();
            if word_len > max_chars {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
                current_len = 0;
                for c in word.chars() {
                    if current_len == max_chars {
                        out.push(std::mem::take(&mut current));
                        current_len = 0;
                    }
                    current.push(c);
                    current_len += 1;
                }
                continue;
            }
            let sep = usize::from(!current.is_empty());
            if current_len + sep + word_len > max_chars {
                out.push(std::mem::take(&mut current));
                current_len = 0;
            }
            if !current.is_empty() {
                current.push(' ');
                current_len += 1;
            }
            current.push_str(word);
            current_len += word_len;
        }
        if !current.is_empty() {
            out.push(current);
        }
    }

    /// Load the voice style vectors from `voices/<name>.json`.
    pub fn load_style(voices_dir: &Path, voice: &str) -> Result<Style, String> {
        #[derive(serde::Deserialize)]
        struct StyleArray {
            data: Vec<Vec<Vec<f32>>>,
        }
        #[derive(serde::Deserialize)]
        struct VoiceStyleData {
            #[serde(rename = "style_ttl")]
            style_ttl: StyleArray,
            #[serde(rename = "style_dp")]
            style_dp: StyleArray,
        }

        let path = voices_dir.join(format!("{voice}.json"));
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("Cannot read voice style {}: {e}", path.display()))?;
        let data: VoiceStyleData = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid voice style JSON {voice}: {e}"))?;

        let ttl_dims = (
            data.style_ttl.data.len(),
            data.style_ttl.data.first().map(|d| d.len()).unwrap_or(0),
            data.style_ttl
                .data
                .first()
                .and_then(|d| d.first())
                .map(|d| d.len())
                .unwrap_or(0),
        );
        let dp_dims = (
            data.style_dp.data.len(),
            data.style_dp.data.first().map(|d| d.len()).unwrap_or(0),
            data.style_dp
                .data
                .first()
                .and_then(|d| d.first())
                .map(|d| d.len())
                .unwrap_or(0),
        );

        let ttl_flat: Vec<f32> = data
            .style_ttl
            .data
            .iter()
            .flat_map(|m| m.iter().flat_map(|r| r.iter().copied()))
            .collect();
        let dp_flat: Vec<f32> = data
            .style_dp
            .data
            .iter()
            .flat_map(|m| m.iter().flat_map(|r| r.iter().copied()))
            .collect();

        Ok(Style {
            ttl: Array3::from_shape_vec(ttl_dims, ttl_flat)
                .map_err(|e| format!("style_ttl shape mismatch: {e}"))?,
            dp: Array3::from_shape_vec(dp_dims, dp_flat)
                .map_err(|e| format!("style_dp shape mismatch: {e}"))?,
        })
    }

    // ── Engine lifecycle + Tauri commands ────────────────────────────────────────

    pub static ENGINE: OnceLock<Mutex<Option<TextToSpeech>>> = OnceLock::new();

    pub fn engine_slot() -> &'static Mutex<Option<TextToSpeech>> {
        ENGINE.get_or_init(|| Mutex::new(None))
    }

    pub fn unload_engine() -> Result<(), String> {
        let mut slot = engine_slot().lock().map_err(|e| e.to_string())?;
        *slot = None;
        #[cfg(target_os = "linux")]
        unsafe {
            libc::malloc_trim(0);
        }
        Ok(())
    }

    pub fn ort_dir(app: &tauri::AppHandle) -> PathBuf {
        crate::tts_model::tts_dir(app).join("runtime")
    }

    pub fn models_dir(app: &tauri::AppHandle) -> PathBuf {
        crate::tts_model::tts_dir(app).join("models")
    }

    pub fn voices_dir(app: &tauri::AppHandle) -> PathBuf {
        crate::tts_model::tts_dir(app).join("voices")
    }

    pub fn runtime_lib_name() -> &'static str {
        #[cfg(target_os = "linux")]
        {
            "libonnxruntime.so"
        }
        #[cfg(target_os = "macos")]
        {
            "libonnxruntime.dylib"
        }
        #[cfg(target_os = "windows")]
        {
            "onnxruntime.dll"
        }
    }

    /// Initialize (or reinitialize) the engine: registers the downloaded ORT
    /// library and loads the four sessions. Cheap after the first call.
    pub fn ensure_engine(app: &tauri::AppHandle) -> Result<(), String> {
        let mut slot = engine_slot().lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Ok(());
        }
        let engine = load_engine_at(&crate::tts_model::tts_dir(app))?;
        *slot = Some(engine);
        Ok(())
    }

    /// Load the engine from a tts base dir (`runtime/`, `models/`, `voices/`).
    pub fn load_engine_at(base: &Path) -> Result<TextToSpeech, String> {
        let lib_path = base.join("runtime").join(runtime_lib_name());
        if !lib_path.exists() {
            return Err("ONNX Runtime library is not downloaded yet".to_string());
        }
        let models = base.join("models");
        for required in [
            "duration_predictor.onnx",
            "text_encoder.onnx",
            "vector_estimator.onnx",
            "vocoder.onnx",
            "tts.json",
            "unicode_indexer.json",
        ] {
            if !models.join(required).exists() {
                return Err(format!("Model file missing: {required}"));
            }
        }

        static ORT_INIT: OnceLock<Result<(), String>> = OnceLock::new();
        let init_result = ORT_INIT.get_or_init(|| {
            let _ = ort::init_from(&lib_path)
                .map_err(|e| format!("Failed to load ONNX Runtime from {lib_path:?}: {e:?}"))?
                .commit();
            Ok(())
        });
        if let Err(err) = init_result {
            return Err(err.clone());
        }

        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8))
            .unwrap_or(4);
        let load_session = |name: &str| -> Result<Session, String> {
            // Note: no explicit graph-optimization level — the default is
            // ORT_ENABLE_ALL, and some ort enum values are rejected by the
            // downloaded runtime ("graph_optimization_level is not valid").
            Session::builder()
                .map_err(|e| e.to_string())?
                .with_intra_threads(threads)
                .map_err(|e| e.to_string())?
                .commit_from_file(models.join(name))
                .map_err(|e| format!("Failed to load {name}: {e}"))
        };

        let cfg_text = std::fs::read_to_string(models.join("tts.json"))
            .map_err(|e| format!("Cannot read tts.json: {e}"))?;
        let tts_config: TtsConfig =
            serde_json::from_str(&cfg_text).map_err(|e| format!("Invalid tts.json: {e}"))?;
        let indexer_text = std::fs::read_to_string(models.join("unicode_indexer.json"))
            .map_err(|e| format!("Cannot read unicode_indexer.json: {e}"))?;
        let unicode_indexer: UnicodeIndexer = serde_json::from_str(&indexer_text)
            .map_err(|e| format!("Invalid unicode_indexer.json: {e}"))?;

        let sample_rate = tts_config.ae.sample_rate;
        Ok(TextToSpeech {
            dp: load_session("duration_predictor.onnx")?,
            text_encoder: load_session("text_encoder.onnx")?,
            vector_estimator: load_session("vector_estimator.onnx")?,
            vocoder: load_session("vocoder.onnx")?,
            config: tts_config,
            unicode_indexer,
            sample_rate,
        })
    }

    pub fn cache_dir(app: &tauri::AppHandle) -> PathBuf {
        crate::tts_model::tts_dir(app).join("cache")
    }

    const CACHE_LIMIT_BYTES: u64 = 150_000_000; // 150MB LRU cap

    pub fn trim_cache(dir: &Path, limit: u64) {
        let mut files: Vec<(std::time::SystemTime, PathBuf, u64)> = Vec::new();
        let mut total = 0u64;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    total += meta.len();
                    let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    files.push((modified, entry.path(), meta.len()));
                }
            }
        }
        if total <= limit {
            return;
        }
        files.sort_by_key(|(mtime, _, _)| *mtime);
        let mut excess = total - limit;
        for (_, path, size) in files {
            if excess == 0 {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                excess = excess.saturating_sub(size);
            }
        }
    }

    pub fn cache_key(text: &str, voice: &str, speed: f32) -> String {
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        hasher.update(voice.as_bytes());
        hasher.update(speed.to_le_bytes());
        hex::encode(hasher.finalize())
    }

    #[derive(Serialize)]
    pub struct SynthesisResult {
        pub path: String,
        pub duration_sec: f32,
        pub cached: bool,
    }

    /// Write mono 16-bit WAV (reference-compatible format).
    pub fn write_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec)
            .map_err(|e| format!("Failed to create WAV: {e}"))?;
        for &sample in samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let int = (clamped * i16::MAX as f32) as i16;
            writer
                .write_sample(int)
                .map_err(|e| format!("WAV write failed: {e}"))?;
        }
        writer
            .finalize()
            .map_err(|e| format!("WAV finalize failed: {e}"))
    }
    // ── Command implementation bodies ────────────────────────────────────────

    /// Synthesize `text` (one page / one generation unit) to a cached WAV file.
    pub async fn tts_synthesize_impl(
        app: tauri::AppHandle,
        text: String,
        voice: String,
        speed: f32,
        lang: String,
    ) -> Result<SynthesisResult, String> {
        tokio::task::spawn_blocking(move || {
            let key = cache_key(&text, &voice, speed);
            let dir = cache_dir(&app);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let out_path = dir.join(format!("{key}.wav"));
            if let Ok(meta) = std::fs::metadata(&out_path) {
                if meta.len() > 44 {
                    let duration = (meta.len() - 44) as f32 / 2.0 / SAMPLE_RATE;
                    return Ok(SynthesisResult {
                        path: out_path.display().to_string(),
                        duration_sec: duration,
                        cached: true,
                    });
                }
            }

            ensure_engine(&app)?;
            let style = load_style(&voices_dir(&app), &voice)?;
            let mut slot = engine_slot().lock().map_err(|e| e.to_string())?;
            let engine = slot
                .as_mut()
                .ok_or_else(|| "Engine not initialized".to_string())?;

            let samples = engine.synthesize(&text, &lang, &style, 8, speed)?;
            let duration_sec = samples.len() as f32 / engine.sample_rate as f32;

            write_wav(&out_path, &samples, engine.sample_rate)?;
            std::thread::spawn(move || {
                trim_cache(&dir, CACHE_LIMIT_BYTES);
            });

            Ok(SynthesisResult {
                path: out_path.display().to_string(),
                duration_sec,
                cached: false,
            })
        })
        .await
        .map_err(|e| format!("Synthesis task failed: {e}"))?
    }

    /// Fire-and-forget prefetch of the next page.
    pub async fn tts_prefetch_impl(
        app: tauri::AppHandle,
        text: String,
        voice: String,
        speed: f32,
        lang: String,
    ) -> Result<(), String> {
        let key = cache_key(&text, &voice, speed);
        let out_path = cache_dir(&app).join(format!("{key}.wav"));
        if out_path.exists() {
            return Ok(());
        }
        tokio::spawn(async move {
            let _ = tts_synthesize_impl(app, text, voice, speed, lang).await;
        });
        Ok(())
    }

    /// Engine readiness for the frontend.
    /// Warm up the engine (ORT init + session loads) so the first speak
    /// doesn't pay the ~seconds of model loading.
    pub fn tts_engine_preload_impl(app: tauri::AppHandle) -> Result<(), String> {
        ensure_engine(&app)
    }

    /// Sentence-aware chunk list for streaming synthesis (frontend feeds
    /// chunks one by one so audio starts after the first one is ready).
    pub fn tts_text_chunks_impl(text: String, lang: String) -> Result<Vec<String>, String> {
        Ok(chunk_text(&text, max_chunk_chars(&lang)))
    }

    /// Engine readiness for the frontend.
    pub fn tts_neural_status_impl(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
        let runtime = ort_dir(&app).join(runtime_lib_name()).exists();
        let models = models_dir(&app).join("vector_estimator.onnx").exists()
            && models_dir(&app).join("vocoder.onnx").exists()
            && models_dir(&app).join("text_encoder.onnx").exists()
            && models_dir(&app).join("duration_predictor.onnx").exists();
        let loaded = engine_slot()
            .lock()
            .map(|slot| slot.is_some())
            .unwrap_or(false);
        Ok(serde_json::json!({
            "runtimeReady": runtime,
            "modelsReady": models,
            "engineLoaded": loaded,
            "available": runtime && models,
            "supported": crate::tts_model::platform_supported(),
        }))
    }

    /// Real-inference smoke test against the downloaded models. Run
    /// explicitly: `cargo test --lib supertonic -- --ignored --nocapture`
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn blank_text_has_no_chunks() {
            for blank in ["", "   ", "\n\n", " \t\n "] {
                assert!(chunk_text(blank, 300).is_empty(), "{blank:?}");
            }
        }

        #[test]
        fn text_without_sentence_punctuation_is_one_chunk() {
            assert_eq!(
                chunk_text("  no punctuation here  ", 300),
                ["no punctuation here"]
            );
        }

        #[test]
        fn long_runs_are_wrapped_within_the_limit() {
            let words = vec!["word"; 200].join(" ");
            let chunks = chunk_text(&words, 100);
            assert!(chunks.len() > 1);
            assert!(chunks.iter().all(|c| c.chars().count() <= 100));
            assert_eq!(chunks.join(" ").split_whitespace().count(), 200);
        }

        fn chunks(text: &str) -> Vec<String> {
            chunk_text(text, 300)
        }

        /// No chunk may be only punctuation or whitespace: the model reads those as noise.
        fn assert_speakable(chunks: &[String]) {
            for c in chunks {
                assert!(
                    c.chars().any(char::is_alphanumeric),
                    "punctuation-only chunk {c:?}"
                );
                assert_eq!(c.trim(), c, "untrimmed chunk {c:?}");
            }
        }

        #[test]
        fn closing_quotes_and_brackets_stay_with_their_sentence() {
            assert_eq!(chunks("\"Hello.\" He said."), ["\"Hello.\"", "He said."]);
            assert_eq!(
                chunks("\u{201C}Stop!\u{201D} She ran. (He left.) Then she came."),
                [
                    "\u{201C}Stop!\u{201D}",
                    "She ran.",
                    "(He left.)",
                    "Then she came."
                ]
            );
            assert_eq!(
                chunks("'Really?' asked Tom. [Sic.] Done."),
                ["'Really?' asked Tom.", "[Sic.]", "Done."]
            );
        }

        #[test]
        fn ellipses_are_one_terminator_and_never_a_chunk_of_their_own() {
            assert_eq!(
                chunks("Wait... what? He paused... then left."),
                ["Wait... what?", "He paused... then left."]
            );
            assert_eq!(chunks("Wait\u{2026} What?"), ["Wait\u{2026}", "What?"]);
            assert_eq!(chunks("Really?! Yes."), ["Really?!", "Yes."]);
            let c = chunks("Hello. ... World. \u{2026} Done.");
            assert_speakable(&c);
            assert_eq!(c.concat().matches("World").count(), 1);
            assert!(chunks("...").is_empty());
            assert!(chunks("* * *").is_empty());
            assert!(chunks("\u{2026} ! ?").is_empty());
        }

        #[test]
        fn continuation_is_judged_by_the_word_after_the_space() {
            // A lowercase word after the gap continues the sentence.
            assert_eq!(
                chunks("\"Stop!\" she cried. Then quiet."),
                ["\"Stop!\" she cried.", "Then quiet."]
            );
            assert_eq!(
                chunks("He said \"Go.\" and left."),
                ["He said \"Go.\" and left."]
            );
            // No space after the dot is not a sentence end (decimals, domains).
            assert_eq!(
                chunks("It grew 3.5 times at example.com today."),
                ["It grew 3.5 times at example.com today."]
            );
        }

        #[test]
        fn abbreviations_and_initials_do_not_end_sentences() {
            assert_eq!(
                chunks("Gen. Grant met Lt. Col. Smith at 3 p.m. on Jan. 5, 1864. They spoke."),
                [
                    "Gen. Grant met Lt. Col. Smith at 3 p.m. on Jan. 5, 1864.",
                    "They spoke."
                ]
            );
            assert_eq!(
                chunks("The U.S. economy grew. The U.K. Parliament met."),
                ["The U.S. economy grew.", "The U.K. Parliament met."]
            );
            assert_eq!(
                chunks(
                    "See Fig. 3 and pp. 12-14 for details. Also cf. ch. 4 and vol. 2. No. 7 won."
                ),
                [
                    "See Fig. 3 and pp. 12-14 for details.",
                    "Also cf. ch. 4 and vol. 2.",
                    "No. 7 won."
                ]
            );
            assert_eq!(
                chunks("J. R. R. Tolkien wrote it. George W. Bush read it."),
                ["J. R. R. Tolkien wrote it.", "George W. Bush read it."]
            );
            assert_eq!(
                chunks("Mr. and Mrs. Smith met Dr. Jones, Prof. Plum, Ms. Lee, St. John, Capt. Hook, Sgt. Pepper, Rev. Green and Hon. Ward. Mr. Smith Jr. and Sr. Ortiz came. Bob vs. Al, e.g. Paris, i.e. France."),
                [
                    "Mr. and Mrs. Smith met Dr. Jones, Prof. Plum, Ms. Lee, St. John, Capt. Hook, Sgt. Pepper, Rev. Green and Hon. Ward.",
                    "Mr. Smith Jr. and Sr. Ortiz came.",
                    "Bob vs. Al, e.g. Paris, i.e. France.",
                ]
            );
            // Months, and the ones that can end a sentence still do before a capital.
            assert_eq!(
                chunks("Born on Feb. 3 and died Dec. 9. The meeting ended at 5 p.m. Everyone left, etc. Then quiet."),
                ["Born on Feb. 3 and died Dec. 9.", "The meeting ended at 5 p.m.", "Everyone left, etc.", "Then quiet."]
            );
        }

        #[test]
        fn long_sentences_are_packed_at_commas_up_to_the_limit() {
            let sentence = "He said, \"I have three things to say: first, that the long and winding road, which nobody had ever travelled before, led nowhere at all; second, that the old man, who had lived in the village for more than eighty years and had seen everything there was to see, knew this perfectly well; and third, that nobody would ever believe him, no matter how many times he said it, because that is simply how people are.\"";
            assert!(sentence.chars().count() > 300);
            let c = chunks(sentence);
            assert_speakable(&c);
            assert_eq!(c.len(), 2, "{c:?}");
            assert!(c.iter().all(|x| x.chars().count() <= 300));
            // Split only where the text has a comma, semicolon or colon; nothing added.
            assert!(c[0].ends_with([',', ';', ':']), "{:?}", c[0]);
            assert_eq!(c.join(" "), sentence);
            // A sentence that fits is never split at its commas.
            let short = "One, two, three, four, five, six, seven, eight, nine, ten.";
            assert_eq!(chunks(short), [short]);
        }

        #[test]
        fn cjk_splits_on_full_width_terminators_within_the_language_limit() {
            let ja = "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。この書生というのは時々我々を捕えて煮て食うという話である。しかしその当時は何という考もなかったから別段恐しいとも思わなかった。ただ彼の掌に載せられてスーと持ち上げられた時何だかフワフワした感じがあったばかりである。";
            assert!(ja.chars().count() > 200);
            let c = chunk_text(ja, max_chunk_chars("ja"));
            assert_eq!(c.len(), ja.matches('。').count(), "{c:?}");
            assert!(c
                .iter()
                .all(|x| x.ends_with('。') && x.chars().count() <= 120));
            assert_eq!(c.concat(), ja);

            assert_eq!(
                chunks("这是第一句话。这是第二句话！这是第三句话？"),
                ["这是第一句话。", "这是第二句话！", "这是第三句话？"]
            );
            assert_eq!(
                chunks("「はい。」「いいえ。」"),
                ["「はい。」", "「いいえ。」"]
            );

            // A run with no punctuation at all is cut by characters, not lost or left too long.
            let run: String = "猫".repeat(250);
            let c = chunk_text(&run, 120);
            assert!(c.iter().all(|x| x.chars().count() <= 120), "{c:?}");
            assert_eq!(c.concat(), run);
            // Full-width commas are clause breaks for packing.
            let long = format!(
                "{}、{}、{}。",
                "あ".repeat(70),
                "い".repeat(70),
                "う".repeat(70)
            );
            let c = chunk_text(&long, 120);
            assert_eq!(c.len(), 3, "{c:?}");
            assert_eq!(c.concat(), long);
        }

        #[test]
        fn headings_and_paragraph_breaks_end_a_chunk() {
            assert_eq!(
                chunks("Chapter One\nIt was a dark and stormy night."),
                ["Chapter One", "It was a dark and stormy night."]
            );
            assert_eq!(
                chunks("CHAPTER IV\n\nThe Return\n\"Hello,\" said Tom."),
                ["CHAPTER IV", "The Return", "\"Hello,\" said Tom."]
            );
            assert_eq!(
                chunks("First paragraph without a stop\n\nsecond paragraph here."),
                ["First paragraph without a stop", "second paragraph here."]
            );
            // A line wrapped inside a sentence is not a heading.
            assert_eq!(
                chunks("It was the best of times, it was the worst\nof times, it was the age of wisdom."),
                ["It was the best of times, it was the worst of times, it was the age of wisdom."]
            );
            assert_eq!(
                chunks("Line one\r\n\r\nLine two."),
                ["Line one", "Line two."]
            );
        }

        #[test]
        fn language_limits() {
            assert_eq!(max_chunk_chars("ja"), 120);
            assert_eq!(max_chunk_chars("ko"), 120);
            assert_eq!(max_chunk_chars("en"), 300);
            assert_eq!(max_chunk_chars("fr"), 300);
        }

        #[test]
        #[ignore]
        fn real_synthesis_produces_speech() {
            let home = std::env::var("HOME").unwrap_or_default();
            let base = std::env::var("THEOREM_TTS_DIR")
                .unwrap_or_else(|_| format!("{home}/.local/share/work.fundamentals.theorem/tts"));
            let base = Path::new(&base);
            let mut engine = load_engine_at(base).expect("engine load");
            let style = load_style(&base.join("voices"), "F1").expect("style");

            let samples = engine
                .synthesize(
                    "Hello world, this is a test of the neural voice engine.",
                    "en",
                    &style,
                    8,
                    1.0,
                )
                .expect("synthesis");

            let sec = samples.len() as f32 / engine.sample_rate as f32;
            assert!(sec > 1.0, "output too short: {sec:.2}s");
            let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
            assert!(rms > 0.01, "output is silence (rms={rms})");
            write_wav(
                Path::new("/tmp/supertonic-test.wav"),
                &samples,
                engine.sample_rate,
            )
            .expect("write wav");
            println!("synthesized {sec:.2}s of audio, rms={rms:.4} → /tmp/supertonic-test.wav");
            // Leak the engine: ORT sessions must outlive the runtime teardown
            // when the dylib was loaded at runtime (the app keeps it in a
            // static slot that never drops).
            std::mem::forget(engine);
        }

        #[test]
        #[ignore]
        fn reload_engine_and_synthesize() {
            let home = std::env::var("HOME").unwrap_or_default();
            let base = std::env::var("THEOREM_TTS_DIR")
                .unwrap_or_else(|_| format!("{home}/.local/share/work.fundamentals.theorem/tts"));
            let base = Path::new(&base);
            {
                let mut engine = load_engine_at(base).expect("first engine load");
                let style = load_style(&base.join("voices"), "F1").expect("style");
                let samples = engine
                    .synthesize("First test.", "en", &style, 8, 1.0)
                    .expect("first synthesis");
                assert!(!samples.is_empty());
            }
            {
                let mut engine2 = load_engine_at(base).expect("second engine load after drop");
                let style2 = load_style(&base.join("voices"), "F1").expect("style");
                let samples2 = engine2
                    .synthesize("Second test after reload.", "en", &style2, 8, 1.0)
                    .expect("second synthesis");
                assert!(!samples2.is_empty());
                std::mem::forget(engine2);
            }
        }
    }
}

// ── Tauri commands (real on desktop, no-op stubs on Android) ─────────────────

#[cfg(not(target_os = "android"))]
pub use desktop::SynthesisResult;

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn tts_synthesize(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    speed: f32,
    lang: String,
) -> Result<SynthesisResult, String> {
    desktop::tts_synthesize_impl(app, text, voice, speed, lang).await
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn tts_synthesize(
    _app: tauri::AppHandle,
    _text: String,
    _voice: String,
    _speed: f32,
    _lang: String,
) -> Result<serde_json::Value, String> {
    Err("Neural voice is desktop-only; install Theorem Neural Voice on Android".to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn tts_prefetch(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    speed: f32,
    lang: String,
) -> Result<(), String> {
    desktop::tts_prefetch_impl(app, text, voice, speed, lang).await
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn tts_prefetch(
    _app: tauri::AppHandle,
    _text: String,
    _voice: String,
    _speed: f32,
    _lang: String,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn tts_neural_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    desktop::tts_neural_status_impl(app)
}

#[cfg(target_os = "android")]
pub fn tts_neural_status(_app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "runtimeReady": false,
        "modelsReady": false,
        "engineLoaded": false,
        "available": false,
        "supported": false,
    }))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn tts_engine_preload(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || desktop::tts_engine_preload_impl(app))
        .await
        .map_err(|e| format!("Preload task failed: {e}"))?
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn tts_engine_preload(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn tts_text_chunks(text: String, lang: String) -> Result<Vec<String>, String> {
    desktop::tts_text_chunks_impl(text, lang)
}

#[cfg(target_os = "android")]
pub fn tts_text_chunks(_text: String, _lang: String) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "android"))]
pub fn tts_engine_unload() -> Result<(), String> {
    desktop::unload_engine()
}

#[cfg(target_os = "android")]
pub fn tts_engine_unload() -> Result<(), String> {
    Ok(())
}
