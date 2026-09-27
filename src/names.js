'use strict';

// Proper names, decided once for the whole episode.
//
// Two problems this fixes, both seen in real use:
//
//   "Billy the Kid" came back as a name plus a translated word, because in the
//   middle of a line it reads as a name followed by an ordinary noun. The rule
//   "keep proper names as they are" does not fire, since only half of it looks
//   like a name.
//
//   Chunks are translated independently, so the same character can be spelled
//   one way early in an episode and another way later. Nothing in a chunk can
//   see what another chunk chose.
//
// Both are solved before translation starts: collect the names locally, ask
// the model once how to write each one, and hand that list to every chunk.

// Words that begin a sentence and therefore get capitalised without being
// names. Only used to judge a single capitalised word.
const COMMON = new Set(`a an and are as at be been but by can could did do does
doing done for from get got had has have he her here hers him his how i if in
is it its just know let like me my no not now of oh off on once one only or our
out over said say see she should so some than that the their them then there
these they this those to too us very was we well were what when where which who
why will with would yes yet you your okay yeah hey hi oh um uh please thanks
thank sorry right left up down back never always maybe really something anything
nothing everything someone anyone everyone nobody because about after before
again against all am any because being below between both during each few more
most other same such only own too under until while
listen look wait tell call come go stop hold give take let hear watch stay sit
stand run move hurry help keep leave put bring try trust forget remember relax
calm shut open close turn follow find ask answer check drop hang pick show wake
stay mind careful easy fine good great sure nice cool wow damn hello goodbye
bye certainly somebody whoa hyah yah hee haw yeehaw huh hmm aha ooh ahh morning evening night afternoon tonight today tomorrow yesterday so still
even why whatever wherever however anyway alright guys man dude look sit`.split(/\s+/));

const MAX_LINES = 6000;
const MAX_LINE_LEN = 500;

const TITLES =
  'Mr|Mrs|Ms|Miss|Dr|Prof|Professor|Det|Detective|Sgt|Sergeant|Capt|Captain|' +
  'Lt|Lieutenant|Col|Colonel|Gen|General|Officer|Agent|Judge|Father|Sister|' +
  'Rabbi|Sheikh|Imam|Sir|Lady|Lord|President|Senator|Mayor|Chief|Coach|Uncle|Aunt';

/**
 * Find the proper names in an episode's English text.
 *
 * Ordered so that the longest match wins: "Billy the Kid" must be found before
 * the bare "Billy", or the glossary would tell the model how to write "Billy"
 * and leave the epithet loose again.
 *
 * @param {string[]} lines  the English text of each cue
 * @param {object} [opts]   {min: how many times a name must appear, max: list size}
 * @returns {{name:string,count:number,sample:string}[]}
 */
