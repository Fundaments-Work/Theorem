/**
 * Audiobook-Grade Text Normalization for Text-to-Speech
 *
 * Expands numbers, dates, ordinals, currencies, roman numerals,
 * and common abbreviations into natural spoken English for an immersive
 * audiobook listening experience.
 */

const ONES = [
    '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen',
];

const TENS = [
    '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
];

const SCALE = ['', 'thousand', 'million', 'billion', 'trillion'];

/** Converts an integer (0 to 999,999,999,999) to spoken English words. */
export function integerToWords(n: number): string {
    if (n === 0) return 'zero';
    if (n < 0) return 'minus ' + integerToWords(-n);
    if (!Number.isFinite(n)) return String(n);

    function convertGroup(num: number): string {
        let res = '';
        if (num >= 100) {
            res += ONES[Math.floor(num / 100)] + ' hundred';
            num %= 100;
            if (num > 0) res += ' ';
        }
        if (num > 0) {
            if (num < 20) {
                res += ONES[num];
            } else {
                res += TENS[Math.floor(num / 10)];
                if (num % 10 > 0) {
                    res += '-' + ONES[num % 10];
                }
            }
        }
        return res;
    }

    let result = '';
    let scaleIdx = 0;
    let temp = Math.floor(n);

    while (temp > 0) {
        const group = temp % 1000;
        if (group > 0) {
            const groupText = convertGroup(group);
            const scaleName = SCALE[scaleIdx];
            const part = scaleName ? `${groupText} ${scaleName}` : groupText;
            result = result ? `${part} ${result}` : part;
        }
        temp = Math.floor(temp / 1000);
        scaleIdx++;
    }

    return result || 'zero';
}

const ORDINAL_ONES: Record<string, string> = {
    'one': 'first',
    'two': 'second',
    'three': 'third',
    'four': 'fourth',
    'five': 'fifth',
    'six': 'sixth',
    'seven': 'seventh',
    'eight': 'eighth',
    'nine': 'ninth',
    'ten': 'tenth',
    'eleven': 'eleventh',
    'twelve': 'twelfth',
    'thirteen': 'thirteenth',
    'fourteen': 'fourteenth',
    'fifteen': 'fifteenth',
    'sixteen': 'sixteenth',
    'seventeen': 'seventeenth',
    'eighteen': 'eighteenth',
    'nineteen': 'nineteenth',
    'twenty': 'twentieth',
    'thirty': 'thirtieth',
    'forty': 'fortieth',
    'fifty': 'fiftieth',
    'sixty': 'sixtieth',
    'seventy': 'seventieth',
    'eighty': 'eightieth',
    'ninety': 'ninetieth',
    'hundred': 'hundredth',
    'thousand': 'thousandth',
    'million': 'millionth',
    'billion': 'billionth',
};

/** Converts a positive integer to its ordinal word (e.g. 1 -> "first", 21 -> "twenty-first"). */
export function ordinalToWords(n: number): string {
    const cardinal = integerToWords(n);
    const lastWordMatch = cardinal.match(/([a-z]+)$/i);
    if (!lastWordMatch) return cardinal;
    const lastWord = lastWordMatch[1];
    const ordinalWord = ORDINAL_ONES[lastWord] || (lastWord.endsWith('y') ? lastWord.slice(0, -1) + 'ieth' : lastWord + 'th');
    return cardinal.slice(0, -lastWord.length) + ordinalWord;
}

/** Converts a 4-digit year to conversational English (e.g. 1984 -> "nineteen eighty-four"). */
export function yearToWords(year: number): string {
    if (year >= 1000 && year <= 2099) {
        if (year === 2000) return 'two thousand';
        if (year > 2000 && year < 2010) return 'two thousand ' + integerToWords(year - 2000);
        const century = Math.floor(year / 100);
        const remainder = year % 100;
        if (remainder === 0) return integerToWords(century) + ' hundred';
        const remText = remainder < 10 ? 'oh ' + ONES[remainder] : integerToWords(remainder);
        return integerToWords(century) + ' ' + remText;
    }
    return integerToWords(year);
}

