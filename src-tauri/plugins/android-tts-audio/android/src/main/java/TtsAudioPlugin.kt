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
                        currentTts?.language = Locale.getDefault()
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

    private val progressListener = object : UtteranceProgressListener() {
        override fun onStart(id: String?) {}

        override fun onDone(id: String?) {
            Log.d(TAG, "utterance done: $id")
            val data = JSObject()
            data.put("id", id ?: "")
            trigger(SPEAK_DONE_EVENT, data)
            if (id != null) {
                pendingSynthInvokes.remove(id)?.let { invoke ->
                    val result = JSObject()
                    result.put("done", true)
                    invoke.resolve(result)
                }
            }
        }

        override fun onError(id: String?) {
            Log.e(TAG, "utterance error: $id")
            val data = JSObject()
            data.put("id", id ?: "")
            trigger(SPEAK_ERROR_EVENT, data)
            if (id != null) {
                pendingSynthInvokes.remove(id)?.let { invoke ->
                    invoke.reject("TTS synthesis failed")
                }
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onError(id: String?, code: Int) {
            onError(id)
        }

        override fun onRangeStart(id: String?, start: Int, end: Int, frame: Int) {
            val data = JSObject()
            data.put("id", id ?: "")
            data.put("start", start)
            data.put("end", end)
            trigger(SPEAK_RANGE_EVENT, data)
        }
    }

    private fun nextUtteranceId(): String = "theorem-tts-${utteranceCounter.incrementAndGet()}"

    private fun doSpeak(text: String, voiceName: String, callback: (Boolean) -> Unit) {
        val currentTts = tts
        if (currentTts == null || !isInitialized) {
            initTts { ok ->
                if (ok) {
                    doSpeak(text, voiceName, callback)
                } else {
                    callback(false)
                }
            }
            return
        }

        runOnUiThread {
            try {
                if (voiceName.isNotEmpty()) {
                    for (voice in currentTts.voices) {
                        if (voice.name == voiceName) {
                            currentTts.voice = voice
                            break
                        }
                    }
                }
                val result = currentTts.speak(text, TextToSpeech.QUEUE_FLUSH, null, nextUtteranceId())
                callback(result == TextToSpeech.SUCCESS)
            } catch (e: Exception) {
                Log.e(TAG, "speak failed: ${e.message}", e)
                callback(false)
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
            doSpeak(args.text, args.voice) { ok ->
                if (ok) invoke.resolve() else invoke.reject("TTS speak failed")
            }
        } catch (error: Exception) {
            Log.e(TAG, "speak: ${error.message}")
            invoke.reject(error.message ?: "Failed to speak")
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        try {
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
                    for (v in currentTts.voices) {
                        val obj = JSONObject()
                        obj.put("name", v.name)
                        obj.put("locale", v.locale?.toLanguageTag() ?: "")
                        jsonArray.put(obj)
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
                        for (voice in currentTts.voices) {
                            if (voice.name == args.voice) {
                                currentTts.voice = voice
                                break
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
