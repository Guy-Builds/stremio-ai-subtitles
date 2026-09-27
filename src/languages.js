'use strict';

// What the translator needs to know about a target language.
//
// The instructions we give the model are not per-language trivia. They come
// down to four properties, and everything else in the pipeline - timing,
// chunking, speaker names, caching - does not care what the language is:
//
//   script    which alphabet the answer must be written in, and therefore
//             which characters coming back are a sign the model drifted
//   rtl       whether a finished line needs an explicit right-to-left run so
//             that a full stop does not jump to the wrong end
//   gender2p  whether addressing someone forces a choice English does not
//             make - Hebrew אתה/את, Arabic أنتَ/أنتِ, Russian past tense
//   formality whether the language distinguishes a familiar from a polite
//             "you" - tu/vous, du/Sie, tú/usted
//
// A language is a row here. Adding one is data, not code. A code that is not
// in the table still works: it falls back to Latin script, left-to-right, and
// no special guidance, which is correct for most of the world's subtitles.

// Codes are ISO 639-2/B, the three-letter form Stremio expects in a
// subtitle's `lang` field.

const LANGUAGES = [
  // code    name                native                script      rtl  gen2p  formal
  ['heb', 'Hebrew',            'עברית',               'hebrew',   true,  true,  false],
  ['chi', 'Chinese (Simplified)', '简体中文',          'han',      false, false, true ],
  ['hin', 'Hindi',             'हिन्दी',                'devanagari', false, true, true ],
  ['spa', 'Spanish',           'Español',             'latin',    false, true,  true ],
  ['ara', 'Arabic',            'العربية',              'arabic',   true,  true,  false],
  ['fre', 'French',            'Français',            'latin',    false, true,  true ],
  ['ben', 'Bengali',           'বাংলা',                'bengali',  false, false, true ],
  ['pob', 'Portuguese (Brazil)', 'Português (Brasil)', 'latin',    false, true,  true ],
  ['por', 'Portuguese (Portugal)', 'Português (Portugal)', 'latin', false, true,  true ],
  ['rus', 'Russian',           'Русский',             'cyrillic', false, true,  true ],
  ['urd', 'Urdu',              'اردو',                'arabic',   true,  true,  true ],
  ['ind', 'Indonesian',        'Bahasa Indonesia',    'latin',    false, false, true ],
  ['jpn', 'Japanese',          '日本語',               'japanese', false, false, true ],
  ['ger', 'German',            'Deutsch',             'latin',    false, false, true ],
  ['swa', 'Swahili',           'Kiswahili',           'latin',    false, false, false],
  ['tel', 'Telugu',            'తెలుగు',               'telugu',   false, true,  true ],
  ['tur', 'Turkish',           'Türkçe',              'latin',    false, false, true ],
  ['tam', 'Tamil',             'தமிழ்',                'tamil',    false, true,  true ],
  ['vie', 'Vietnamese',        'Tiếng Việt',          'latin',    false, false, true ],
  ['kor', 'Korean',            '한국어',               'korean',   false, false, true ],
  ['tgl', 'Filipino',          'Filipino',            'latin',    false, false, true ],
  ['fas', 'Persian',           'فارسی',               'arabic',   true,  false, true ],
  ['may', 'Malay',             'Bahasa Melayu',       'latin',    false, false, true ],
  ['ita', 'Italian',           'Italiano',            'latin',    false, true,  true ],
  ['tha', 'Thai',              'ไทย',                 'thai',     false, false, true ],
  ['pol', 'Polish',            'Polski',              'latin',    false, true,  true ],
  ['ukr', 'Ukrainian',         'Українська',          'cyrillic', false, true,  true ],
  ['mal', 'Malayalam',         'മലയാളം',             'malayalam', false, false, true ],
  ['dut', 'Dutch',             'Nederlands',          'latin',    false, false, true ],
  ['rum', 'Romanian',          'Română',              'latin',    false, true,  true ],
  ['gre', 'Greek',             'Ελληνικά',            'greek',    false, true,  true ],
  ['hun', 'Hungarian',         'Magyar',              'latin',    false, false, true ],
  ['cze', 'Czech',             'Čeština',             'latin',    false, true,  true ],
  ['swe', 'Swedish',           'Svenska',             'latin',    false, false, false],
  ['srp', 'Serbian',           'Српски',              'cyrillic', false, true,  true ],
  ['bul', 'Bulgarian',         'Български',           'cyrillic', false, true,  true ],
  ['hrv', 'Croatian',          'Hrvatski',            'latin',    false, true,  true ],
  ['dan', 'Danish',            'Dansk',               'latin',    false, false, false],
  ['fin', 'Finnish',           'Suomi',               'latin',    false, false, true ],
  ['nor', 'Norwegian',         'Norsk',               'latin',    false, false, false],
  ['slo', 'Slovak',            'Slovenčina',          'latin',    false, true,  true ],
  ['aze', 'Azerbaijani',       'Azərbaycan',          'latin',    false, false, true ],
  ['kaz', 'Kazakh',            'Қазақша',             'cyrillic', false, false, true ],
  ['alb', 'Albanian',          'Shqip',               'latin',    false, true,  true ],
  ['slv', 'Slovenian',         'Slovenščina',         'latin',    false, true,  true ],
  ['lit', 'Lithuanian',        'Lietuvių',            'latin',    false, true,  true ],
  ['lav', 'Latvian',           'Latviešu',            'latin',    false, true,  true ],
  ['mac', 'Macedonian',        'Македонски',          'cyrillic', false, true,  true ],
  ['geo', 'Georgian',          'ქართული',            'georgian', false, false, true ],
  ['arm', 'Armenian',          'Հայերեն',             'armenian', false, false, true ],
  ['cat', 'Catalan',           'Català',              'latin',    false, true,  true ],
  ['est', 'Estonian',          'Eesti',               'latin',    false, false, true ],
  ['glg', 'Galician',          'Galego',              'latin',    false, true,  true ],
  ['ice', 'Icelandic',         'Íslenska',            'latin',    false, true,  false],
  ['baq', 'Basque',            'Euskara',             'latin',    false, false, true ],
];