const ROMAN_MAP: Record<string, number> = {
    I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000,
};

/** Parses a Roman numeral string (e.g. "IV", "XIV") to a number. */
export function romanToNumber(roman: string): number | null {
    const clean = roman.toUpperCase();
    if (!/^[IVXLCDM]+$/.test(clean)) return null;
    let sum = 0;
    for (let i = 0; i < clean.length; i++) {
        const curr = ROMAN_MAP[clean[i]];
        const next = ROMAN_MAP[clean[i + 1]] || 0;
        if (curr < next) {
            sum -= curr;
        } else {
            sum += curr;
        }
    }
    return sum > 0 && sum < 4000 ? sum : null;
}

/**
 * Normalizes text for speech synthesis, converting numbers, symbols,
 * currencies, dates, and abbreviations into pronounceable English prose.
 */
export function normalizeTextForAudio(text: string): string {
    if (!text || !text.trim()) return '';

    let out = text;

    // 1. Common abbreviations & honorifics (preserve sentence flow)
    out = out.replace(/\bMr\.\s+/g, 'Mister ');
    out = out.replace(/\bMrs\.\s+/g, 'Missus ');
    out = out.replace(/\bMs\.\s+/g, 'Miz ');
    out = out.replace(/\bDr\.\s+/g, 'Doctor ');
    out = out.replace(/\bProf\.\s+/g, 'Professor ');
    out = out.replace(/\bSt\.\s+/g, 'Saint ');
    out = out.replace(/\be\.g\.,?\s*/gi, 'for example, ');
    out = out.replace(/\bi\.e\.,?\s*/gi, 'that is, ');
    out = out.replace(/\betc\.,?\s*/gi, 'et cetera, ');
    out = out.replace(/\bvs\.\s*/gi, 'versus ');
    out = out.replace(/\bapprox\.\s*/gi, 'approximately ');
    out = out.replace(/\bNo\.\s*(\d+)/gi, 'number $1');
    out = out.replace(/\bp\.\s*(\d+)/g, 'page $1');
    out = out.replace(/\bpp\.\s*(\d+)/g, 'pages $1');

    // 2. Headings & Titles with Roman numerals
    out = out.replace(
        /\b(Chapter|Part|Section|Book|Act|Scene|Volume|Vol\.)\s+([IVXLCDM]+)\b/gi,
        (_match, heading, roman) => {
            const num = romanToNumber(roman);
            return num ? `${heading} ${integerToWords(num)}` : _match;
        }
    );

    // Monarchs and Popes with Roman numerals (e.g. "Henry VIII" -> "Henry the eighth")
    out = out.replace(
        /\b(King|Queen|Pope|Emperor|Henry|George|Edward|Louis|Charles|James|William|Richard|Alexander|Napoleon)\s+([IVXLCDM]+)\b/gi,
        (_match, name, roman) => {
            const num = romanToNumber(roman);
            return num ? `${name} the ${ordinalToWords(num)}` : _match;
        }
    );

    // World Wars
    out = out.replace(/\b(?:World War|WW)\s+I\b/g, 'World War one');
    out = out.replace(/\b(?:World War|WW)\s+II\b/g, 'World War two');

    // 3. Time (e.g. 4:15 pm, 3:00)
    out = out.replace(/\b(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)\b/g, (_m, h, m, period) => {
        const hour = integerToWords(parseInt(h, 10));
        const minVal = parseInt(m, 10);
        const minStr = minVal === 0 ? "o'clock" : (minVal < 10 ? `oh ${integerToWords(minVal)}` : integerToWords(minVal));
        const pStr = period.toLowerCase().split('').join(' ');
        return `${hour} ${minStr} ${pStr}`;
    });

    // 4. Currencies
    out = out.replace(/\$([0-9]+(?:\.[0-9]{2})?)\b/g, (_m, val) => {
        const num = parseFloat(val);
        if (val.includes('.')) {
            const [dollars, cents] = val.split('.');
            const dVal = parseInt(dollars, 10);
            const cVal = parseInt(cents, 10);
            const dStr = `${integerToWords(dVal)} ${dVal === 1 ? 'dollar' : 'dollars'}`;
            if (cVal === 0) return dStr;
            return `${dStr} and ${integerToWords(cVal)} ${cVal === 1 ? 'cent' : 'cents'}`;
        }
        return `${integerToWords(num)} ${num === 1 ? 'dollar' : 'dollars'}`;
    });
    out = out.replace(/€([0-9]+(?:\.[0-9]{2})?)\b/g, (_m, val) => {
        const num = parseInt(val, 10);
        return `${integerToWords(num)} euros`;
    });
    out = out.replace(/£([0-9]+(?:\.[0-9]{2})?)\b/g, (_m, val) => {
        const num = parseInt(val, 10);
        return `${integerToWords(num)} pounds`;
    });

    // 5. Percentages
    out = out.replace(/([0-9]+(?:\.[0-9]+)?)\s*%/g, (_m, val) => {
        return `${normalizeNumberString(val)} percent`;
    });

    // 6. Ordinals (1st, 2nd, 3rd, 21st, etc.)
    out = out.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (_m, digits) => {
        const n = parseInt(digits, 10);
        return ordinalToWords(n);
    });

    // 7. Common fractions
    out = out.replace(/\b1\/2\b/g, 'one half');
    out = out.replace(/\b1\/3\b/g, 'one third');
    out = out.replace(/\b2\/3\b/g, 'two thirds');
    out = out.replace(/\b1\/4\b/g, 'one quarter');
    out = out.replace(/\b3\/4\b/g, 'three quarters');

    // 8. Decades (e.g. 1990s -> "nineteen nineties")
    out = out.replace(/\b([12]\d{3})s\b/g, (_m, yStr) => {
        const y = parseInt(yStr, 10);
        const century = Math.floor(y / 100);
        const decade = y % 100;
        const decadeWord = TENS[Math.floor(decade / 10)] + 'ies';
        return `${integerToWords(century)} ${decadeWord}`;
    });

    // 9. Four-digit years in context (e.g. "in 1984", "since 2005")
    out = out.replace(/\b(?:in|since|by|from|until|circa|c\.)\s+([12]\d{3})\b/gi, (match, yStr) => {
        const y = parseInt(yStr, 10);
        const prefix = match.slice(0, match.length - yStr.length);
        return `${prefix}${yearToWords(y)}`;
    });

    // 10. General numbers with commas or standalone digits
    out = out.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => {
        const clean = m.replace(/,/g, '');
        return integerToWords(parseInt(clean, 10));
    });

    // Decimals
    out = out.replace(/\b(\d+)\.(\d+)\b/g, (_m, whole, dec) => {
        const wholeWords = integerToWords(parseInt(whole, 10));
        const decWords = dec.split('').map((d: string) => ONES[parseInt(d, 10)] || 'zero').join(' ');
        return `${wholeWords} point ${decWords}`;
    });

    // Standalone integers (1 to 6 digits)
    out = out.replace(/\b\d+\b/g, (m) => {
        const n = parseInt(m, 10);
        if (Number.isFinite(n) && m.length <= 12) {
            return integerToWords(n);
        }
        return m;
    });

    // 11. Em-dash and symbols: ensure em-dash has whitespace around it for natural speech pauses
    out = out.replace(/—/g, ' — ');
    out = out.replace(/--/g, ' — ');
    out = out.replace(/\s*&\s*/g, ' and ');

    // Normalize whitespace
    return out.replace(/\s+/g, ' ').trim();
}

function normalizeNumberString(str: string): string {
    if (str.includes('.')) {
        const [whole, dec] = str.split('.');
        const wholeWords = integerToWords(parseInt(whole, 10));
        const decWords = dec.split('').map((d: string) => ONES[parseInt(d, 10)] || 'zero').join(' ');
        return `${wholeWords} point ${decWords}`;
    }
    return integerToWords(parseInt(str, 10));
}
