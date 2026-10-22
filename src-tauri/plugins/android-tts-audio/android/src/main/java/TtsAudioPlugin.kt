package work.fundamentals.theorem.ttsaudio

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

@InvokeArg
class SpeakArgs {
    var text: String = ""
    var voice: String = ""
    /** Speech rate, 1.0 = normal. Applied on every speak (the engine keeps the last one). */
    var speed: Double? = null
    /** BCP 47 language of the book. */
    var lang: String? = null
    /** Echoed in the utterance events as `utteranceId`, so the app can ignore stale ones. */
    var utteranceId: String? = null
}

@InvokeArg
class SetEngineArgs {
    var engine: String = ""
}

@InvokeArg
class SynthesizeToFileArgs {
    var text: String = ""
    var voice: String = ""
    var fileName: String = ""
}

@TauriPlugin
class TtsAudioPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        private const val TAG = "TtsAudioPlugin"
        private const val SPEAK_DONE_EVENT = "tts-utterance-done"
        private const val SPEAK_RANGE_EVENT = "tts-utterance-range"
        private const val SPEAK_ERROR_EVENT = "tts-utterance-error"
    }

    @Volatile
    private var tts: TextToSpeech? = null
    @Volatile
    private var isInitialized = false

    /** Selected TTS engine package (e.g. a Supertonic engine app). Null = system default. */
    @Volatile
    private var selectedEngine: String? = null

    private val utteranceCounter = AtomicLong(0)

    /** The `utteranceId` being spoken; events of any other utterance are dropped. */
    @Volatile
    private var currentUtterance: String? = null
    /** Engine id of the last queued piece of the current utterance. */
    @Volatile
    private var lastPieceId: String? = null
    /** Where each queued piece starts in the page text, to report page offsets. */
    private val pieceOffsets = ConcurrentHashMap<String, Int>()

    /** Pending synthesizeToFile invokes keyed by utterance id. */
    private val pendingSynthInvokes = ConcurrentHashMap<String, Invoke>()

    private val mainHandler = Handler(Looper.getMainLooper())

    private fun runOnUiThread(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
        } else {
            mainHandler.post(block)
        }
    }

    private fun initTts(callback: (Boolean) -> Unit) {
        initTts(selectedEngine, callback)
    }

    private fun initTts(engine: String?, callback: (Boolean) -> Unit) {
        runOnUiThread {
            try {
                val listener = TextToSpeech.OnInitListener { status ->
                    isInitialized = status == TextToSpeech.SUCCESS
                    Log.i(TAG, "TextToSpeech init (engine=$engine): status=$status")
                    if (isInitialized) {
                        val currentTts = tts
                        if (currentTts != null && engine != null && currentTts.defaultEngine != engine) {
                            // The engine app rejected the request or is missing; surface it.
                            Log.w(TAG, "Requested engine '$engine' but default is '${currentTts.defaultEngine}'")
                        }
                        currentTts?.setOnUtteranceProgressListener(progressListener)
                        currentTts?.setLanguage(Locale.getDefault())
                    }
                    callback(isInitialized)
                }
                tts = if (engine.isNullOrEmpty()) {
                    TextToSpeech(activity, listener)
                } else {
                    TextToSpeech(activity, listener, engine)
                }
            } catch (e: Exception) {
                Log.e(TAG, "TTS init failed: ${e.message}", e)
                isInitialized = false
                callback(false)
            }
        }
    }

    /** The utterance a piece id belongs to, or null when it is not the current one. */
    private fun currentUtteranceOf(id: String?): String? {
        if (id == null) return null
        val utterance = currentUtterance ?: return null
        return if (id.startsWith("$utterance#")) utterance else null
    }

    private fun utteranceEvent(id: String, utterance: String): JSObject {
        val data = JSObject()
        data.put("id", id)
        data.put("utteranceId", utterance)
        return data
    }

    private val progressListener = object : UtteranceProgressListener() {
        override fun onStart(id: String?) {}

        override fun onDone(id: String?) {
            Log.d(TAG, "utterance done: $id")
            if (id != null) {
                pendingSynthInvokes.remove(id)?.let { invoke ->
                    val result = JSObject()
                    result.put("done", true)
                    invoke.resolve(result)
                    return
                }
            }
            val utterance = currentUtteranceOf(id) ?: return
            // A long page is several queued pieces: it is done after the last one.
            if (id != lastPieceId) return
            trigger(SPEAK_DONE_EVENT, utteranceEvent(id!!, utterance))
        }

        override fun onError(id: String?) {
            Log.e(TAG, "utterance error: $id")
            if (id != null) {
                pendingSynthInvokes.remove(id)?.let { invoke ->
                    invoke.reject("TTS synthesis failed")
                    return
                }
            }
            val utterance = currentUtteranceOf(id) ?: return
            trigger(SPEAK_ERROR_EVENT, utteranceEvent(id!!, utterance))
        }

        @Deprecated("Deprecated in Java")
        override fun onError(id: String?, code: Int) {
            onError(id)
        }

        override fun onRangeStart(id: String?, start: Int, end: Int, frame: Int) {
            val utterance = currentUtteranceOf(id) ?: return
            val offset = pieceOffsets[id] ?: 0
            val data = utteranceEvent(id!!, utterance)
            data.put("start", start + offset)
            data.put("end", end + offset)
            trigger(SPEAK_RANGE_EVENT, data)
        }
    }

    /**
     * Use the book's language when the engine has a voice for it; otherwise
     * the device language, with a warning for the listener.
     */
    private fun applyLanguage(engine: TextToSpeech, lang: String?): String? {
        val fallback = Locale.getDefault()
        if (lang.isNullOrBlank()) {
            engine.setLanguage(fallback)
            return null
        }
        val wanted = Locale.forLanguageTag(lang)
        if (wanted.language.isNullOrEmpty()) {
            engine.setLanguage(fallback)
            return null
        }
        val available = try {
            engine.isLanguageAvailable(wanted)
        } catch (e: Exception) {
            TextToSpeech.LANG_NOT_SUPPORTED
        }
        if (available >= TextToSpeech.LANG_AVAILABLE) {
            val result = engine.setLanguage(wanted)
            if (result >= TextToSpeech.LANG_AVAILABLE) return null
        }
        engine.setLanguage(fallback)
        val name = wanted.getDisplayLanguage(fallback).ifEmpty { lang }
        val fallbackName = fallback.getDisplayLanguage(fallback).ifEmpty { fallback.toLanguageTag() }
        Log.w(TAG, "No voice for '$lang' (availability=$available); using $fallback")
        return "The speech engine has no $name voice, so this book is read with the $fallbackName voice. " +
            "Install $name in your device's text-to-speech settings."
    }

    private fun nextUtteranceId(): String = "theorem-tts-${utteranceCounter.incrementAndGet()}"

    private class SpeakOutcome(val ok: Boolean, val pieces: Int = 0, val languageWarning: String? = null)

    private fun doSpeak(args: SpeakArgs, callback: (SpeakOutcome) -> Unit) {
        val currentTts = tts
        if (currentTts == null || !isInitialized) {
            initTts { ok ->
                if (ok) {
                    doSpeak(args, callback)
                } else {
                    callback(SpeakOutcome(false))
                }
            }
            return
        }

        runOnUiThread {
            try {
                val text = args.text
                val utterance = args.utteranceId?.takeIf { it.isNotBlank() } ?: nextUtteranceId()
                // New utterance first: events of the one being flushed are now stale.
                currentUtterance = utterance
                pieceOffsets.clear()
                lastPieceId = null

                val speed = (args.speed ?: 1.0).toFloat()
                currentTts.setSpeechRate(if (speed.isFinite() && speed > 0f) speed.coerceIn(0.25f, 4f) else 1f)
                val warning = applyLanguage(currentTts, args.lang)
                if (args.voice.isNotEmpty()) {
                    // A chosen voice wins only when it speaks the book's language.
                    val wanted = args.lang?.takeIf { it.isNotBlank() }?.let { Locale.forLanguageTag(it).language }
                    currentTts.voices?.firstOrNull { it.name == args.voice }?.let { voice ->
                        if (wanted.isNullOrEmpty() || voice.locale?.language == wanted) currentTts.voice = voice
                    }
                }

                val pieces = SpeechTextSplitter.split(text, TextToSpeech.getMaxSpeechInputLength())
                var ok = pieces.isNotEmpty()
                pieces.forEachIndexed { index, range ->
                    val id = "$utterance#$index"
                    pieceOffsets[id] = range.first
                    if (index == pieces.lastIndex) lastPieceId = id
                    val mode = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
                    val result = currentTts.speak(text.substring(range.first, range.last + 1), mode, null, id)
                    if (result != TextToSpeech.SUCCESS) ok = false
                }
                callback(SpeakOutcome(ok, pieces.size, warning))
            } catch (e: Exception) {
                Log.e(TAG, "speak failed: ${e.message}", e)
                callback(SpeakOutcome(false))
            }
        }
    }

    @Command
    fun speak(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SpeakArgs::class.java)
            if (args.text.isBlank()) {
                invoke.resolve()
                return
            }
            doSpeak(args) { outcome ->
                if (outcome.ok) {
                    val result = JSObject()
                    result.put("pieces", outcome.pieces)
                    outcome.languageWarning?.let { result.put("languageWarning", it) }
                    invoke.resolve(result)
                } else {
                    invoke.reject("TTS speak failed")
                }
            }
        } catch (error: Exception) {
            Log.e(TAG, "speak: ${error.message}")
            invoke.reject(error.message ?: "Failed to speak")
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        try {
            // Whatever the engine still reports for the stopped utterance is stale.
            currentUtterance = null
            lastPieceId = null
            runOnUiThread {
                tts?.stop()
            }
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Failed to stop")
        }
    }

    @Command
    fun getVoices(invoke: Invoke) {
        try {
            val currentTts = tts
            if (currentTts == null || !isInitialized) {
                initTts { ok ->
                    if (ok) getVoices(invoke) else {
                        val result = JSObject()
                        result.put("voicesJson", "[]")
                        invoke.resolve(result)
                    }
                }
                return
            }

            runOnUiThread {
                try {
                    val jsonArray = JSONArray()
                    currentTts.voices?.let { voices ->
                        for (v in voices) {
                            val obj = JSONObject()
                            obj.put("name", v.name)
                            obj.put("locale", v.locale?.toLanguageTag() ?: "")
                            jsonArray.put(obj)
                        }
                    }
                    val result = JSObject()
                    result.put("voicesJson", jsonArray.toString())
                    invoke.resolve(result)
                } catch (e: Exception) {
                    val result = JSObject()
                    result.put("voicesJson", "[]")
                    invoke.resolve(result)
                }
            }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Failed to get voices")
        }
    }

    @Command
    fun getEngines(invoke: Invoke) {
        try {
            val currentTts = tts
            if (currentTts == null || !isInitialized) {
                initTts { ok ->
                    if (ok) getEngines(invoke) else {
                        val result = JSObject()
                        result.put("enginesJson", "[]")
                        result.put("currentEngine", "")
                        invoke.resolve(result)
                    }
                }
                return
            }

            runOnUiThread {
                try {
                    val jsonArray = JSONArray()
                    for (engine in currentTts.engines) {
                        val obj = JSONObject()
                        obj.put("name", engine.name)
                        obj.put("label", engine.label?.toString() ?: engine.name)
                        obj.put("isDefault", engine.name == currentTts.defaultEngine)
                        jsonArray.put(obj)
                    }
                    val result = JSObject()
                    result.put("enginesJson", jsonArray.toString())
                    result.put("currentEngine", selectedEngine ?: currentTts.defaultEngine ?: "")
                    invoke.resolve(result)
                } catch (e: Exception) {
                    Log.e(TAG, "getEngines failed: ${e.message}", e)
                    val result = JSObject()
                    result.put("enginesJson", "[]")
                    result.put("currentEngine", "")
                    invoke.resolve(result)
                }
            }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Failed to get engines")
        }
    }

    @Command
    fun setEngine(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SetEngineArgs::class.java)
            runOnUiThread {
                // Tear down the cached instance so the new engine takes effect
                // immediately (the old code bound the default engine once).
                tts?.stop()
                tts?.shutdown()
                tts = null
                isInitialized = false
            }
            initTts(args.engine.ifEmpty { null }) { ok ->
                if (ok) {
                    selectedEngine = args.engine.ifEmpty { null }
                    val result = JSObject()
                    result.put("engine", selectedEngine ?: tts?.defaultEngine ?: "")
                    invoke.resolve(result)
                } else {
                    invoke.reject("Failed to initialize TTS engine '${args.engine}'")
                }
            }
        } catch (error: Exception) {
            Log.e(TAG, "setEngine: ${error.message}")
            invoke.reject(error.message ?: "Failed to set engine")
        }
    }

    @Command
    fun synthesizeToFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SynthesizeToFileArgs::class.java)
            if (args.text.isBlank()) {
                invoke.reject("Empty text")
                return
            }

            val currentTts = tts
            if (currentTts == null || !isInitialized) {
                initTts { ok ->
                    if (ok) synthesizeToFile(invoke) else invoke.reject("TTS not available")
                }
                return
            }

            runOnUiThread {
                try {
                    val exportDir = File(activity.filesDir, "tts-exports")
                    if (!exportDir.exists()) exportDir.mkdirs()
                    val safeName = args.fileName.ifEmpty { "export-${System.currentTimeMillis()}" }
                    val outFile = File(exportDir, safeName)

                    val utteranceId = "synth-${utteranceCounter.incrementAndGet()}"
                    pendingSynthInvokes[utteranceId] = invoke

                    if (args.voice.isNotEmpty()) {
                        currentTts.voices?.let { voices ->
                            for (voice in voices) {
                                if (voice.name == args.voice) {
                                    currentTts.voice = voice
                                    break
                                }
                            }
                        }
                    }

                    val params = Bundle()
                    val result = currentTts.synthesizeToFile(args.text, params, outFile, utteranceId)
                    if (result != TextToSpeech.SUCCESS) {
                        pendingSynthInvokes.remove(utteranceId)
                        invoke.reject("synthesizeToFile rejected the request")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "synthesizeToFile failed: ${e.message}", e)
                    invoke.reject(e.message ?: "Failed to synthesize")
                }
            }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Failed to synthesize")
        }
    }

    override fun onDestroy() {
        runOnUiThread {
            tts?.stop()
            tts?.shutdown()
        }
        tts = null
        isInitialized = false
        pendingSynthInvokes.clear()
        super.onDestroy()
    }
}
