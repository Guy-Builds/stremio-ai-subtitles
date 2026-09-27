'use strict';

// ---------- SRT / VTT parsing and serialization ----------

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function tcToMs(tc) {
  // supports 00:01:02,345 and 00:01:02.345 and 01:02.345
  const m = tc.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

function msToTc(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = Math.floor(ms % 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(min)}:${p(s)},${p(f, 3)}`;
}

// A subtitle file for a feature film is well under 200 KB. Anything far past
// that is not a subtitle file, and parsing it only burns CPU we do not have.
const MAX_INPUT = parseInt(process.env.MAX_SUBTITLE_BYTES || '2000000', 10);

/**
 * Parse an SRT or WebVTT string into cues.
 * @returns {{index:number,start:number,end:number,lines:string[]}[]}
 */
function parse(text) {
  const src = String(text);
  if (src.length > MAX_INPUT) {
    throw new Error(`subtitle file too large (${src.length} bytes)`);
  }
  let t = stripBom(src).replace(/\r\n?/g, '\n');
  // Drop a WEBVTT header if present. Anchored at the start of the string and
  // bounded to the first blank line, so it cannot backtrack across the file.
  t = t.replace(/^WEBVTT[^\n]*\n(?:[^\n]+\n)*/, '');

  const blocks = t.split(/\n{2,}/);
  const cues = [];
  let n = 0;

  for (const block of blocks) {
    const raw = block.split('\n').filter((l) => l.trim() !== '');
    if (!raw.length) continue;
    // WebVTT metadata blocks carry no dialogue. Recognising them here, in the
    // block loop, keeps parsing linear; the regex this replaced rescanned the
    // whole file once per line and turned 1 MB of input into 45 seconds of CPU.
    if (/^(NOTE|STYLE|REGION)\b/.test(raw[0])) continue;

    let i = 0;
    // optional numeric counter line
    if (/^\d+$/.test(raw[0].trim()) && raw.length > 1 && raw[1].includes('-->')) i = 1;
    if (!raw[i] || !raw[i].includes('-->')) continue;

    const [a, bRest] = raw[i].split('-->');
    const b = bRest.trim().split(/\s+/)[0]; // drop VTT cue settings
    const start = tcToMs(a);
    const end = tcToMs(b);
    if (start === null || end === null) continue;

    const lines = raw.slice(i + 1);
    if (!lines.length) continue;

    cues.push({ index: ++n, start, end, lines });
  }
  return cues;
}

function serialize(cues) {
  return (
    cues
      .filter((c) => !c.drop && c.lines && c.lines.join('').trim() !== '')
      .map(
        (c, i) =>
          `${i + 1}\n${msToTc(c.start)} --> ${msToTc(c.end)}\n${c.lines.join('\n')}`
      )
      .join('\n\n') + '\n'
  );
}

// ---------- text helpers ----------

// Text that carries no translatable dialogue (music notes, dashes, etc.)
function isNonVerbal(s) {
  const bare = s.replace(/[♪♫#*\-–—_.…\s]/g, '');
  return bare === '';
}

// Flatten a cue's lines to a single source string for translation.
function cueToSource(cue) {
  return cue.lines
    .join(' ')
    .replace(/<[^>]+>/g, '')      // strip html-ish tags
    .replace(/\{\\[^}]*\}/g, '')  // strip ASS override tags
    .replace(/\s+/g, ' ')
    .trim();
}

// Re-wrap translated output to at most 2 lines of ~maxLen chars.
function wrap(text, maxLen = 42) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return [t];

  // keep dialogue dashes on their own lines
  if (/^-\s?/.test(t) && t.indexOf(' -', 1) > 0) {
    const cut = t.indexOf(' -', 1);
    return [t.slice(0, cut).trim(), t.slice(cut + 1).trim()];
  }

  const words = t.split(' ');
  let best = null;
  let acc = 0;
  for (let i = 0; i < words.length - 1; i++) {
    acc += words[i].length + (i ? 1 : 0);
    const diff = Math.abs(acc - (t.length - acc));
    if (best === null || diff < best.diff) best = { i, diff, acc };
  }
  if (!best) return [t];
  const first = words.slice(0, best.i + 1).join(' ');
  const second = words.slice(best.i + 1).join(' ');
  return [first, second];
}


// ---------- SDH: speaker labels and sound descriptions ----------

// Subtitles for the deaf and hard of hearing carry two extras a hearing
// viewer does not want on screen, but which are gold for a translator:
//   [MARIA] or MARIA:   - who is speaking
//   [door creaks]        - what can be heard
// Speaker labels are conventionally ALL CAPS; sound descriptions are not.

const SPK_BRACKET = /^\s*(?:[-–—]\s*)?[\[(]([^\])]{1,28})[\])]\s*:?\s*/;
const SPK_COLON = /^\s*(?:[-–—]\s*)?([A-Z][A-Z0-9 .'’#&-]{1,26}):\s+/;
const SOUND_ANY = /[\[(][^\])]*[\])]/g;

// Words that give a sound description away even though it is shouted in caps.
const SOUND_WORDS = new RegExp(
  '\\b(?:CREAK|SLAM|RING|BEEP|HONK|BLAR|REV|CHIRP|BARK|SCREAM|SHOUT|YELL|WHISPER|' +
  'LAUGH|SIGH|GASP|GRUNT|GROAN|SOB|SNIFF|KNOCK|CLICK|CLATTER|CRASH|BANG|THUD|RUSTL|' +
  'SIREN|MUSIC|THEME|APPLAUS|CHEER|CHATTER|FOOTSTEP|ENGINE|GUNSHOT|GUNFIRE|EXPLOSION|' +
  'WIND|RAIN|THUNDER|DOOR|PHONE|ALARM|BELL|HORN|TIRE|BRAKE|WHIR|BUZZ|HISS|STATIC|' +
  'INDISTINCT|MUFFLED|DISTANT|OVERLAPPING|SPEAKING|CONTINUES|PLAYING|FADES|SQUEAL|' +
  'BREATH|PANT|COUGH|SNOR|BEEPING|RUMBL|SPLASH|FOOTSTEPS|CLANG|CHIME)'
);

function looksLikeName(s) {
  const t = String(s).trim();
  if (!t || t.length > 28) return false;
  if (/[a-z]/.test(t)) return false;          // sound cues are not shouted
  if (SOUND_WORDS.test(t)) return false;      // "[ENGINE REVS] Get down!"
  if (/ING$/.test(t)) return false;           // "[SIRENS WAILING]"
  return /[A-Z\u0590-\u05FF]/.test(t);
}

/**
 * Split a cue's text into who is speaking and what they say, and optionally
 * drop the sound descriptions.
 * @returns {{speaker:string, text:string, soundOnly:boolean}}
 */
function splitSdh(raw, { stripSound = true } = {}) {
  let text = String(raw || '').trim();
  let speaker = '';

  let m = SPK_BRACKET.exec(text);
  if (m && looksLikeName(m[1])) {
    speaker = m[1].trim();
    text = text.slice(m[0].length);
    if (/^[-–—]/.test(raw.trim())) text = '- ' + text;
  } else {
    m = SPK_COLON.exec(text);
    if (m && looksLikeName(m[1])) {
      speaker = m[1].trim();
      text = text.slice(m[0].length);
      if (/^[-–—]/.test(raw.trim())) text = '- ' + text;
    }
  }

  if (stripSound) text = text.replace(SOUND_ANY, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  // "(BIRDS CHIRPING)" is shouty too, but nobody is speaking: if the bracket
  // swallowed the whole cue, it was a sound description, not a name.
  const soundOnly = !text || isNonVerbal(text);
  if (soundOnly) speaker = '';

  return { speaker, text, soundOnly };
}

/** How much of a track carries speaker labels - used to spot an SDH file. */
function sdhScore(cues) {
  if (!cues || !cues.length) return 0;
  let n = 0;
  for (const c of cues) if (splitSdh(cueToSource(c), { stripSound: false }).speaker) n++;
  return n / cues.length;
}

// ---------- aligning a second language against the English track ----------

/**
 * Match a reference subtitle track onto the cues we are translating, by time.
 *
 * Two tracks for the same episode never share cue boundaries, so each English
 * cue collects the text of every reference cue its window overlaps.
 *
 * @returns {{ref: string[], orphans: object[]}}
 *   ref     - one string per input cue ('' when the reference has nothing)
 *   orphans - reference cues that overlap no cue at all. These are usually
 *             dialogue the English track left untranslated on purpose,
 *             because the picture carries burned-in subtitles for it.
 */
function alignByTime(cues, refCues, minOverlapMs = 200) {
  const ref = new Array(cues.length).fill('');
  const used = new Set();
  if (!Array.isArray(refCues) || !refCues.length) return { ref, orphans: [] };

  const sorted = refCues.slice().sort((a, b) => a.start - b.start);
  let j = 0;

  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    while (j < sorted.length && sorted[j].end < c.start) j++;
    const parts = [];
    for (let k = j; k < sorted.length && sorted[k].start <= c.end; k++) {
      const overlap = Math.min(c.end, sorted[k].end) - Math.max(c.start, sorted[k].start);
      if (overlap >= Math.min(minOverlapMs, (c.end - c.start) / 2)) {
        parts.push(cueToSource(sorted[k]));
        used.add(k);
      }
    }
    ref[i] = parts.join(' ').trim();
  }

  const orphans = sorted.filter((_, k) => !used.has(k) && !isNonVerbal(cueToSource(sorted[k])));
  return { ref, orphans };
}


/**
 * Fold the reference lines that the English track never covered back into the
 * cue list, in time order. Those are the moments where characters speak a
 * language the English subtitles deliberately left alone, because the picture
 * carried burned-in subtitles for them.
 *
 * The inserted cues carry no English text at all - only the reference - which
 * is the signal to translate them from the reference instead.
 */
function mergeOrphans(cues, refs, orphans) {
  const rows = cues.map((c, i) => ({ cue: c, ref: (refs && refs[i]) || '' }));
  for (const o of orphans || []) {
    rows.push({
      cue: { index: 0, start: o.start, end: o.end, lines: [''], fromRef: true },
      ref: cueToSource(o),
    });
  }
  rows.sort((a, b) => a.cue.start - b.cue.start || a.cue.end - b.cue.end);
  return {
    cues: rows.map((r, i) => ({ ...r.cue, index: i + 1 })),
    refs: rows.map((r) => r.ref),
  };
}

// ---------- bidi ----------

const RLE = '‫'; // start an explicit right-to-left run
const PDF = '‬'; // end it

// Subtitle files carry no direction information, so a player is free to lay a
// line out left-to-right. When it does, a trailing "." or "?" is a neutral
// character at the end of an LTR paragraph and gets pushed to the wrong side -
// it shows up at the start of the Hebrew sentence. Wrapping the line in an
// explicit RTL run settles the direction regardless of what the player assumes.
const BIDI_MARKS = /[‪-‮⁦-⁩]/g;

/**
 * Settle a line's direction explicitly.
 *
 * Only a right-to-left language needs this, and only on a line that actually
 * contains that language's letters - wrapping a line of pure Latin would be
 * wrong. `lang` is a row from languages.js.
 */
function markDirection(line, lang) {
  if (!line || !lang || !lang.rtl) return line;
  const langs = require('./languages');
  const own = new RegExp(`[${langs.scriptRangeOf(lang.code)}]`);
  if (!own.test(line)) return line;
  return RLE + line.replace(BIDI_MARKS, '') + PDF;
}

// Hebrew was the first target and the tests are written against it; this is
// the same call with Hebrew already filled in.
function rtl(line) {
  if (!line || !/[\u0590-\u05FF]/.test(line)) return line;
  return RLE + line.replace(BIDI_MARKS, '') + PDF;
}

// Arabic, Persian and Arabic presentation forms. Gemini sometimes slips a
// single Arabic word into otherwise fine Hebrew; catching it lets us re-ask.
const FOREIGN = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

function hasForeignScript(s) {
  return FOREIGN.test(String(s || ''));
}

/**
 * The same check for any target language: letters from a non-Latin script
 * that is not this language's own. Latin is always allowed, because names and
 * brands keep their spelling everywhere.
 */
function hasForeignScriptFor(s, code) {
  return require('./languages').foreignScriptRe(code).test(String(s || ''));
}

module.exports = {
  parse, serialize, tcToMs, msToTc, isNonVerbal, cueToSource, wrap,
  rtl, markDirection, hasForeignScript, hasForeignScriptFor,
  alignByTime, mergeOrphans, splitSdh, sdhScore, RLE, PDF,
};