// The actual forms, for the languages where naming them is better than
// describing them. A generic instruction to "mark gender" is weaker than
// showing the model the four words it has to choose between. Languages absent
// from this map still get the rule, just without the examples.
const FORMS = {
  heb: { gender: 'אתה / את / אתם / אתן' },
  ara: { gender: 'أنتَ / أنتِ / أنتما / أنتم / أنتن' },
  urd: { gender: 'تم / آپ, with verb and adjective agreement', formal: 'تم (familiar) / آپ (polite)' },
  spa: { gender: 'adjectives and participles agree: cansado / cansada, and vosotros / vosotras',
         formal: 'tú (familiar) / usted (polite), and the verb form that goes with each' },
  // Brazil and Portugal differ in vocabulary, grammar and forms of address,
  // enough that one reads as foreign to the other. Each gets its own row.
  pob: { gender: 'adjectives and participles agree: obrigado / obrigada',
         formal: 'você (everyday, for everyone) / o senhor, a senhora (polite); do not use tu',
         variety: 'Brazilian Portuguese as spoken in Brazil - Brazilian vocabulary (trem, ônibus, celular, geladeira), você rather than tu, the gerund (estou fazendo), Brazilian spelling and pronoun placement. Never European Portuguese forms' },
  por: { gender: 'adjectives and participles agree: obrigado / obrigada',
         formal: 'tu (familiar) / você, o senhor, a senhora (polite)',
         variety: 'European Portuguese as spoken in Portugal - European vocabulary (comboio, autocarro, telemóvel, frigorífico), estar a + infinitive (estou a fazer), European spelling and pronoun placement. Never Brazilian forms' },
  fre: { gender: 'past participles and adjectives agree: allé / allée, prêt / prête',
         formal: 'tu (familiar) / vous (polite) — note vous is also plural' },
  ita: { gender: 'adjectives and participles agree: stanco / stanca',
         formal: 'tu (familiar) / Lei (polite)' },
  cat: { gender: 'adjectives and participles agree: cansat / cansada', formal: 'tu / vostè' },
  glg: { gender: 'adjectives and participles agree: canso / cansa', formal: 'ti / vostede' },
  rus: { gender: 'the past tense marks it: сказал / сказала, and adjectives agree',
         formal: 'ты (familiar) / вы (polite)' },
  ukr: { gender: 'the past tense marks it: сказав / сказала', formal: 'ти / ви' },
  pol: { gender: 'the past tense and adjectives mark it: byłeś / byłaś',
         formal: 'ty (familiar) / pan, pani (polite, with third-person verbs)' },
  cze: { gender: 'the past tense marks it: byl jsi / byla jsi', formal: 'ty / vy' },
  slo: { gender: 'the past tense marks it: bol si / bola si', formal: 'ty / vy' },
  slv: { gender: 'the past tense and dual forms mark it', formal: 'ti / vi' },
  hrv: { gender: 'the past tense marks it: bio si / bila si', formal: 'ti / Vi' },
  srp: { gender: 'the past tense marks it: био си / била си', formal: 'ти / Ви' },
  bul: { gender: 'the past tense and adjectives mark it', formal: 'ти / Вие' },
  mac: { gender: 'the past tense and adjectives mark it', formal: 'ти / Вие' },
  rum: { gender: 'adjectives and participles agree: obosit / obosită', formal: 'tu / dumneavoastră' },
  gre: { gender: 'adjectives and participles agree: κουρασμένος / κουρασμένη', formal: 'εσύ / εσείς' },
  lit: { gender: 'adjectives and participles agree', formal: 'tu / jūs' },
  lav: { gender: 'adjectives and participles agree', formal: 'tu / jūs' },
  alb: { gender: 'adjectives agree', formal: 'ti / ju' },
  ice: { gender: 'adjectives and participles agree' },
  hin: { gender: 'verbs agree with the addressee: गया / गई', formal: 'तू / तुम / आप, three levels' },
  tam: { gender: 'verb endings mark it', formal: 'நீ / நீங்கள்' },
  tel: { gender: 'verb endings mark it', formal: 'నువ్వు / మీరు' },
  ger: { formal: 'du (familiar) / Sie (polite, with third-person plural verbs)' },
  dut: { formal: 'je/jij (familiar) / u (polite)' },
  tur: { formal: 'sen (familiar) / siz (polite)' },
  fin: { formal: 'sinä (familiar) / te (polite)' },
  est: { formal: 'sina (familiar) / teie (polite)' },
  hun: { formal: 'te (familiar) / ön, maga (polite)' },
  fas: { formal: 'تو (familiar) / شما (polite)' },
  jpn: { formal: 'plain form / です-ます / honorific and humble forms — the level is a character choice, not a detail' },
  kor: { formal: '반말 / 해요체 / 합쇼체 — pick by relationship and keep it' },
  chi: { formal: '你 (familiar) / 您 (polite)' },
  tha: { formal: 'particles ครับ / ค่ะ and pronoun choice carry the level' },
  vie: { formal: 'the pronoun pair encodes age and status: anh, chị, em, ông, bà' },
  ind: { formal: 'kamu (familiar) / Anda (polite)' },
  may: { formal: 'kamu (familiar) / anda (polite)' },
  tgl: { formal: 'ka / kayo, with po and opo marking respect' },
  geo: { formal: 'შენ / თქვენ' },
  arm: { formal: 'դու / դուք' },
  aze: { formal: 'sən / siz' },
  kaz: { formal: 'сен / сіз' },
  baq: { formal: 'hi/hu (familiar) / zu (polite)' },
  ben: { formal: 'তুই / তুমি / আপনি, three levels' },
  mal: { formal: 'നീ / നിങ്ങൾ / താങ്കൾ' },
};

