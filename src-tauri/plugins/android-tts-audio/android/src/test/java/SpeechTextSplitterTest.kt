package work.fundamentals.theorem.ttsaudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Run: ./gradlew :tauri-plugin-android-tts-audio:testDebugUnitTest */
class SpeechTextSplitterTest {
    private fun pieces(text: String, max: Int) = SpeechTextSplitter.split(text, max).map { text.substring(it) }

    @Test
    fun shortTextIsOnePiece() {
        assertEquals(listOf("Hello there."), pieces("  Hello there.  ", 4000))
        assertEquals(emptyList<String>(), pieces("   ", 10))
        assertEquals(emptyList<String>(), pieces("", 10))
    }

    @Test
    fun longTextBreaksAtSentencesWithinTheLimit() {
        val text = "One two three. Four five six! Seven eight nine? Ten eleven twelve."
        val result = pieces(text, 32)
        assertTrue(result.all { it.length <= 32 })
        assertEquals(listOf("One two three. Four five six!", "Seven eight nine?", "Ten eleven twelve."), result)
    }

    @Test
    fun keepsClosingQuotesWithTheSentence() {
        val result = pieces("He said \"Stop.\" Then he went home and slept.", 20)
        assertEquals("He said \"Stop.\"", result.first())
    }

    @Test
    fun fallsBackToSpacesThenToTheLimit() {
        val words = "alpha beta gamma delta epsilon zeta eta theta"
        val result = pieces(words, 12)
        assertTrue(result.all { it.length <= 12 })
        assertEquals(words.split(" "), result.joinToString(" ").split(" "))
        val run = "x".repeat(25)
        assertEquals(listOf("x".repeat(10), "x".repeat(10), "x".repeat(5)), pieces(run, 10))
    }

    @Test
    fun cjkBreaksAfterFullWidthStops() {
        val text = "这是第一句话。这是第二句话！这是第三句话？"
        assertEquals(listOf("这是第一句话。这是第二句话！", "这是第三句话？"), pieces(text, 14))
    }

    @Test
    fun neverSplitsASurrogatePair() {
        val text = "a".repeat(9) + "😀" + "b".repeat(5)
        val result = pieces(text, 10)
        assertEquals("a".repeat(9), result[0])
        assertEquals(text, result.joinToString(""))
    }

    @Test
    fun rangesIndexIntoTheOriginalText() {
        val text = "First sentence here.   Second one follows."
        val ranges = SpeechTextSplitter.split(text, 25)
        assertEquals(0, ranges[0].first)
        assertEquals(text.indexOf("Second"), ranges[1].first)
    }
}
