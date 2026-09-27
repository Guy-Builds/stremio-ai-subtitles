'use strict';

const { cueToSource, isNonVerbal, wrap, markDirection, hasForeignScriptFor, splitSdh } = require('./srt');
const langs = require('./languages');
const { extractNames, glossaryPrompt } = require('./names');

// Flash by default: it chooses words noticeably better than Flash-Lite. When
// its free daily quota runs out, gemini-fetch.js moves to Flash-Lite on its
// own (GEMINI_FALLBACK). GEMINI_MODEL may also be a comma-separated list.
const MODELS = (process.env.GEMINI_MODEL || 'gemini-flash-latest')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODEL = MODELS.join(' → ');
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const RETRIES = parseInt(process.env.GEMINI_RETRIES || '6', 10);
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

// How many timed cues go into one request, and how many neighbouring cues
// are shown as read-only context on each side of the chunk.
const CHUNK = parseInt(process.env.CHUNK_SIZE || '120', 10);
const CONTEXT = parseInt(process.env.CONTEXT_CUES || '12', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
// How many times a flawed or missing line is asked for again. Each round only
// resends the lines that are still wrong, so a second round is usually tiny.
const REDO_ROUNDS = parseInt(process.env.REDO_ROUNDS || '2', 10);
const MAX_CUES = parseInt(process.env.MAX_CUES || '5000', 10);
// Per-episode request budget: a fixed allowance plus a few per chunk.
const REQ_BASE = 20;
const REQ_PER_CHUNK = 8;

// The instructions are assembled from what the target language actually
// requires, not written out per language. Four properties decide it: the
// script to write in, the direction, whether addressing someone forces a
// gender choice, and whether there is a familiar/polite distinction.
function systemPrompt(lang) {
  const L = lang.name;
  let p = BASE.replace(/\{LANG\}/g, L);
  if (lang.gender2p) p += gender2pRules(lang);
  if (lang.formality) p += formalityRules(lang);
  if (lang.forms.variety) p += `\n\nVARIETY — write ${lang.forms.variety}.`;
  p += scriptRules(lang);
  return p;
}

function gender2pRules(lang) {
  return `

SECOND PERSON — ${lang.name} forces a choice English does not:
- English "you" carries no gender and often no number. ${lang.name} marks them, and the verbs, adjectives and possessives that go with them agree. You MUST decide, every single time.${
  lang.forms.gender ? `\n- In ${lang.name} that means: ${lang.forms.gender}.` : ''
}
- Work it out from the passage: who is speaking to whom, names used, how other characters refer to them, and the CONTEXT lines around the block. A group is addressed differently from one person.
- Once you have decided a character's gender, keep it identical for the rest of the passage. A character addressed as one gender in one line and the other three lines later is the most jarring mistake you can make.
- The same applies to first person plural, to "they", and to a narrator addressing the viewer.
- Only when the passage genuinely gives you nothing, choose the reading that fits the scene best and stay consistent with it - never alternate.`;
}

function formalityRules(lang) {
  return `

REGISTER OF ADDRESS — ${lang.name} distinguishes a familiar "you" from a polite one:${
  lang.forms.formal ? `\n- In ${lang.name}: ${lang.forms.formal}.` : ''
}
- English does not mark this at all, so you must infer it: how well the characters know each other, their relative status and age, whether the setting is private or official, and whether they are on first-name terms.
- Strangers, officials, employers and elders normally take the polite form; family, close friends, children and intimates take the familiar one.
- A switch between the two is a real dramatic event. Only make it when the scene clearly earns it, and then keep the new form.
- Keep one character's form toward another consistent for the whole passage.`;
}

function scriptRules(lang) {
  return `

SCRIPT — write in ${lang.name}:
- Every translated word must be written in the ${lang.name} writing system, except proper names and brands that conventionally stay in Latin letters, plus digits and punctuation.
- NEVER output ${langs.otherScriptNames(lang.code).join(', ')} or any other writing system that is not ${lang.name}'s own. Not a single word, not a single character. If a term feels foreign, write it in ${lang.name} instead.`;
}

const BASE = `You are a professional subtitle translator working from English into modern, natural {LANG}.

HOW TO WORK — this order matters:
1. First READ THE WHOLE PASSAGE you are given as one continuous piece of dialogue. Subtitle lines are cut by screen timing, not by sentence, so a single sentence is often split across several numbered lines and a line on its own is frequently meaningless or misleading.
2. Understand the passage as a whole: who is speaking, what the sentence actually means, idioms, running jokes, pronoun antecedents, callbacks to the CONTEXT lines.
3. Only THEN produce the {LANG}, and redistribute that {LANG} back across the SAME numbered lines, so that the text appearing on screen at line N matches what is being said during line N's moment.

RULES:
- Output exactly one entry for every numbered line in the TRANSLATE block — same numbers, none added, none skipped, none merged.
- NEVER translate a line in isolation when it is part of a longer sentence. Translate the sentence, then split the result across its lines at a natural point, following {LANG} word order — not English word order.
- Prefer tight, spoken phrasing. Keep each line close to the reading time of its English source so it matches the picture; a line that takes longer to read than it is on screen is a failure.
- Natural spoken {LANG}, not literal word-for-word. Translate idioms to their {LANG} equivalent in meaning and register, never literally.
- Shouts, calls and interjections (Hyah!, Whoa!, Giddy-up!, Psst) get what a {LANG} speaker would actually shout in that moment - for driving a horse in Hebrew, דיו! - never a transliteration of the English sound, and above all never a transliteration that happens to spell an ordinary {LANG} word.
- Keep the register and tone of each speaker: slang stays slang, formal stays formal, rudeness stays rude.
- Keep a leading "- " dialogue dash when the source line has one (two speakers in one line keep both dashes).
- Keep ♪ around song/music lines; keep proper names, brands and numbers as-is unless a {LANG} form is standard.
- A name followed by "the" and a word is ONE name, not a name plus a noun: Billy the Kid, Jack the Ripper, Ivan the Terrible. Its epithet is a title: never translate it as an ordinary noun in the sentence (Kid is not a young goat), and never half-translate it. Use the form given under NAMES.
- Sound descriptions such as [door creaks] have already been removed before you see the text; do not invent any.
- Do not add explanations, notes, transliterations or quotation marks that are not in the source.
- NEVER write the straight " character. If the source quotes someone and {LANG} needs quotation marks, use the marks {LANG} itself uses.
- Never output English text except for names/brands that stay in Latin script.
- If a line has no translatable words (music notes, dashes only), return it unchanged.
- CONTEXT lines are for understanding only. Do not return them.`;

const STRIP_SOUND = process.env.KEEP_SOUND_CUES !== '1';
// One extra request per episode that fixes every proper name in advance.
const NAMES_PASS = process.env.NAME_GLOSSARY !== '0';

// Added only when the source track actually names its speakers. Worth far
// more in a language that marks the addressee's gender, so the last line is
// only included when that applies.
function sdhRules(lang) {
  return `

SPEAKER NAMES ARE MARKED:
- A line beginning with <NAME> tells you who says it. This is metadata, NOT part of the dialogue - never translate it and never include it in your answer.
- Use it to follow the turn-taking. The person being addressed is normally whoever spoke the previous turn.${
  lang.gender2p
    ? '\n- Names are also your best evidence for a character\'s gender, which this language forces you to mark. Once a name tells you, apply it everywhere that character is spoken to or about.'
    : ''
}`;
}

const REF_LABEL = (process.env.REFERENCE_LANG || 'ref').toUpperCase();

// Added to the system prompt only when a reference track is actually present.
const REF_RULES = `

A SECOND TRANSLATION IS PROVIDED:
- Some lines carry a [${REF_LABEL}] line underneath: the same moment as translated by a professional into another language.
- Use it to settle what English leaves open - above all WHO IS BEING ADDRESSED and their gender and number, which that language marks and English does not. Its grammar is evidence; follow it.
- It also disambiguates pronouns, formality, and any line whose English is ambiguous on its own.
- Translate the ENGLISH line. The reference is evidence about meaning, never the text to translate. Where the two disagree on wording, the English wins; where they disagree on who is being addressed, the reference wins.
- Where the English line is missing or empty but the reference is not, the English track simply did not translate that moment. Translate it from the reference.`;

function buildPrompt(chunk, before, after, lang, glossary) {
  const fmt = (arr) =>
    arr
      .map((c) => {
        const who = c.speaker ? `<${c.speaker}> ` : '';
        const head = `${c.n}| ${who}${c.text}`;
        return c.ref ? `${head}\n   [${REF_LABEL}] ${c.ref}` : head;
      })
      .join('\n');
  let p = '';
  if (glossary && glossary.size) {
    // Decided once for the whole episode, so every chunk spells a name the
    // same way and no epithet gets translated as an ordinary word.
    const rows = [...glossary].map(([en, t]) => `${en} = ${t}`).join('\n');
    p += `NAMES — use these forms every time. Add articles, prefixes or case endings as the sentence needs, but never change the name itself:\n${rows}\n\n`;
  }
  if (before.length) p += `CONTEXT BEFORE (do not translate):\n${fmt(before)}\n\n`;
  p += `TRANSLATE (return exactly these ${chunk.length} numbered lines, in ${lang.name}):\n${fmt(chunk)}\n`;
  if (after.length) p += `\nCONTEXT AFTER (do not translate):\n${fmt(after)}\n`;
  return p;
}

async function callGemini(apiKey, prompt, { temperature = 0.3, retries = RETRIES, log, withRef = false, withSpk = false, lang, schema, budget } = {}) {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(lang) + (withRef ? REF_RULES : '') + (withSpk ? sdhRules(lang) : '') }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      responseSchema: schema || {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { n: { type: 'INTEGER' }, he: { type: 'STRING' } },
          required: ['n', 'he'],
        },
      },
    },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Google sometimes tells us exactly how long to wait; prefer that.
  const retryDelayMs = (txt) => {
    const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(txt || '');
    return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
  };

  let lastErr;
  // Walk the model list; each model gets the full retry budget before we
  // fall through to the next one.
  for (const model of MODELS) {
    for (let attempt = 0; attempt < retries; attempt++) {
      // Every request counts against the episode's budget, retries included.
      if (budget && budget.left-- <= 0) {
        throw Object.assign(new Error('request budget for this episode used up'), { budget: true });
      }
      try {
        const res = await fetch(`${API_BASE}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          // The fetch wrapper may have answered from the fallback model; it
          // says which. Google's error is a block of JSON - keep one line of it.
          const used = (res.headers && res.headers.get && res.headers.get('x-gemini-model')) || model;
          const said = (/"message"\s*:\s*"([^"]{1,120})/.exec(txt) || [])[1] || txt.replace(/\s+/g, ' ').trim();
          const what = `gemini ${used} ${res.status}: ${said.slice(0, 120)}`;
          if (RETRYABLE.has(res.status)) {
            throw Object.assign(new Error(what), { status: res.status, wait: retryDelayMs(txt) });
          }
          // 400/401/403/404 will not improve by waiting — move to next model.
          throw Object.assign(new Error(what), { nextModel: true });
        }
        const json = await res.json();
        const text = (json.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || '')
          .join('');
        if (!text) {
          // Google's content filter refused this passage. Asking again gets
          // the same answer, so it is not retried here: the caller splits the
          // chunk instead, to find the few lines that trip the filter.
          const c = json.candidates?.[0] || {};
          const why = json.promptFeedback?.blockReason || c.finishReason || '';
          if (/SAFETY|PROHIBITED|BLOCKLIST|SPII|OTHER/i.test(why)) {
            throw Object.assign(new Error(`blocked by the content filter (${why})`), { blocked: true });
          }
          throw new Error('empty response from gemini');
        }
        return JSON.parse(text);
      } catch (e) {
        lastErr = e;
        if (e.blocked) throw e;
        if (e.nextModel) break;
        if (attempt === retries - 1) break;
        // 2s, 5s, 11s, 23s, 47s … capped at 60s, plus jitter.
        const backoff = Math.min(60000, 2000 * 2 ** attempt + Math.random() * 1000);
        const waitMs = Math.max(e.wait || 0, backoff);
        log?.(`  ⏳ ${e.message.slice(0, 90)} — waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
    }
    if (MODELS.length > 1) log?.(`  ↪ giving up on ${model}, trying next model`);
  }
  throw lastErr;
}

// A line that comes back a fraction of the length of its source has almost
// always been cut short rather than translated tersely - a quote closing the
// JSON string early is the usual cause. Dense writing systems are genuinely
// much shorter than English, so the bar moves with the script; very short
// sources vary too much to judge at all.
function looksTruncated(src, out, lang) {
  const a = String(src || '').replace(/\s+/g, ' ').trim();
  const b = String(out || '').replace(/\s+/g, ' ').trim();
  if (a.length < 25) return false;
  return b.length / a.length < (lang.maxLine <= 20 ? 0.15 : 0.4);
}

async function translateChunk(apiKey, chunk, before, after, log, lang, glossary, budget) {
  const want = new Set(chunk.map((c) => c.n));
  const srcOf = new Map(chunk.map((c) => [c.n, c.text || c.ref || '']));
  const out = new Map();
  const withRef = chunk.some((c) => c.ref) || before.some((c) => c.ref) || after.some((c) => c.ref);
  const withSpk = chunk.some((c) => c.speaker) || before.some((c) => c.speaker);

  // A line that comes back in the wrong script, or cut short, is held aside
  // rather than thrown away. We ask for it again - and check the answer again,
  // since a model that slipped once can slip twice. If every attempt is
  // flawed, the last one is still kept: a line with one stray word is more
  // use to the viewer than an English line.
  const held = new Map(); // n -> { text, why: 'script' | 'cut' }

  const absorb = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const n = Number(item?.n);
      const he = typeof item?.he === 'string' ? item.he.trim() : '';
      if (!want.has(n) || !he || out.has(n)) continue;
      if (hasForeignScriptFor(he, lang.code)) { held.set(n, { text: he, why: 'script' }); continue; }
      if (looksTruncated(srcOf.get(n), he, lang)) { held.set(n, { text: he, why: 'cut' }); continue; }
      out.set(n, he);
    }
  };

  absorb(await callGemini(apiKey, buildPrompt(chunk, before, after, lang, glossary), { log, withRef, withSpk, lang, budget }));

  for (let round = 1; round <= REDO_ROUNDS; round++) {
    const missing = chunk.filter((c) => !out.has(c.n));
    if (!missing.length) break;

    const flawed = missing.map((c) => held.get(c.n)).filter(Boolean);
    const bad = flawed.filter((h) => h.why === 'script');
    const cut = flawed.filter((h) => h.why === 'cut');
    const why = [bad.length ? `${bad.length} had the wrong script` : '', cut.length ? `${cut.length} came back cut short` : '']
      .filter(Boolean).join(', ');
    log(`  ↻ ${missing.length} lines to redo${round > 1 ? ` (try ${round + 1})` : ''}${why ? ` (${why})` : ''}`);

    // Naming the script that came back is worth more than a generic scolding.
    const strayNames = [...new Set(
      bad.flatMap((h) => langs.scriptsIn(h.text))
        .filter((n) => n !== 'Latin' && n !== langs.get(lang.code).name)
    )];
    const note =
      (bad.length ? `\nThe previous attempt returned ${strayNames.join(' and ') || 'foreign-script'} characters. Write in ${lang.name} only this time.\n` : '') +
      (cut.length ? `\nThe previous attempt cut some of these lines off partway. Translate each one in full, to the end of the sentence, and do not use the straight " character anywhere.\n` : '');
    absorb(
      await callGemini(
        apiKey,
        buildPrompt(missing, before.concat(chunk.slice(0, 6)), after, lang, glossary) + note,
        { temperature: round === 1 ? 0.1 : 0, log, withRef, withSpk, lang, budget }
      )
    );
  }

  // Anything still unanswered falls back to its last flawed attempt.
  let salvaged = 0;
  let short = 0;
  for (const [n, h] of held) {
    if (out.has(n)) continue;
    out.set(n, h.text);
    if (h.why === 'cut') short++; else salvaged++;
  }
  if (salvaged) log(`  ~ ${salvaged} line(s) kept with a foreign word rather than left in English`);
  if (short) log(`  ~ ${short} line(s) kept although they look cut short`);

  return out;
}