// Where each script lives in Unicode. Used both to tell the model which
// alphabet to write in and to notice when it has drifted into another one.
const SCRIPTS = {
  latin:      '\\u0041-\\u024F\\u1E00-\\u1EFF',
  cyrillic:   '\\u0400-\\u04FF\\u0500-\\u052F',
  greek:      '\\u0370-\\u03FF\\u1F00-\\u1FFF',
  hebrew:     '\\u0590-\\u05FF\\uFB1D-\\uFB4F',
  arabic:     '\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF',
  devanagari: '\\u0900-\\u097F',
  bengali:    '\\u0980-\\u09FF',
  tamil:      '\\u0B80-\\u0BFF',
  telugu:     '\\u0C00-\\u0C7F',
  malayalam:  '\\u0D00-\\u0D7F',
  thai:       '\\u0E00-\\u0E7F',
  han:        '\\u4E00-\\u9FFF\\u3400-\\u4DBF',
  japanese:   '\\u3040-\\u30FF\\u4E00-\\u9FFF\\uFF66-\\uFF9F',
  korean:     '\\uAC00-\\uD7AF\\u1100-\\u11FF\\u3130-\\u318F',
  georgian:   '\\u10A0-\\u10FF',
  armenian:   '\\u0530-\\u058F',
};

