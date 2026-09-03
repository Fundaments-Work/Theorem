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
    use ort::session::{builder::GraphOptimizationLevel, Session};
    use ort::value::Value;
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use unicode_normalization::UnicodeNormalization;

    pub const SAMPLE_RATE: f32 = 44_100.0;
    /// Latent chunking parameter from the reference implementation.
    const DEFAULT_CHUNK_SIZE: u32 = 108;

    pub struct SupertonicConfig {
        pub sample_rate: u32,
        pub t_chunk: u32,
        pub latent_mask_pad: u32,
        pub latent_shape: Vec<u32>,
    }

    impl Default for TtlConfig {
        fn default() -> Self {
            TtlConfig {
                sample_rate: default_sample_rate(),
                t_chunk: default_t_chunk(),
                latent_mask_pad: 0,
                latent_shape: default_latent_shape(),
            }
        }
    }

    #[derive(serde::Deserialize)]
    struct TtlConfig {
        #[serde(default = "default_sample_rate")]
        sample_rate: u32,
        #[serde(default = "default_t_chunk")]
        t_chunk: u32,
        #[serde(default)]
        latent_mask_pad: u32,
        #[serde(default = "default_latent_shape")]
        latent_shape: Vec<u32>,
    }

    fn default_sample_rate() -> u32 {
        44_100
    }
    fn default_t_chunk() -> u32 {
        DEFAULT_CHUNK_SIZE
    }
    fn default_latent_shape() -> Vec<u32> {
        vec![1, 1, 20, 216]
    }

    impl From<&TtlConfig> for SupertonicConfig {
        fn from(cfg: &TtlConfig) -> Self {
            SupertonicConfig {
                sample_rate: cfg.sample_rate,
                t_chunk: cfg.t_chunk,
                latent_mask_pad: cfg.latent_mask_pad,
                latent_shape: cfg.latent_shape.clone(),
            }
        }
    }

    #[derive(serde::Deserialize)]
    struct AeConfig {
        #[serde(default = "default_encode_rate")]
        semantic_encode_rate: f32,
    }

    impl Default for AeConfig {
        fn default() -> Self {
            AeConfig {
                semantic_encode_rate: default_encode_rate(),
            }
        }
    }

    fn default_encode_rate() -> f32 {
        0.25
    }

    #[derive(serde::Deserialize)]
    struct TtsConfig {
        #[serde(default)]
        ttl: TtlConfig,
        #[serde(default)]
        ae: AeConfig,
    }

    #[derive(serde::Deserialize)]
    struct UnicodeIndexer {
        #[serde(default)]
        values: HashMap<String, i32>,
        #[serde(default = "default_start_id")]
        start_id: i32,
        #[serde(default = "default_end_id")]
        end_id: i32,
        #[serde(default = "default_pad_id")]
        #[allow(dead_code)] // present in tts.json; kept for schema completeness
        pad_id: i32,
    }

    fn default_start_id() -> i32 {
        2
    }
    fn default_end_id() -> i32 {
        1
    }
    fn default_pad_id() -> i32 {
        0
    }

    pub struct TextToSpeech {
        dp: Session,
        text_encoder: Session,
        vector_estimator: Session,
        vocoder: Session,
        cfg: SupertonicConfig,
        ae_config: AeConfig,
        unicode_indexer: UnicodeIndexer,
        pub sample_rate: u32,
    }

    /// Voice style vectors loaded from a `voices/<name>.json` file.
    pub struct Style {
        pub ttl: Array3<f32>,
        pub dp: Array3<f32>,
    }

    fn preprocess_text(text: &str, lang: &str) -> String {
        let mut processed = text.nfkd().to_string();
        // Drop emojis/symbols outside basic scripts (reference behavior).
        processed = processed
            .chars()
            .filter(|c| !is_non_speech_symbol(*c))
            .collect();
        let replacements: &[(&str, &str)] = &[
            ("—", " - "),
            ("–", " - "),
            ("“", "\""),
            ("”", "\""),
            ("‘", "'"),
            ("’", "'"),
            ("«", "\""),
            ("»", "\""),
            ("(", " ("),
            (")", ") "),
            ("[", " ["),
            ("]", "] "),
        ];
        for (from, to) in replacements {
            processed = processed.replace(from, to);
        }
        // Common symbol expansions.
        let expansions: &[(&str, &str)] = &[
            ("@", " at "),
            ("&", " and "),
            ("%", " percent "),
            ("+", " plus "),
            ("=", " equals "),
        ];
        for (from, to) in expansions {
            processed = processed.replace(from, to);
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
        if !cleaned.ends_with(['.', '!', '?']) {
            cleaned.push('.');
        }
        format!("<{lang}>{cleaned}</{lang}>")
    }

    fn is_non_speech_symbol(c: char) -> bool {
        matches!(c,
            '\u{1F000}'..='\u{1FAFF}'   // emoji & pictographs
            | '\u{2600}'..='\u{27BF}'   // misc symbols/dingbats
            | '\u{FE00}'..='\u{FE0F}'   // variation selectors
            | '\u{200D}'                // ZWJ
        )
    }

    impl TextToSpeech {
        fn tokenize(&self, text: &str) -> (Array2<i64>, Array2<f32>, usize) {
            let mut ids: Vec<i64> = Vec::with_capacity(text.len() + 2);
            ids.push(self.unicode_indexer.start_id as i64);
            for ch in text.chars() {
                let id = self
                    .unicode_indexer
                    .values
                    .get(&ch.to_string())
                    .copied()
                    .unwrap_or(-1);
                ids.push(id as i64);
            }
            ids.push(self.unicode_indexer.end_id as i64);
            let len = ids.len();
            let ids = Array2::from_shape_vec((1, len), ids).expect("ids shape");
            let mask = Array2::from_elem((1, len), 1.0f32);
            (ids, mask, len)
        }

        /// Synthesize one chunk (≤ ~300 chars) to f32 PCM.
        fn infer_chunk(
            &mut self,
            chunk: &str,
            lang: &str,
            style: &Style,
            total_step: usize,
            speed: f32,
        ) -> Result<(Vec<f32>, f32), String> {
            let processed = preprocess_text(chunk, lang);
            let (text_ids, text_mask, text_len) = self.tokenize(&processed);

            // 1. Duration prediction
            let dp_out = self
                .dp
                .run(ort::inputs![
                    "text_ids" => Value::from_array(text_ids.clone()).map_err(|e| e.to_string())?,
                    "style_dp" => Value::from_array(style.dp.clone()).map_err(|e| e.to_string())?,
                    "text_mask" => Value::from_array(text_mask.clone()).map_err(|e| e.to_string())?
                ])
                .map_err(|e| format!("duration predictor failed: {e}"))?;
            let duration: Array2<f32> = dp_out["duration"]
                .try_extract_array::<f32>()
                .map_err(|e| e.to_string())?
                .into_dimensionality::<ndarray::Ix2>()
                .map_err(|e| e.to_string())?
                .to_owned();
            let duration = duration * speed;
            let duration_total: f32 = duration.sum();

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

            // 3. Build latent mask from total duration
            let latent_len = ((duration_total
                * self.ae_config.semantic_encode_rate
                * self.cfg.sample_rate as f32
                / (self.cfg.t_chunk as f32 * self.cfg.sample_rate as f32
                    / self.cfg.latent_shape[3] as f32))
                .ceil() as usize)
                .max(text_len);
            let mut latent_mask = Array2::<f32>::zeros((1, latent_len));
            for i in 0..text_len.min(latent_len) {
                latent_mask[[0, i]] = 1.0;
            }

            // 4. Iterative denoising (vector estimator)
            let mut current_latent = sample_noisy_latent(
                duration_total,
                self.cfg.sample_rate,
                self.ae_config.semantic_encode_rate,
                &self.cfg.latent_shape,
                &latent_mask,
            );

            for step in 0..total_step {
                let current_step = Array2::from_elem((1, 1), step as f32);
                let total_step_arr = Array2::from_elem((1, 1), total_step as f32);
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

            // 5. Vocoder
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

            let actual_len = (duration_total * self.cfg.sample_rate as f32) as usize;
            let mut samples: Vec<f32> = wav.iter().copied().collect();
            samples.truncate(actual_len.min(samples.len()));
            Ok((samples, duration_total))
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
            let silence_len = (0.3 * self.cfg.sample_rate as f32) as usize;
            for (index, chunk) in chunks.iter().enumerate() {
                let (mut samples, _) = self.infer_chunk(chunk, lang, style, total_step, speed)?;
                if index + 1 < chunks.len() {
                    samples.extend(std::iter::repeat_n(0.0f32, silence_len));
                }
                out.extend(samples);
            }
            Ok(out)
        }
    }

    fn sample_noisy_latent(
        duration_total: f32,
        sample_rate: u32,
        encode_rate: f32,
        latent_shape: &[u32],
        latent_mask: &Array2<f32>,
    ) -> Array3<f32> {
        use rand::Rng;
        let mut rng = rand::thread_rng();

        let t_len = ((duration_total * encode_rate * sample_rate as f32
            / (latent_shape[3] as f32 * sample_rate as f32 / latent_shape[2] as f32))
            .ceil() as usize)
            .max(latent_mask.len());

        let dim0 = latent_shape[0] as usize;
        let dim1 = latent_shape[1] as usize;
        let mut latent = Array3::<f32>::zeros((dim0, dim1, t_len.max(1)));
        for v in latent.iter_mut() {
            *v = rng.gen_range(-1.0..=1.0);
        }
        // Zero out everything beyond the masked region.
        let masked_len = latent_mask.iter().filter(|v| **v > 0.0).count();
        if masked_len < t_len {
            for b in 0..dim0 {
                for c in 0..dim1 {
                    for t in masked_len..t_len {
                        latent[[b, c, t]] = 0.0;
                    }
                }
            }
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
        let lib_path = ort_dir(app).join(runtime_lib_name());
        if !lib_path.exists() {
            return Err("ONNX Runtime library is not downloaded yet".to_string());
        }
        let models = models_dir(app);
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

        let mut slot = engine_slot().lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Ok(());
        }

        // `commit()` returns bool (panics/logs internally on failure).
        if !ort::init_from(&lib_path)
            .map_err(|e| format!("Failed to load ONNX Runtime from {lib_path:?}: {e:?}"))?
            .commit()
        {
            return Err("Failed to initialize ONNX Runtime".to_string());
        }

        let load_session = |name: &str| -> Result<Session, String> {
            Session::builder()
                .map_err(|e| e.to_string())?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(|e| e.to_string())?
                .with_intra_threads(4)
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

        let ttl = SupertonicConfig::from(&tts_config.ttl);
        let sample_rate = ttl.sample_rate;

        let engine = TextToSpeech {
            dp: load_session("duration_predictor.onnx")?,
            text_encoder: load_session("text_encoder.onnx")?,
            vector_estimator: load_session("vector_estimator.onnx")?,
            vocoder: load_session("vocoder.onnx")?,
            cfg: ttl,
            ae_config: tts_config.ae,
            unicode_indexer,
            sample_rate,
        };
        *slot = Some(engine);
        Ok(())
    }

    pub fn cache_dir(app: &tauri::AppHandle) -> PathBuf {
        crate::tts_model::tts_dir(app).join("cache")
    }

    const CACHE_LIMIT_BYTES: u64 = 1_000_000_000; // 1GB LRU cap

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
        format!("{:x}", hasher.finalize())
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
            trim_cache(&dir, CACHE_LIMIT_BYTES);

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
