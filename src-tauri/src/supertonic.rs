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
        let mut processed: String = text.nfkd().collect();
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
                    "text_ids" => Value::from_array(text_ids.clone()).map_err(|e| e.to_string())?,
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
            let max_chars = if lang == "ko" || lang == "ja" {
                120
            } else {
                300
            };
            let chunks = chunk_text(text, max_chars);
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

    /// Split text into synthesis chunks: paragraphs → sentences → commas → words.
    pub fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
        let mut chunks = Vec::new();
        for paragraph in text.split("\n\n") {
            for sentence in split_sentences(paragraph) {
                if sentence.chars().count() <= max_chars {
                    chunks.push(sentence);
                    continue;
                }
                for part in sentence.split_in_place_by(|c| c == ',' || c == ';' || c == ':') {
                    let part = part.trim();
                    if part.is_empty() {
                        continue;
                    }
                    if part.chars().count() <= max_chars {
                        chunks.push(format!("{part},"));
                        continue;
                    }
                    // Last resort: hard word-wrap.
                    let mut current = String::new();
                    for word in part.split_whitespace() {
                        if current.chars().count() + word.len() + 1 > max_chars
                            && !current.is_empty()
                        {
                            chunks.push(current.trim().to_string());
                            current.clear();
                        }
                        current.push_str(word);
                        current.push(' ');
                    }
                    if !current.trim().is_empty() {
                        chunks.push(current.trim().to_string());
                    }
                }
            }
        }
        if chunks.is_empty() {
            chunks.push(text.trim().to_string());
        }
        chunks
    }

    trait SplitInPlaceBy {
        fn split_in_place_by(&self, pred: impl Fn(char) -> bool) -> Vec<&str>;
    }
    impl SplitInPlaceBy for str {
        fn split_in_place_by(&self, pred: impl Fn(char) -> bool) -> Vec<&str> {
            self.split_terminator(pred).collect()
        }
    }

    fn split_sentences(text: &str) -> Vec<String> {
        let abbreviations = [
            "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "e.g.", "i.e.", "etc.", "vs.", "St.", "Sr.",
            "Jr.",
        ];
        let mut sentences = Vec::new();
        let mut current = String::new();
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            current.push(ch);
            if matches!(ch, '.' | '!' | '?') {
                // Look ahead: sentence end unless followed by a lowercase letter,
                // a digit, or an abbreviation.
                let next_is_lower = chars.peek().map(|c| c.is_lowercase()).unwrap_or(false);
                let next_is_digit = chars.peek().map(|c| c.is_ascii_digit()).unwrap_or(false);
                let is_abbreviation = abbreviations
                    .iter()
                    .any(|abbr| current.trim_end().ends_with(abbr));
                if !next_is_lower && !next_is_digit && !is_abbreviation {
                    let trimmed = current.trim();
                    if !trimmed.is_empty() {
                        sentences.push(trimmed.to_string());
                    }
                    current.clear();
                }
            }
        }
        let trimmed = current.trim();
        if !trimmed.is_empty() {
            sentences.push(trimmed.to_string());
        }
        sentences
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
            let dir_clone = dir.clone();
            std::thread::spawn(move || {
                trim_cache(&dir_clone, CACHE_LIMIT_BYTES);
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
        let max_chars = if lang == "ko" || lang == "ja" {
            120
        } else {
            300
        };
        Ok(chunk_text(&text, max_chars))
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
        }))
    }

    /// Real-inference smoke test against the downloaded models. Run
    /// explicitly: `cargo test --lib supertonic -- --ignored --nocapture`
    #[cfg(test)]
    mod tests {
        use super::*;

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
#[tauri::command]
pub fn tts_neural_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    desktop::tts_neural_status_impl(app)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_neural_status(_app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "runtimeReady": false,
        "modelsReady": false,
        "engineLoaded": false,
        "available": false,
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
#[tauri::command]
pub fn tts_text_chunks(text: String, lang: String) -> Result<Vec<String>, String> {
    desktop::tts_text_chunks_impl(text, lang)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_text_chunks(_text: String, _lang: String) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn tts_engine_unload() -> Result<(), String> {
    desktop::unload_engine()
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn tts_engine_unload() -> Result<(), String> {
    Ok(())
}