const DEFAULT_CODE = 'heb';

// A subtitle line is measured in characters, and a character carries far more
// meaning in a script without spaces. 42 is comfortable for an alphabet; for
// Chinese, Japanese, Korean and Thai the same reading time is about 20.
const DENSE = new Set(['han', 'japanese', 'korean', 'thai']);
const lineLimit = (script) => (DENSE.has(script) ? 20 : 42);

const BY_CODE = new Map();
for (const [code, name, native, script, rtl, gender2p, formality] of LANGUAGES) {
  BY_CODE.set(code, {
    code, name, native, script, rtl, gender2p, formality,
    maxLine: lineLimit(script),
    forms: FORMS[code] || {},
  });
}

// Two- and three-letter variants people actually type, mapped onto the
// canonical code. Also used to recognise a reference track's language field.
const ALIASES = {
  heb: ['he', 'iw', 'hebrew'],      ara: ['ar', 'arabic'],
  fas: ['fa', 'per', 'persian', 'farsi'], urd: ['ur', 'urdu'],
  spa: ['es', 'esp', 'spanish', 'castellano'], por: ['pt', 'pt-pt', 'portuguese'],
  pob: ['pt-br', 'ptbr', 'brazilian'],
  fre: ['fr', 'fra', 'french'],     ita: ['it', 'italian'],
  ger: ['de', 'deu', 'german'],     dut: ['nl', 'nld', 'dutch'],
  pol: ['pl', 'polish'],            cze: ['cs', 'ces', 'czech'],
  slo: ['sk', 'slk', 'slovak'],     slv: ['sl', 'slovenian'],
  hrv: ['hr', 'croatian'],          srp: ['sr', 'serbian'],
  bul: ['bg', 'bulgarian'],         rus: ['ru', 'russian'],
  ukr: ['uk', 'ukrainian'],         rum: ['ro', 'ron', 'romanian'],
  hun: ['hu', 'hungarian'],         gre: ['el', 'ell', 'greek'],
  tur: ['tr', 'turkish'],           swe: ['sv', 'swedish'],
  nor: ['no', 'nob', 'norwegian'],  dan: ['da', 'danish'],
  fin: ['fi', 'finnish'],           ice: ['is', 'isl', 'icelandic'],
  est: ['et', 'estonian'],          lav: ['lv', 'latvian'],
  lit: ['lt', 'lithuanian'],        chi: ['zh', 'zho', 'chinese', 'zh-cn', 'zh-hans'],
  jpn: ['ja', 'japanese'],          kor: ['ko', 'korean'],
  tha: ['th', 'thai'],              vie: ['vi', 'vietnamese'],
  ind: ['id', 'indonesian'],        may: ['ms', 'msa', 'malay'],
  tgl: ['tl', 'fil', 'filipino', 'tagalog'], hin: ['hi', 'hindi'],
  ben: ['bn', 'bengali'],           tam: ['ta', 'tamil'],
  tel: ['te', 'telugu'],            mal: ['ml', 'malayalam'],
  swa: ['sw', 'swahili'],           alb: ['sq', 'sqi', 'albanian'],
  mac: ['mk', 'mkd', 'macedonian'], geo: ['ka', 'kat', 'georgian'],
  arm: ['hy', 'hye', 'armenian'],   aze: ['az', 'azerbaijani'],
  kaz: ['kk', 'kazakh'],            cat: ['ca', 'catalan'],
  glg: ['gl', 'galician'],          baq: ['eu', 'eus', 'basque'],
};

const ALIAS_TO_CODE = new Map();
for (const [code, list] of Object.entries(ALIASES)) {
  for (const a of list) ALIAS_TO_CODE.set(a, code);
}