function extractNames(lines, { min = 2, max = 40 } = {}) {
  // Bounded input. A real subtitle line is well under 100 characters; the
  // caps only matter for a file built to make this pass slow.
  const src = lines.slice(0, MAX_LINES).map((l) => String(l || '').slice(0, MAX_LINE_LEN));

  // Where a sentence starts, a capital letter says nothing about whether the
  // word is a name. "Call Dr. Chen" is not about someone called Call.
  // Only the few characters just before the word are looked at, so a long
  // line costs the same per word as a short one.
  const atSentenceStart = (line, idx) => {
    const lead = line.search(/[^\s"'“‘(\[]/);
    if (lead < 0 || idx <= lead) return true;
    const from = Math.max(0, idx - 24);
    const before = line.slice(from, idx).replace(/["'“‘(\[]+$/, '').trimEnd();
    if (before === '') return from === 0;
    return /[.!?…:]$/.test(before) || (from === 0 ? /(^|\s)[-–—]$/ : /\s[-–—]$/).test(before);
  };

  // Two kinds of evidence that a capitalised word is a name:
  //   - it is capitalised somewhere mid-sentence, where grammar would not
  //     capitalise an ordinary word;
  //   - it never appears in lower case anywhere in the episode.
  const midCaps = new Set();
  const lowerSeen = new Set();
  // A word used only as a shout - "Hyah!", "Hee-yaw!" - is a call to a horse
  // or a sound, not a name, however often it recurs. Seen in a real western:
  // "Hyah" was settled as a name, and every "Hyah!" came out in Hebrew as a
  // word meaning "was". So a single word needs at least one ordinary use.
  const plainUse = new Set();
  for (const line of src) {
    for (const m of line.matchAll(/\b[A-Z][a-z]+\b/g)) {
      const start = atSentenceStart(line, m.index);
      if (!start) midCaps.add(m[0]);
      const next = line.slice(m.index + m[0].length);
      if (!(start && /^\s*(?:[!\-–—]|\?!)/.test(next))) plainUse.add(m[0]);
    }
    for (const m of line.matchAll(/\b[a-z]+\b/g)) lowerSeen.add(m[0]);
  }
  const titleRe = new RegExp(`^(?:${TITLES})$`);
  const nameLike = (w) =>
    titleRe.test(w) || midCaps.has(w) || (!lowerSeen.has(w.toLowerCase()) && !COMMON.has(w.toLowerCase()));

  const found = new Map(); // name -> {count, sample}
  const seenSpans = new Set(); // one count per place in the text, however many rules match it

  const add = (li, at, name) => {
    const n = name.trim().replace(/\s+/g, ' ');
    if (!n) return;
    const span = `${li}:${at}:${n}`;
    if (seenSpans.has(span)) return;
    seenSpans.add(span);
    const cur = found.get(n);
    if (cur) cur.count++;
    else found.set(n, { count: 1, sample: src[li].slice(0, 90) });
  };

  // A multi-word match that begins a sentence may have picked up the word the
  // sentence happens to start with. Drop that word unless it is a name itself.
  const trimStart = (line, idx, text) => {
    const words = text.split(/\s+/);
    if (atSentenceStart(line, idx) && !nameLike(words[0])) {
      const rest = words.slice(1).join(' ');
      return { at: idx + text.indexOf(rest), text: rest };
    }
    return { at: idx, text };
  };

  src.forEach((line, li) => {
    // 1. A name with an epithet: Billy the Kid, Jack the Ripper, Ivan the Terrible.
    for (const m of line.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+the\s+[A-Z][a-z]+\b/g)) {
      const t = trimStart(line, m.index, m[0]);
      if (/\sthe\s/.test(t.text) && !COMMON.has(t.text.split(/\s+/)[0].toLowerCase())) add(li, t.at, t.text);
    }
    // 2. A title and a name: Detective Rowe, Mrs. Alvarez, Dr. Chen.
    for (const m of line.matchAll(new RegExp(`\\b(?:${TITLES})\\.?\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?\\b`, 'g'))) {
      add(li, m.index, m[0]);
    }
    // 3. Two or more capitalised words in a row: John Carter, New Orleans.
    for (const m of line.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g)) {
      const t = trimStart(line, m.index, m[0]);
      const words = t.text.split(/\s+/);
      if (words.length < 2) continue;
      if (titleRe.test(words[words.length - 1])) continue; // the front half of "Dr. Chen"
      if (COMMON.has(words[0].toLowerCase())) continue;
      add(li, t.at, t.text);
    }
    // 4. A single capitalised word, but only with evidence that it is a name.
    for (const m of line.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
      const w = m[0];
      if (COMMON.has(w.toLowerCase()) || titleRe.test(w) || !nameLike(w) || !plainUse.has(w)) continue;
      add(li, m.index, w);
    }
  });

  // Drop anything already covered by a longer name: "Billy" inside
  // "Billy the Kid", "Rowe" inside "Detective Rowe".
  // Names that could never make the final list are dropped first, and
  // coverage is a set lookup of each kept name's word runs - not a regex per
  // pair, which a file full of distinct names turned into hours of work.
  const all = [...found.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .filter((e) => e.count >= min || /\s/.test(e.name)) // a multi-word name counts once
    .sort((a, b) => b.name.length - a.name.length);
  const kept = [];
  const inside = new Set(); // every run of whole words within a kept name, except the name itself
  for (const entry of all) {
    if (inside.has(entry.name)) continue;
    kept.push(entry);
    const w = entry.name.split(/\s+/);
    for (let i = 0; i < w.length; i++) {
      for (let j = i + 1; j <= w.length; j++) {
        if (j - i < w.length) inside.add(w.slice(i, j).join(' '));
      }
    }
  }

  return kept
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, max);
}

/** The instruction that turns the list into a decision. */
function glossaryPrompt(names, lang) {
  const rows = names
    .map((n) => `${n.name}${n.sample ? `   — as in: ${n.sample}` : ''}`)
    .join('\n');
  return `These are the proper names that appear in an episode being translated into ${lang.name}.

For each one, give the exact form to use in ${lang.name}, and use it consistently everywhere.

RULES:
- A name with an epithet is ONE name, decided as a whole. The epithet is a title made of ordinary words, so it is TRANSLATED by what it means as a title - the way ${lang.name} history books and film titles do it: Billy the Kid is "Billy" plus the ${lang.name} word for a young man or lad (in Hebrew: בילי הנער), never a word for a young goat; Jack the Ripper and Ivan the Terrible likewise translate their epithets. If ${lang.name} conventionally keeps the whole name in English, keep it whole and unchanged.
- NEVER mix the two: do not translate "the" and transliterate the rest (הקיד, הד קיד, el Kid). Either the whole epithet is translated, or the whole name stays as it is.
- Where a well-known person, place, or work already has a standard form in ${lang.name}, use the standard form rather than inventing one.
- A nickname, company, gang or institution that is called by ordinary words - "the House", "the Company", "the Butcher Shop", "the Regulators" - is TRANSLATED by meaning, the way a human subtitler would, never transliterated. Give the plain form; the translator adds articles and prefixes as the grammar of each sentence needs.
- A capitalised word for a MEMBER of a group or institution takes that group's established term, read from the sample line - never the everyday meaning of the word: a Mason who joins a lodge is a Freemason (Hebrew: בונה חופשי), not a builder; a Regulator in a western is one of the Regulators, a Ranger one of the Rangers.
- A real place (a town, county, river, country) keeps its name, transliterated, even when its English words have a meaning: White Oaks stays White Oaks in ${lang.name} letters. Only ordinary words attached to it are translated: "Lincoln County" gives the ${lang.name} word for county plus Lincoln.
- Otherwise transliterate by sound, in the ${lang.name} writing system.
- Titles such as Doctor, Detective or Mrs. ARE translated; the name after them is not.
- If ${lang.name} conventionally keeps foreign names in Latin letters, say so by returning the name unchanged.
- If an entry is NOT actually a proper name - an ordinary word that only looks like one because it starts a sentence, such as "Listen" or "Call", or a shout or sound such as "Hyah" or "Whoa" - return it with the form SKIP. Forcing an ordinary word into one fixed form would break grammar elsewhere.
- Return every entry given, once each, and nothing else.

NAMES:
${rows}`;
}

module.exports = { extractNames, glossaryPrompt };
