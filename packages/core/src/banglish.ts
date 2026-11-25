const BENGALI_CHAR_REGEX = /[\u0980-\u09FF]/;

const INDEPENDENT_VOWELS: Readonly<Record<string, string>> = {
  "\u0985": "o",   // অ
  "\u0986": "a",   // আ
  "\u0987": "i",   // ই
  "\u0988": "i",   // ঈ
  "\u0989": "u",   // উ
  "\u098A": "u",   // ঊ
  "\u098B": "ri",  // ঋ
  "\u098F": "e",   // এ
  "\u0990": "oi",  // ঐ
  "\u0993": "o",   // ও
  "\u0994": "ou",  // ঔ
};

const CONSONANTS: Readonly<Record<string, string>> = {
  "\u0995": "k",   // ক
  "\u0996": "kh",  // খ
  "\u0997": "g",   // গ
  "\u0998": "gh",  // ঘ
  "\u0999": "ng",  // ঙ
  "\u099A": "ch",  // চ
  "\u099B": "chh", // ছ
  "\u099C": "j",   // জ
  "\u099D": "jh",  // ঝ
  "\u099E": "n",   // ঞ
  "\u099F": "t",   // ট
  "\u09A0": "th",  // ঠ
  "\u09A1": "d",   // ড
  "\u09A2": "dh",  // ঢ
  "\u09A3": "n",   // ণ
  "\u09A4": "t",   // ত
  "\u09A5": "th",  // থ
  "\u09A6": "d",   // দ
  "\u09A7": "dh",  // ধ
  "\u09A8": "n",   // ন
  "\u09AA": "p",   // প
  "\u09AB": "f",   // ফ
  "\u09AC": "b",   // ব
  "\u09AD": "bh",  // ভ
  "\u09AE": "m",   // ম
  "\u09AF": "j",   // য
  "\u09B0": "r",   // র
  "\u09B2": "l",   // ল
  "\u09B6": "sh",  // শ
  "\u09B7": "sh",  // ষ
  "\u09B8": "s",   // স
  "\u09B9": "h",   // হ
  "\u09DC": "r",   // ড়
  "\u09DD": "rh",  // ঢ়
  "\u09DF": "y",   // য়
  "\u09CE": "t",   // ৎ
};

const VOWEL_SIGNS: Readonly<Record<string, string>> = {
  "\u09BE": "a",   // া
  "\u09BF": "i",   // ি
  "\u09C0": "i",   // ী
  "\u09C1": "u",   // ু
  "\u09C2": "u",   // ূ
  "\u09C3": "ri",  // ৃ
  "\u09C7": "e",   // ে
  "\u09C8": "oi",  // ৈ
  "\u09CB": "o",   // ো
  "\u09CC": "ou",  // ৌ
};

const MODIFIERS: Readonly<Record<string, string>> = {
  "\u0982": "ng",  // ং
  "\u0983": "h",   // ঃ
  "\u0981": "n",   // ঁ
};

const DIGITS_AND_PUNCT: Readonly<Record<string, string>> = {
  "\u09E6": "0",
  "\u09E7": "1",
  "\u09E8": "2",
  "\u09E9": "3",
  "\u09EA": "4",
  "\u09EB": "5",
  "\u09EC": "6",
  "\u09ED": "7",
  "\u09EE": "8",
  "\u09EF": "9",
  "\u0964": ".", // ।
  "\u0965": ".", // ॥
};

const HASANTA = "\u09CD"; // ্
const NUKTA = "\u09BC";   // ়

function isConsonant(ch: string | undefined): boolean {
  return Boolean(ch && ch in CONSONANTS);
}

function isVowelOrSign(ch: string | undefined): boolean {
  return Boolean(ch && (ch in INDEPENDENT_VOWELS || ch in VOWEL_SIGNS));
}

function normalizePrecomposed(word: string): string {
  // Normalize decomposed nukta forms (ড+় -> ড়, ঢ+় -> ঢ়, য+় -> য়)
  return word
    .replace(/\u09A1\u09BC/g, "\u09DC")
    .replace(/\u09A2\u09BC/g, "\u09DD")
    .replace(/\u09AF\u09BC/g, "\u09DF");
}