/** Normalise whatever a user or a subtitle track calls a language. */
function normalize(input) {
  const s = String(input || '').toLowerCase().trim();
  if (!s) return '';
  if (BY_CODE.has(s)) return s;
  if (ALIAS_TO_CODE.has(s)) return ALIAS_TO_CODE.get(s);
  const base = s.split(/[-_]/)[0];
  if (BY_CODE.has(base)) return base;
  if (ALIAS_TO_CODE.has(base)) return ALIAS_TO_CODE.get(base);
  return s; // unknown, but still usable
}

/**
 * Everything the translator needs for one target language. An unknown code
 * is not an error: it gets sensible neutral defaults so the addon still works.
 */
function get(input) {
  const code = normalize(input) || DEFAULT_CODE;
  const known = BY_CODE.get(code);
  if (known) return known;
  return {
    code,
    name: code,
    native: code,
    script: 'latin',
    rtl: false,
    gender2p: false,
    formality: false,
    maxLine: lineLimit('latin'),
    forms: {},
    unknown: true,
  };
}

/** Every language the picker offers, in the table's order. */
function list() {
  return LANGUAGES.map(([code]) => BY_CODE.get(code));
}

/** All the names a reference track might use for this language. */
function aliasesOf(code) {
  const c = normalize(code);
  return [c, ...(ALIASES[c] || [])];
}

/**
 * Characters that have no business appearing in this language's output.
 *
 * The original problem was narrower: the model would slip a single Arabic
 * word into otherwise fine Hebrew. Generalised, the rule is that a finished
 * line should not contain letters from a NON-LATIN script other than the
 * target's own - Latin stays allowed everywhere, because proper names and
 * brands legitimately keep their spelling in every language.
 */
function foreignScriptRe(code) {
  const own = get(code).script;
  const ranges = Object.entries(SCRIPTS)
    .filter(([name]) => name !== 'latin' && name !== own)
    // Japanese and Chinese share the Han block; treat either as native to the other.
    .filter(([name]) => !(own === 'japanese' && name === 'han'))
    .filter(([name]) => !(own === 'han' && name === 'japanese'))
    .map(([, r]) => r)
    .join('');
  return new RegExp(`[${ranges}]`);
}

// Human-readable names for the script blocks, so a retry can tell the model
// exactly what it did wrong instead of saying "another writing system".
const SCRIPT_NAMES = {
  latin: 'Latin', cyrillic: 'Cyrillic', greek: 'Greek', hebrew: 'Hebrew',
  arabic: 'Arabic', devanagari: 'Devanagari', bengali: 'Bengali',
  tamil: 'Tamil', telugu: 'Telugu', malayalam: 'Malayalam', thai: 'Thai',
  han: 'Chinese', japanese: 'Japanese', korean: 'Korean',
  georgian: 'Georgian', armenian: 'Armenian',
};

// The writing systems worth naming in an instruction not to use them. Naming
// them beats "any other script": the observed failure was a single Arabic word
// inside otherwise clean Hebrew, and the rule that stopped it said "Arabic".
const MAJOR = ['arabic', 'cyrillic', 'hebrew', 'greek', 'han', 'japanese', 'korean', 'devanagari', 'thai'];

/** The major writing systems this language must never produce. */
function otherScriptNames(code) {
  const own = get(code).script;
  return MAJOR
    .filter((n) => n !== own)
    .filter((n) => !(own === 'japanese' && n === 'han'))
    .filter((n) => !(own === 'han' && n === 'japanese'))
    .map((n) => SCRIPT_NAMES[n]);
}

/** Which scripts appear in this text, by name. Used to word a retry. */
function scriptsIn(text) {
  const s = String(text || '');
  const found = [];
  for (const [name, range] of Object.entries(SCRIPTS)) {
    if (new RegExp(`[${range}]`).test(s)) found.push(SCRIPT_NAMES[name] || name);
  }
  return found;
}

/** The character range the answer is expected to be written in. */
function scriptRangeOf(code) {
  return SCRIPTS[get(code).script] || SCRIPTS.latin;
}

module.exports = {
  get, list, normalize, aliasesOf, foreignScriptRe, scriptRangeOf, scriptsIn, otherScriptNames,
  DEFAULT_CODE, SCRIPTS,
};
