package work.fundamentals.theorem.ttsaudio

/**
 * Splits page text longer than the engine's input limit
 * (`TextToSpeech.getMaxSpeechInputLength()`) into pieces that are queued one
 * after another. Pieces end at a sentence boundary when one falls in the back
 * three quarters of the window, else at a space, else at the limit (never
 * inside a surrogate pair). Returned ranges index into `text`, so word ranges
 * reported per piece can be shifted back onto the whole page.
 */
internal object SpeechTextSplitter {
    private val SENTENCE_END = charArrayOf('.', '!', '?', '…', '。', '！', '？')
    private val CJK_END = charArrayOf('。', '！', '？')
    private val CLOSERS = charArrayOf('"', '\'', '”', '’', ')', ']', '»', '」', '』', '）')

    fun split(text: String, maxLength: Int): List<IntRange> {
        val limit = maxLength.coerceAtLeast(1)
        val pieces = ArrayList<IntRange>()
        var start = skipSpaces(text, 0)
        while (start < text.length) {
            if (text.length - start <= limit) {
                pieces.add(start until trimEnd(text, start, text.length))
                break
            }
            val windowEnd = start + limit
            var end = sentenceBreak(text, start, windowEnd)
            if (end <= start) end = spaceBreak(text, start, windowEnd)
            if (end <= start) {
                end = windowEnd
                if (Character.isHighSurrogate(text[end - 1]) && end - 1 > start) end -= 1
            }
            val trimmed = trimEnd(text, start, end)
            if (trimmed > start) pieces.add(start until trimmed)
            start = skipSpaces(text, end)
        }
        return pieces
    }

    /** End (exclusive) of the last sentence finishing inside the window. */
    private fun sentenceBreak(text: String, start: Int, windowEnd: Int): Int {
        val earliest = start + (windowEnd - start) / 4
        var i = windowEnd - 1
        while (i > earliest) {
            val c = text[i]
            if (c in SENTENCE_END) {
                var end = i + 1
                while (end < windowEnd && text[end] in CLOSERS) end++
                val atBoundary = c in CJK_END || end >= text.length || text[end].isWhitespace()
                if (atBoundary && end <= windowEnd) return end
            }
            i--
        }
        return -1
    }

    private fun spaceBreak(text: String, start: Int, windowEnd: Int): Int {
        var i = windowEnd
        while (i > start) {
            if (text[i - 1].isWhitespace() || (i < text.length && text[i].isWhitespace())) return i
            i--
        }
        return -1
    }

    private fun skipSpaces(text: String, from: Int): Int {
        var i = from
        while (i < text.length && text[i].isWhitespace()) i++
        return i
    }

    private fun trimEnd(text: String, start: Int, end: Int): Int {
        var e = end
        while (e > start && text[e - 1].isWhitespace()) e--
        return e
    }
}
