//! Speech Text Normalizer: Deterministic rule-based expansion of numbers,
//! dates, Roman numerals, currency, percentages, units, and abbreviations.
//!
//! Used across:
//! - Supertonic Neural TTS runtime (`supertonic.rs`)
//! - Platform desktop TTS (`tts_linux.rs`, macOS `say`, Windows `System.Speech`)
//! - Companion audiobook generation (`audiobook_gen.rs`)

/// Numbers 0 to 19 in English
const ONES: &[&str] = &[
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];

/// Multiples of ten from 20 to 90
const TENS: &[&str] = &[
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

/// Ordinal words for 1 to 19
const ORDINALS_UNDER_TWENTY: &[&str] = &[
    "zeroth",
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
    "eleventh",
    "twelfth",
    "thirteenth",
    "fourteenth",
    "fifteenth",
    "sixteenth",
    "seventeenth",
    "eighteenth",
    "nineteenth",
];

/// Ordinal tens prefixes
const ORDINAL_TENS: &[&str] = &[
    "",
    "",
    "twentieth",
    "thirtieth",
    "fortieth",
    "fiftieth",
    "sixtieth",
    "seventieth",
    "eightieth",
    "ninetieth",
];

/// Convert an integer from 0 to 999,999,999 to English words.
pub fn number_to_words(n: u64) -> String {
    if n < 20 {
        return ONES[n as usize].to_string();
    }
    if n < 100 {
        let ten = (n / 10) as usize;
        let rem = (n % 10) as usize;
        if rem == 0 {
            return TENS[ten].to_string();
        }
        return format!("{}-{}", TENS[ten], ONES[rem]);
    }
    if n < 1_000 {
        let hundred = (n / 100) as usize;
        let rem = n % 100;
        if rem == 0 {
            return format!("{} hundred", ONES[hundred]);
        }
        return format!("{} hundred {}", ONES[hundred], number_to_words(rem));
    }
    if n < 1_000_000 {
        let thousand = n / 1_000;
        let rem = n % 1_000;
        if rem == 0 {
            return format!("{} thousand", number_to_words(thousand));
        }
        return format!(
            "{} thousand {}",
            number_to_words(thousand),
            number_to_words(rem)
        );
    }
    if n < 1_000_000_000 {
        let million = n / 1_000_000;
        let rem = n % 1_000_000;
        if rem == 0 {
            return format!("{} million", number_to_words(million));
        }
        return format!(
            "{} million {}",
            number_to_words(million),
            number_to_words(rem)
        );
    }
    let billion = n / 1_000_000_000;
    let rem = n % 1_000_000_000;
    if rem == 0 {
        return format!("{} billion", number_to_words(billion));
    }
    format!(
        "{} billion {}",
        number_to_words(billion),
        number_to_words(rem)
    )
}

/// Convert a number to English ordinal words (e.g. 1 -> "first", 22 -> "twenty-second").
pub fn ordinal_to_words(n: u64) -> String {
    if n < 20 {
        return ORDINALS_UNDER_TWENTY[n as usize].to_string();
    }
    if n < 100 {
        let ten = (n / 10) as usize;
        let rem = (n % 10) as usize;
        if rem == 0 {
            return ORDINAL_TENS[ten].to_string();
        }
        return format!("{}-{}", TENS[ten], ORDINALS_UNDER_TWENTY[rem]);
    }
    if n < 1_000 {
        let hundred = (n / 100) as usize;
        let rem = n % 100;
        if rem == 0 {
            return format!("{} hundredth", ONES[hundred]);
        }
        return format!("{} hundred {}", ONES[hundred], ordinal_to_words(rem));
    }
    if n < 1_000_000 {
        let thousand = n / 1_000;
        let rem = n % 1_000;
        if rem == 0 {
            return format!("{} thousandth", number_to_words(thousand));
        }
        return format!(
            "{} thousand {}",
            number_to_words(thousand),
            ordinal_to_words(rem)
        );
    }
    let million = n / 1_000_000;
    let rem = n % 1_000_000;
    if rem == 0 {
        return format!("{} millionth", number_to_words(million));
    }
    format!(
        "{} million {}",
        number_to_words(million),
        ordinal_to_words(rem)
    )
}

/// Convert 4-digit calendar years to natural speech (e.g. 1984 -> "nineteen eighty-four").
pub fn year_to_words(year: u32) -> Option<String> {
    if !(1000..=2099).contains(&year) {
        return None;
    }
    if year.is_multiple_of(1000) {
        return Some(format!(
            "{} thousand",
            number_to_words((year / 1000) as u64)
        ));
    }
    if (2001..=2009).contains(&year) {
        let rem = year % 100;
        return Some(format!("two thousand {}", ONES[rem as usize]));
    }
    let century = year / 100;
    let rem = year % 100;
    let century_str = number_to_words(century as u64);
    if rem == 0 {
        Some(format!("{century_str} hundred"))
    } else if rem < 10 {
        Some(format!("{century_str} oh {}", ONES[rem as usize]))
    } else {
        Some(format!("{century_str} {}", number_to_words(rem as u64)))
    }
}

/// Parse Roman numeral (up to 50: I to L) to integer.
fn parse_roman_numeral(s: &str) -> Option<u32> {
    match s {
        "I" => Some(1),
        "II" => Some(2),
        "III" => Some(3),
        "IV" => Some(4),
        "V" => Some(5),
        "VI" => Some(6),
        "VII" => Some(7),
        "VIII" => Some(8),
        "IX" => Some(9),
        "X" => Some(10),
        "XI" => Some(11),
        "XII" => Some(12),
        "XIII" => Some(13),
        "XIV" => Some(14),
        "XV" => Some(15),
        "XVI" => Some(16),
        "XVII" => Some(17),
        "XVIII" => Some(18),
        "XIX" => Some(19),
        "XX" => Some(20),
        "XXI" => Some(21),
        "XXII" => Some(22),
        "XXIII" => Some(23),
        "XXIV" => Some(24),
        "XXV" => Some(25),
        "XXVI" => Some(26),
        "XXVII" => Some(27),
        "XXVIII" => Some(28),
        "XXIX" => Some(29),
        "XXX" => Some(30),
        "XL" => Some(40),
        "L" => Some(50),
        _ => None,
    }
}

/// Normalize titles, abbreviations, symbols, currency, and numbers for TTS.
pub fn normalize_speech_text(text: &str, lang: &str) -> String {
    // Only English has deep phonetic rules for now; other languages get symbol/spacing passes
    let is_english = lang.is_empty() || lang.starts_with("en");

    let mut out = String::with_capacity(text.len() + 64);
    let words: Vec<&str> = text.split_whitespace().collect();
    let total_words = words.len();

    let mut i = 0;
    while i < total_words {
        let raw_word = words[i];

        // Strip surrounding punctuation while retaining leading/trailing punct
        let (leading_punct, core, trailing_punct) = split_punct(raw_word);

        if !leading_punct.is_empty() {
            out.push_str(leading_punct);
        }

        if is_english && !core.is_empty() {
            let normalized = normalize_single_token(core, words.get(i.wrapping_sub(1)).copied());
            out.push_str(&normalized);
        } else {
            out.push_str(core);
        }

        if !trailing_punct.is_empty() {
            out.push_str(trailing_punct);
        }

        if i + 1 < total_words {
            out.push(' ');
        }
        i += 1;
    }

    // Secondary pass: clean common ligature/currency/symbol abbreviations in full text
    post_process_symbols(&out, is_english)
}

fn split_punct(word: &str) -> (&str, &str, &str) {
    let start = word
        .find(|c: char| c.is_alphanumeric() || c == '$' || c == '€' || c == '£' || c == '¥')
        .unwrap_or(0);

    let candidate = &word[start..];
    for abbrev in &[
        "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Rev.", "Gen.", "Col.", "Maj.", "Capt.", "Lt.",
        "Sgt.", "St.", "Jr.", "Sr.", "etc.", "vs.", "approx.", "dept.", "govt.", "vol.", "no.",
        "p.", "pp.", "ch.", "sec.",
    ] {
        if let Some(rest) = candidate.strip_prefix(abbrev) {
            if rest.is_empty() || rest.chars().all(|c| !c.is_alphanumeric()) {
                let core_len = start + abbrev.len();
                return (&word[..start], &word[start..core_len], &word[core_len..]);
            }
        }
    }

    let end = word
        .rfind(|c: char| c.is_alphanumeric() || c == '%' || c == '°')
        .map(|idx| idx + word[idx..].chars().next().map_or(1, |c| c.len_utf8()))
        .unwrap_or(word.len());

    if start >= end {
        (word, "", "")
    } else {
        (&word[..start], &word[start..end], &word[end..])
    }
}

fn normalize_single_token(token: &str, prev_token: Option<&str>) -> String {
    // 1. Currency: $10, €25.50, £100
    if let Some(rest) = token.strip_prefix('$') {
        return normalize_currency_amount(rest, "dollar", "dollars");
    }
    if let Some(rest) = token.strip_prefix('€') {
        return normalize_currency_amount(rest, "euro", "euros");
    }
    if let Some(rest) = token.strip_prefix('£') {
        return normalize_currency_amount(rest, "pound", "pounds");
    }
    if let Some(rest) = token.strip_prefix('¥') {
        return normalize_currency_amount(rest, "yen", "yen");
    }

    // 2. Percentages: 50%, 3.5%
    if let Some(rest) = token.strip_suffix('%') {
        if let Ok(val) = rest.parse::<f64>() {
            return format!("{} percent", normalize_number_str(rest, val));
        }
    }

    // 3. Temperature: 20°C, 75°F
    if let Some(rest) = token.strip_suffix("°C") {
        return format!("{} degrees Celsius", rest);
    }
    if let Some(rest) = token.strip_suffix("°F") {
        return format!("{} degrees Fahrenheit", rest);
    }
    if let Some(rest) = token.strip_suffix('°') {
        return format!("{} degrees", rest);
    }

    // 4. Ordinals: 1st, 2nd, 3rd, 4th, 21st, 100th
    if let Some(num_str) = strip_ordinal_suffix(token) {
        if let Ok(n) = num_str.parse::<u64>() {
            return ordinal_to_words(n);
        }
    }

    // 5. Roman Numerals following contextual keywords (e.g. Chapter IV, Henry VIII, Act II)
    if let Some(val) = parse_roman_numeral(token) {
        if let Some(prev) = prev_token {
            let p_clean = prev
                .trim_matches(|c: char| !c.is_alphabetic())
                .to_lowercase();
            match p_clean.as_str() {
                "chapter" | "part" | "act" | "scene" | "book" | "section" | "volume" | "grade" => {
                    return number_to_words(val as u64);
                }
                "king" | "queen" | "pope" | "emperor" | "henry" | "edward" | "george" | "louis"
                | "charles" | "william" | "richard" | "alexander" | "napoleon" | "cleopatra" => {
                    return format!("the {}", ordinal_to_words(val as u64));
                }
                "war" => {
                    return number_to_words(val as u64);
                }
                _ => {}
            }
        }
    }

    // 6. Titles & Abbreviations
    match token {
        "Dr." | "Dr" => return "Doctor".to_string(),
        "Mr." | "Mr" => return "Mister".to_string(),
        "Mrs." | "Mrs" => return "Missus".to_string(),
        "Ms." | "Ms" => return "Miz".to_string(),
        "Prof." | "Prof" => return "Professor".to_string(),
        "Rev." | "Rev" => return "Reverend".to_string(),
        "Gen." => return "General".to_string(),
        "Col." => return "Colonel".to_string(),
        "Maj." => return "Major".to_string(),
        "Capt." => return "Captain".to_string(),
        "Lt." => return "Lieutenant".to_string(),
        "Sgt." => return "Sergeant".to_string(),
        "St." => return "Saint".to_string(),
        "Jr." => return "Junior".to_string(),
        "Sr." => return "Senior".to_string(),
        "etc." => return "et cetera".to_string(),
        "vs." | "vs" => return "versus".to_string(),
        "approx." => return "approximately".to_string(),
        "dept." => return "department".to_string(),
        "govt." => return "government".to_string(),
        "vol." => return "volume".to_string(),
        "no." => return "number".to_string(),
        "p." => return "page".to_string(),
        "pp." => return "pages".to_string(),
        "ch." => return "chapter".to_string(),
        "sec." => return "section".to_string(),
        _ => {}
    }

    // 7. Fractions: 1/2, 1/4, 3/4, 1/3, 2/3
    match token {
        "1/2" => return "one half".to_string(),
        "1/4" => return "one quarter".to_string(),
        "3/4" => return "three quarters".to_string(),
        "1/3" => return "one third".to_string(),
        "2/3" => return "two thirds".to_string(),
        _ => {}
    }

    // 8. Plain Numbers: integers and 4-digit years
    let digits_only = token.replace(',', "");
    if let Ok(n) = digits_only.parse::<u64>() {
        // Check if 4-digit year (1000..=2099)
        if digits_only.len() == 4 && (1000..=2099).contains(&n) {
            if let Some(yr) = year_to_words(n as u32) {
                return yr;
            }
        }
        return number_to_words(n);
    }

    // 9. Decimal numbers: 3.14 -> "three point one four"
    if token.contains('.') && !token.ends_with('.') && !token.starts_with('.') {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() == 2 {
            if let (Ok(whole), true) = (
                parts[0].replace(',', "").parse::<u64>(),
                parts[1].chars().all(|c| c.is_ascii_digit()),
            ) {
                let whole_str = number_to_words(whole);
                let decimals: Vec<String> = parts[1]
                    .chars()
                    .map(|c| ONES[(c as u8 - b'0') as usize].to_string())
                    .collect();
                return format!("{whole_str} point {}", decimals.join(" "));
            }
        }
    }

    token.to_string()
}

fn strip_ordinal_suffix(s: &str) -> Option<&str> {
    if let Some(num) = s.strip_suffix("st") {
        if num.chars().all(|c| c.is_ascii_digit()) {
            return Some(num);
        }
    }
    if let Some(num) = s.strip_suffix("nd") {
        if num.chars().all(|c| c.is_ascii_digit()) {
            return Some(num);
        }
    }
    if let Some(num) = s.strip_suffix("rd") {
        if num.chars().all(|c| c.is_ascii_digit()) {
            return Some(num);
        }
    }
    if let Some(num) = s.strip_suffix("th") {
        if num.chars().all(|c| c.is_ascii_digit()) {
            return Some(num);
        }
    }
    None
}

fn normalize_number_str(_raw: &str, val: f64) -> String {
    if val.fract() == 0.0 && (0.0..=1_000_000_000.0).contains(&val) {
        number_to_words(val as u64)
    } else {
        val.to_string()
    }
}

fn normalize_currency_amount(amount_str: &str, singular: &str, plural: &str) -> String {
    let clean = amount_str.replace(',', "");
    if let Ok(whole) = clean.parse::<u64>() {
        let unit = if whole == 1 { singular } else { plural };
        return format!("{} {}", number_to_words(whole), unit);
    }
    if clean.contains('.') {
        let parts: Vec<&str> = clean.split('.').collect();
        if parts.len() == 2 {
            if let (Ok(whole), Ok(cents)) = (parts[0].parse::<u64>(), parts[1].parse::<u64>()) {
                let unit = if whole == 1 { singular } else { plural };
                let cents_str = if cents == 1 { "cent" } else { "cents" };
                return format!(
                    "{} {} and {} {}",
                    number_to_words(whole),
                    unit,
                    number_to_words(cents),
                    cents_str
                );
            }
        }
    }
    format!("{amount_str} {plural}")
}

fn post_process_symbols(text: &str, is_english: bool) -> String {
    let mut out = text.to_string();
    if is_english {
        out = out.replace(" & ", " and ");
        out = out.replace(" + ", " plus ");
        out = out.replace(" = ", " equals ");
        out = out.replace("e.g.,", "for example,");
        out = out.replace("i.e.,", "that is,");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_number_to_words() {
        assert_eq!(number_to_words(0), "zero");
        assert_eq!(number_to_words(1), "one");
        assert_eq!(number_to_words(13), "thirteen");
        assert_eq!(number_to_words(42), "forty-two");
        assert_eq!(number_to_words(100), "one hundred");
        assert_eq!(number_to_words(105), "one hundred five");
        assert_eq!(number_to_words(1250), "one thousand two hundred fifty");
        assert_eq!(number_to_words(1_000_000), "one million");
    }

    #[test]
    fn test_ordinal_to_words() {
        assert_eq!(ordinal_to_words(1), "first");
        assert_eq!(ordinal_to_words(2), "second");
        assert_eq!(ordinal_to_words(3), "third");
        assert_eq!(ordinal_to_words(21), "twenty-first");
        assert_eq!(ordinal_to_words(100), "one hundredth");
    }

    #[test]
    fn test_year_to_words() {
        assert_eq!(
            year_to_words(1984),
            Some("nineteen eighty-four".to_string())
        );
        assert_eq!(year_to_words(2024), Some("twenty twenty-four".to_string()));
        assert_eq!(year_to_words(2000), Some("two thousand".to_string()));
        assert_eq!(year_to_words(1805), Some("eighteen oh five".to_string()));
    }

    #[test]
    fn test_normalize_speech_text() {
        assert_eq!(
            normalize_speech_text("Chapter IV of Dr. Watson's book.", "en"),
            "Chapter four of Doctor Watson's book."
        );
        assert_eq!(
            normalize_speech_text("The price is $50 or $5.50.", "en"),
            "The price is fifty dollars or five dollars and fifty cents."
        );
        assert_eq!(
            normalize_speech_text("King Henry VIII ruled in 1509.", "en"),
            "King Henry the eighth ruled in fifteen oh nine."
        );
        assert_eq!(
            normalize_speech_text("It grew by 25% on the 1st day.", "en"),
            "It grew by twenty-five percent on the first day."
        );
    }
}