// A chunk can fail wholesale when one line inside it trips Gemini's content
// filter. Rather than abandoning all of it, split and retry: only the small
// stretch that actually trips the filter ends up staying in English.
const MIN_SPLIT = parseInt(process.env.MIN_SPLIT || '8', 10);

async function bisect(apiKey, chunk, before, after, log, label, lang, glossary, budget) {
  try {
    return await translateChunk(apiKey, chunk, before, after, log, lang, glossary, budget);
  } catch (e) {
    if (e.budget) {
      log(`  ! ${label}: request budget used up - ${chunk.length} lines left in English`);
      return new Map();
    }
    if (chunk.length <= MIN_SPLIT) {
      log(`  ! ${label}: ${chunk.length} lines could not be translated - left in English`);
      return new Map();
    }
    const mid = Math.ceil(chunk.length / 2);
    const a = chunk.slice(0, mid);
    const b = chunk.slice(mid);
    log(`  > ${label} failed (${e.message.slice(0, 50)}) - splitting ${chunk.length} into ${a.length}+${b.length}`);
    const ra = await bisect(apiKey, a, before, b.slice(0, CONTEXT).concat(after), log, label + '.1', lang, glossary, budget);
    const rb = await bisect(apiKey, b, before.concat(a.slice(-CONTEXT)), after, log, label + '.2', lang, glossary, budget);
    const out = new Map(ra);
    for (const [k, v] of rb) out.set(k, v);
    return out;
  }
}