function transliterateBengaliWord(rawWord: string): string {
  const word = normalizePrecomposed(rawWord);
  const chars = Array.from(word);
  let out = "";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const next = chars[i + 1];
    const next2 = chars[i + 2];

    if (ch in DIGITS_AND_PUNCT) {
      out += DIGITS_AND_PUNCT[ch];
      continue;
    }

    if (ch in INDEPENDENT_VOWELS) {
      out += INDEPENDENT_VOWELS[ch];
      continue;
    }

    if (ch in VOWEL_SIGNS) {
      out += VOWEL_SIGNS[ch];
      continue;
    }

    if (ch in MODIFIERS) {
      out += MODIFIERS[ch];
      continue;
    }

    if (ch === HASANTA || ch === NUKTA) {
      continue;
    }

    if (ch in CONSONANTS) {
      // Handle common special conjuncts
      if (ch === "\u0995" && next === HASANTA && next2 === "\u09B7") {
        // ক্ষ -> kh at start, kkh inside
        out += i === 0 ? "kh" : "kkh";
        i += 2;
        const after = chars[i + 1];
        if (after && after in VOWEL_SIGNS) {
          out += VOWEL_SIGNS[after];
          i += 1;
        } else if (after && after !== HASANTA && !isVowelOrSign(after) && i < chars.length - 1) {
          out += "o";
        }
        continue;
      }

      if (ch === "\u099C" && next === HASANTA && next2 === "\u099E") {
        // জ্ঞ -> g / gg
        out += i === 0 ? "g" : "gg";
        i += 2;
        const after = chars[i + 1];
        if (after && after in VOWEL_SIGNS) {
          out += VOWEL_SIGNS[after];
          i += 1;
        }
        continue;
      }

      // ্য (ya-phala) after consonant
      if (next === HASANTA && next2 === "\u09AF") {
        const after = chars[i + 3];
        out += CONSONANTS[ch];
        if (i === 0 && after === "\u09BE") {
          // ব্যাক / ক্যামেরা -> e/a sound
          out += "ya";
          i += 3;
        } else if (i === 0 && (!after || !(after in VOWEL_SIGNS))) {
          out += "e";
          i += 2;
        } else {
          out += "y";
          i += 2;
        }
        continue;
      }

      // ্ব (ba-phala) after initial consonant is silent in Bangla (স্বাধীন -> shadhin)
      if (next === HASANTA && next2 === "\u09AC") {
        out += i === 0 ? CONSONANTS[ch] : `${CONSONANTS[ch]}${CONSONANTS[ch]}`;
        i += 2;
        const after = chars[i + 1];
        if (after && after in VOWEL_SIGNS) {
          out += VOWEL_SIGNS[after];
          i += 1;
        } else if (i === 2 && after && isConsonant(after)) {
          out += "o";
        }
        continue;
      }

      // Emit base consonant
      out += CONSONANTS[ch];

      // Special case: ৎ is final t without vowel
      if (ch === "\u09CE") {
        continue;
      }

      if (next === HASANTA) {
        // Consonant cluster: skip inherent vowel
        i += 1;
        continue;
      }

      if (next && next in VOWEL_SIGNS) {
        out += VOWEL_SIGNS[next];
        i += 1;
        continue;
      }

      // Inherent 'o' vowel rule for Bengali:
      // 1) Initial consonant before another consonant (কর -> kor, কথা -> kotha, পডকাস্ট -> podkast)
      // 2) Penultimate consonant before a final bare consonant (কেমন -> kemon, এখন -> ekhon, মানুষ -> manush)
      // Medial consonants before consonant+vowel drop the schwa (আজকে -> ajke, থাকতে -> thakte).
      if (next && isConsonant(next)) {
        const nextIsFinalLetter =
          i + 1 === chars.length - 1 ||
          (!isConsonant(chars[i + 2]) && !isVowelOrSign(chars[i + 2]) && chars[i + 2] !== HASANTA);
        if (i === 0 || nextIsFinalLetter) {
          out += "o";
        }
      }
      continue;
    }

    // Any non-Bengali character (English, punctuation, symbols) passes through untouched
    out += ch;
  }

  return out;
}

export function containsBengaliScript(text: string): boolean {
  return BENGALI_CHAR_REGEX.test(text);
}

/**
 * Transliterates Bengali Unicode text into readable Romanized Banglish while
 * preserving English words, numbers, spacing, and punctuation.
 */
export function transliterateBengaliToBanglish(text: string): string {
  if (!text || !containsBengaliScript(text)) {
    return text;
  }

  return text
    .split(/(\s+)/)
    .map((token) => (containsBengaliScript(token) ? transliterateBengaliWord(token) : token))
    .join("");
}