// A model often hands its answer back wrapped in quotes: "بيلي ذا كيد". The
// quotes are not part of the name, and letting them through is worse than
// untidy: the form goes into the prompt of every chunk that mentions the
// name, the model echoes the straight " into its JSON string, and a weaker
// model does not always escape it. The string then ends at that quote and
// the rest of the line is lost.
const QUOTE_PAIRS = [
  ['"', '"'], ["'", "'"], ['«', '»'], ['“', '”'],
  ['‘', '’'], ['„', '“'], ['「', '」'],
];

function unquote(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 3; i++) {
    const pair = QUOTE_PAIRS.find(([a, b]) => t.length > a.length + b.length && t.startsWith(a) && t.endsWith(b));
    if (!pair) break;
    t = t.slice(pair[0].length, -pair[1].length).trim();
  }
  // Quotes left around a part of the name are decoration too. A quote sitting
  // inside a word is left alone: in Hebrew and Arabic it is a letter's worth
  // of the spelling, as in ד"ר.
  return t
    .replace(/(^|\s)["'«»“”‘’「」]+/g, '$1')
    .replace(/["«»“”‘’「」]+(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decide how every recurring proper name is written, in one request.
 *
 * Cheap next to the translation itself - one call against eight or more - and
 * it removes a class of mistake rather than correcting it afterwards. A
 * failure here is not fatal: translation continues without a glossary.
 *
 * @returns {Promise<Map<string,string>>} English name -> target-language form
 */
async function buildGlossary(apiKey, lines, lang, log, budget) {
  const names = extractNames(lines);
  if (!names.length) return new Map();

  try {
    const answer = await callGemini(apiKey, glossaryPrompt(names, lang), {
      temperature: 0,
      retries: 2,          // if names are hard to get, the episode still matters more
      log,
      budget,
      lang,
      schema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { en: { type: 'STRING' }, t: { type: 'STRING' } },
          required: ['en', 't'],
        },
      },
    });

    const wanted = new Set(names.map((n) => n.name));
    const out = new Map();
    for (const row of Array.isArray(answer) ? answer : []) {
      const en = String(row?.en || '').trim();
      const t = unquote(row?.t);
      // Only names we actually asked about, and only a real answer: a form
      // identical to the English is meaningful for a Latin-script language
      // and meaningless for one that uses another alphabet.
      if (!wanted.has(en) || !t) continue;
      if (/^skip$/i.test(t)) continue; // the model says it is not a name
      if (t === en && lang.script !== 'latin') continue;
      out.set(en, t);
    }
    log(`names: ${out.size}/${names.length} fixed for the whole episode`);
    if (out.size) log(`names: ${[...out].map(([en, t]) => `${en} = ${t}`).join(' · ')}`);
    return out;
  } catch (e) {
    log(`names: could not be decided (${e.message.slice(0, 60)}) - continuing without`);
    return new Map();
  }
}

async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Translate parsed cues into the target language, keeping every timing untouched.
 * @param {object[]} cues  from srt.parse()
 * @param {string} apiKey  Gemini API key
 * @param {function} [onLog]
 * @param {string} [langCode]  target language; defaults to TARGET_LANG
 * @returns {Promise<object[]>} new cues with translated lines
 */
async function translateCues(cues, apiKey, onLog, refs, speakers, langCode) {
  const log = onLog || (() => {});
  const lang = langs.get(langCode || process.env.TARGET_LANG || langs.DEFAULT_CODE);

  // A real episode is under 2,000 cues and a long film under 3,000. A file
  // far past that is not a subtitle track worth spending a quota on.
  if (cues.length > MAX_CUES) {
    throw new Error(`too many lines (${cues.length}, the limit is ${MAX_CUES})`);
  }

  // Only cues with actual words go to the model. A cue whose English is empty
  // but whose reference track has text still counts - that is exactly the
  // foreign-dialogue case the English track skipped.
  const items = cues.map((c, i) => {
    const own = splitSdh(cueToSource(c), { stripSound: STRIP_SOUND });
    const ref = (refs && refs[i]) || '';
    return {
      n: i + 1,
      text: own.text,
      speaker: own.speaker || (speakers && speakers[i]) || '',
      ref,
      // A cue that was only a sound description has nothing left to show.
      drop: own.soundOnly && !ref,
    };
  });
  const dropped = items.filter((it) => it.drop).length;
  if (dropped) log(`${dropped} sound-only cue(s) removed`);
  const verbal = items.filter(
    (it) => !it.drop && ((it.text && !isNonVerbal(it.text)) || (it.ref && !isNonVerbal(it.ref)))
  );
  const named = verbal.filter((it) => it.speaker).length;
  if (named) log(`speaker names on ${named}/${verbal.length} lines`);
  const withRefCount = verbal.filter((it) => it.ref).length;
  if (withRefCount) log(`reference track covers ${withRefCount}/${verbal.length} lines`);

  // A ceiling on Gemini requests for this one episode, retries and splits
  // included. A normal episode uses a fraction of it; a file built to trip
  // the content filter on every line runs into it instead of the owner's
  // daily quota.
  const nChunks = Math.ceil(verbal.length / CHUNK);
  const budget = { left: REQ_BASE + nChunks * REQ_PER_CHUNK };

  // Names are settled before any chunk is sent, so all of them agree.
  const glossary = NAMES_PASS
    ? await buildGlossary(apiKey, verbal.map((it) => it.text), lang, log, budget)
    : new Map();

  const chunks = [];
  for (let i = 0; i < verbal.length; i += CHUNK) chunks.push(verbal.slice(i, i + CHUNK));
  log(`translating ${verbal.length} lines into ${lang.name} in ${chunks.length} chunk(s) with ${MODEL}`);

  const tasks = chunks.map((chunk, ci) => async () => {
    const startIdx = ci * CHUNK;
    const before = verbal.slice(Math.max(0, startIdx - CONTEXT), startIdx);
    const after = verbal.slice(startIdx + chunk.length, startIdx + chunk.length + CONTEXT);
    log(`  → chunk ${ci + 1}/${chunks.length} (lines ${chunk[0].n}–${chunk[chunk.length - 1].n})`);
    return bisect(apiKey, chunk, before, after, log, 'chunk ' + (ci + 1), lang, glossary, budget);
  });

  const maps = await pool(tasks, CONCURRENCY);
  const he = new Map();
  for (const m of maps) for (const [k, v] of m) he.set(k, v);

  const dropSet = new Set(items.filter((it) => it.drop).map((it) => it.n));
  let translated = 0;
  const result = cues.map((c, i) => {
    const n = i + 1;
    if (dropSet.has(n)) return { ...c, lines: c.lines.slice(), drop: true };
    const t = he.get(n);
    if (!t) return { ...c, lines: c.lines.slice() }; // non-verbal or failed → keep source
    translated++;
    return { ...c, lines: wrap(t, lang.maxLine).map((l) => markDirection(l, lang)) };
  });

  log(`done: ${translated}/${verbal.length} lines translated`);
  if (verbal.length && translated / verbal.length < 0.5) {
    throw new Error(`translation mostly failed (${translated}/${verbal.length})`);
  }
  return result;
}

module.exports = { translateCues, systemPrompt, buildGlossary, unquote, looksTruncated, MODEL, MAX_CUES };
