'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const srt = require('./srt');
const secret = require('./secret');
const { translateCues, MODEL } = require('./translate');
const { fetchAll, pickLang, downloadSubtitle, UPSTREAMS } = require('./sources');
const langs = require('./languages');

const PORT = parseInt(process.env.PORT || '7788', 10);
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'cache');
const MAX_SOURCES = parseInt(process.env.MAX_SOURCES || '2', 10);
const ENV_KEY = process.env.GEMINI_API_KEY || '';

// Optional: a second subtitle track in a language that marks gender and number,
// shown to the model alongside the English as evidence. Empty = off.
const REF_LANG = (process.env.REFERENCE_LANG || '').toLowerCase().trim();
// Fold in dialogue the English track skipped entirely (characters speaking
// another language). Only possible when a reference track is configured.
const FILL_GAPS = process.env.FILL_FOREIGN_GAPS !== '0';
// The language this deployment translates into by default. A public
// deployment lets each person choose their own instead.
const TARGET = langs.normalize(process.env.TARGET_LANG || langs.DEFAULT_CODE);
const KNOWN_LANG = new Set(langs.list().map((l) => l.code));

fs.mkdirSync(CACHE_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- job runner

const jobs = new Map(); // cacheKey -> Promise<string>

function cacheKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}
const cachePath = (key) => path.join(CACHE_DIR, `${key}.srt`);

// Every .srt link this server hands out is signed. Without that, /sub is an
// open door: anyone could name any address as the source, have the server
// fetch it and translate it on the operator's Gemini quota, and plant the
// result under a cache name a real viewer would later ask for.
const SIGN_KEY =
  (process.env.SECRET || '').length >= 16
    ? crypto.createHash('sha256').update('url-signing|' + process.env.SECRET).digest()
    : crypto.randomBytes(32); // no SECRET: links last as long as this process

// The target language is part of the identity of a translation: the same
// English source produces a different file for every language, so it belongs
// in both the cache name and the signature.
const idOf = (src, ref, lang) => `${src}|${ref || ''}|${lang}`;

const sign = (src, ref, lang) =>
  crypto.createHmac('sha256', SIGN_KEY).update(idOf(src, ref, lang)).digest('base64url').slice(0, 22);

function signOk(src, ref, lang, sig) {
  const want = Buffer.from(sign(src, ref, lang));
  const got = Buffer.from(String(sig || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// One instance on the free plan has 512 MB and one CPU. A translation holds a
// whole parsed episode in memory and can sit in backoff for minutes, so the
// number that may run at once is capped rather than left to the caller.
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '3', 10);

function readCache(key) {
  try {
    const p = cachePath(key);
    const body = fs.readFileSync(p, 'utf8');
    return body.trim() ? body : null;
  } catch {
    return null;
  }
}

// Try the other English candidates until one turns out to be an SDH track
// (the kind that names its speakers). Subtitle files are tiny, so a couple of
// extra downloads cost nothing next to what we learn from them.
async function findSpeakers(cues, altUrls, log) {
  for (const u of (altUrls || []).slice(0, 3)) {
    try {
      const alt = srt.parse(await downloadSubtitle(u));
      const score = srt.sdhScore(alt);
      if (score < 0.02) continue;
      const { ref } = srt.alignByTime(cues, alt);
      const speakers = ref.map((t) => srt.splitSdh(t, { stripSound: false }).speaker);
      const named = speakers.filter(Boolean).length;
      log(`SDH track found (${Math.round(score * 100)}% labelled) - ${named} lines attributed`);
      return speakers;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

async function buildTranslation(key, sourceUrl, apiKey, refUrl, altUrls, lang) {
  const cached = readCache(key);
  if (cached) return cached;
  if (jobs.has(key)) return jobs.get(key);
  if (jobs.size >= MAX_JOBS) throw new Error('busy - too many translations in flight');

  const job = (async () => {
    log(`[${key}] downloading ${sourceUrl.slice(0, 90)}`);
    const text = await downloadSubtitle(sourceUrl);
    const cues = srt.parse(text);
    if (!cues.length) throw new Error('could not parse the source subtitle file');
    log(`[${key}] parsed ${cues.length} cues`);

    // Optional second language, used as evidence about meaning - and, where
    // the English track skipped a line entirely, as the source for it.
    let refs;
    let work = cues;
    if (refUrl) {
      try {
        const refCues = srt.parse(await downloadSubtitle(refUrl));
        const aligned = srt.alignByTime(cues, refCues);
        refs = aligned.ref;
        log(`[${key}] ${REF_LANG} reference: ${refCues.length} cues, ${aligned.orphans.length} with no English counterpart`);
        if (FILL_GAPS && aligned.orphans.length) {
          const merged = srt.mergeOrphans(cues, aligned.ref, aligned.orphans);
          work = merged.cues;
          refs = merged.refs;
          log(`[${key}] filled in ${aligned.orphans.length} line(s) the English track skipped`);
        }
      } catch (e) {
        log(`[${key}] reference track unavailable (${e.message}) - continuing without it`);
      }
    }

    // Speaker names: from this track if it is already SDH, otherwise from a
    // sibling English track that is.
    let speakers;
    const own = srt.sdhScore(work);
    if (own >= 0.02) {
      log(`[${key}] source already names speakers (${Math.round(own * 100)}%)`);
    } else if (altUrls && altUrls.length) {
      speakers = await findSpeakers(work, altUrls, (m) => log(`[${key}] ${m}`));
    }

    const translated = await translateCues(
      work, apiKey, (m) => log(`[${key}] ${m}`), refs, speakers, lang
    );

    // Every cue keeps the timing it arrived with — English or reference.
    for (let i = 0; i < work.length; i++) {
      if (translated[i].start !== work[i].start || translated[i].end !== work[i].end) {
        throw new Error('internal: timing drift detected');
      }
    }

    const out = '﻿' + srt.serialize(translated);
    fs.writeFileSync(cachePath(key), out, 'utf8');
    log(`[${key}] cached ${work.length} cues`);
    return out;
  })();

  jobs.set(key, job);
  job.catch((e) => log(`[${key}] failed: ${e.message}`)).finally(() => {
    setTimeout(() => jobs.delete(key), 2000);
  });
  return job;
}

// ---------------------------------------------------------------- addon meta

function configurePage(base) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Subtitles — setup</title>
<style>
:root{--bg:#fbfaf8;--fg:#23201d;--muted:#6b645d;--line:#e5e0d8;--accent:#7c4a2d;--card:#fff;--code:#f3efe9;--warn:#fdf6e7;--warnline:#e0c98a}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1b1917;--fg:#ece7e1;--muted:#a49c93;--line:#35302b;--accent:#d99a6e;--card:#232020;--code:#2a2523;--warn:#2e2717;--warnline:#6b5a2e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:"Segoe UI",system-ui,-apple-system,Arial,sans-serif;line-height:1.7}
.wrap{max-width:660px;margin:0 auto;padding:44px 16px 72px}
h1{font-size:1.8rem;margin:0 0 .25em}
.sub{color:var(--muted);margin:0 0 2em}
h2{font-size:1.1rem;margin:2em 0 .5em}
label{display:block;font-weight:600;margin:0 0 .4em}
input,select{width:100%;padding:12px 14px;font-size:1rem;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
select{margin-bottom:.5em}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{margin-top:14px;padding:12px 22px;font-size:1rem;font-weight:600;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:1.2em 0}
.warn{background:var(--warn);border:1px solid var(--warnline);border-radius:8px;padding:14px 18px;margin:1.2em 0}
code,.out{background:var(--code);border-radius:6px;font-family:Consolas,monospace;direction:ltr;display:block;padding:12px 14px;word-break:break-all;font-size:.9rem;text-align:left}
.err{color:#b3261e;margin-top:.8em}
@media(prefers-color-scheme:dark){.err{color:#f2b8b5}}
ol{padding-inline-start:1.3em}li{margin:.4em 0}
a{color:var(--accent)}
.hide{display:none}
.muted{color:var(--muted);font-size:.93rem}
</style></head><body><div class="wrap">

<h1>AI Subtitles for Stremio</h1>
<p class="sub">Translates English subtitles into your language, on the original timings. Everyone uses their own free API key.</p>

<h2>1. Your language</h2>
<label for="lang">Translate subtitles into</label>
<select id="lang">${langs.list()
  .map((l) => `<option value="${l.code}"${l.code === TARGET ? ' selected' : ''}>${escapeHtml(l.native)} — ${escapeHtml(l.name)}</option>`)
  .join('')}</select>

<h2>2. Gemini key</h2>
<p>Create a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> and paste it here. It is encrypted into your install link and never shown again.</p>
<label for="k">Your API key</label>
<input id="k" type="password" autocomplete="off" spellcheck="false" placeholder="AQ... or AIza...">
<button id="go">Create my install link</button>
<div id="err" class="err"></div>

<div id="result" class="hide">
  <h2>3. Your install link</h2>
  <div class="out" id="url"></div>
  <button id="copy">Copy</button>
  <div class="card">
    <strong>How to install</strong>
    <ol>
      <li>Open <strong>Stremio</strong> → <strong>Addons</strong></li>
      <li>Paste the link into the search box at the top</li>
      <li>Press <strong>Install</strong></li>
    </ol>
    <p class="muted">Open an episode, wait about a minute the first time, and pick your language in the subtitle menu.</p>
  </div>
  <div class="warn">
    <strong>Treat this link like a password.</strong>
    Your key is encrypted inside it and cannot be read out of it, but anyone holding the link
    can translate against your quota. If it leaks, delete the key in AI Studio and make a new link here.
  </div>
</div>

<h2>Want full isolation?</h2>
<p>
This server decrypts your key at request time in order to call Google, which means you are
trusting whoever runs it. Anyone who would rather their key never passed through someone
else's server can deploy their own copy free in about two minutes; the key then lives in
that server's own settings and appears in no link at all.
</p>

<script>
var k=document.getElementById('k'),go=document.getElementById('go'),err=document.getElementById('err'),
    res=document.getElementById('result'),out=document.getElementById('url'),copy=document.getElementById('copy'),
    langSel=document.getElementById('lang');
go.onclick=function(){
  var key=k.value.trim(); err.textContent='';
  if(key.length<20){err.textContent='That key looks too short.';return;}
  go.disabled=true; go.textContent='Checking with Google...';
  fetch('/api/url',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:key,lang:langSel.value})})
   .then(function(r){return r.json()})
   .then(function(d){
     go.disabled=false; go.textContent='Create my install link';
     if(d.error){err.textContent=d.error;return;}
     out.textContent=d.url; res.className=''; k.value='';
     res.scrollIntoView({behavior:'smooth',block:'start'});
   })
   .catch(function(){go.disabled=false;go.textContent='Create my install link';err.textContent='Something went wrong. Try again.';});
};
k.addEventListener('keydown',function(e){if(e.key==='Enter')go.click();});
copy.onclick=function(){
  navigator.clipboard.writeText(out.textContent).then(function(){
    copy.textContent='Copied'; setTimeout(function(){copy.textContent='Copy'},1600);
  });
};
</script>
</div></body></html>`;
}

function manifest(configured, lang) {
  const L = langs.get(lang || TARGET);
  return {
    // One id per language, so a viewer can install several side by side and
    // the player does not treat them as the same addon. Hebrew is the
    // exception: it keeps the id it was published under, so the people who
    // already had this installed are not asked to install it again.
    id: L.code === 'heb' ? 'community.hebrew.ai.subtitles' : `community.ai.subtitles.${L.code}`,
    version: '2.2.7',
    name: `${L.native} (AI)`,
    description:
      `Translates English subtitles into ${L.name} with a language model. ` +
      'It reads the dialogue as one continuous passage rather than line by line, ' +
      'and returns it on the original timings.',
    logo: 'https://dl.strem.io/addon-logo.png',
    resources: ['subtitles'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['tt', 'kitsu'],
    behaviorHints: {
      // Only a public deployment (one with a SECRET and no key of its own)
      // needs the configure step; a private one already has its key.
      configurable: secret.enabled() && !ENV_KEY,
      configurationRequired: secret.enabled() && !ENV_KEY && !configured,
    },
  };
}

// ---------------------------------------------------------------- http server

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    ...headers,
  });
  res.end(body);
}
const sendJson = (res, obj, cache = 'public, max-age=300') =>
  send(res, 200, JSON.stringify(obj), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
  });

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Both of these headers are set by whatever sits in front of us, and a caller
// can send them too. Anything that is not host-shaped is discarded rather than
// echoed back into a URL or a page.
function publicBase(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  const host = /^[A-Za-z0-9._-]+(:\d{1,5})?$/.test(raw) ? raw : 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    ? 'https'
    : 'http';
  return `${proto}://${host}`;
}

// Config can ride in the URL so one deployment can serve several people, each
// with their own Gemini key. Preferred form is an encrypted token (see
// secret.js); plain base64url JSON stays supported for local use where there
// is no SECRET and nothing to hide from.
function decodeConfig(segment) {
  const sealed = secret.open(segment);
  if (sealed) return sealed;
  if (secret.enabled()) return null; // on a public server, only sealed tokens count
  try {
    const cfg = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof cfg === 'object' && cfg ? cfg : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- rate limit

// A stolen install URL should be worth very little. Each config gets its own
// daily budget of episodes; the cache means re-watching costs nothing.
const RATE_PER_DAY = parseInt(process.env.RATE_LIMIT_PER_DAY || '40', 10);
// A ceiling for the whole deployment, so no combination of callers can empty
// the operator's Gemini quota in an afternoon.
const GLOBAL_PER_DAY = parseInt(process.env.RATE_LIMIT_TOTAL || String(RATE_PER_DAY * 5), 10);
const buckets = new Map(); // caller id -> { day, episodes:Set }
let global_ = { day: -1, episodes: new Set() };

// Who is asking. A sealed token identifies a person; without one the best we
// have is the address. The earlier version only counted token holders, which
// meant a deployment with its own key counted nobody at all.
function callerId(req, token) {
  if (token) return 'k:' + secret.fingerprint(token);
  // The last X-Forwarded-For entry is the one the hosting proxy added. The
  // earlier ones are whatever the caller chose to send, so trusting the first
  // let anyone pose as a new visitor on every request.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return 'ip:' + (fwd || (req.socket && req.socket.remoteAddress) || 'unknown');
}

function withinRate(id, episodeKey) {
  if (RATE_PER_DAY <= 0) return true;
  const day = Math.floor(Date.now() / 86400000);

  if (global_.day !== day) {
    global_ = { day, episodes: new Set() };
    buckets.clear(); // yesterday's callers are not worth remembering
  }

  let b = buckets.get(id);
  if (!b || b.day !== day) {
    b = { day, episodes: new Set() };
    buckets.set(id, b);
  }
  if (b.episodes.has(episodeKey)) return true; // already counted today

  if (b.episodes.size >= RATE_PER_DAY) return false;
  if (global_.episodes.size >= GLOBAL_PER_DAY && !global_.episodes.has(episodeKey)) return false;

  b.episodes.add(episodeKey);
  global_.episodes.add(episodeKey);
  return true;
}

async function handleSubtitles(req, res, { type, id, extra, apiKey, token, lang }) {
  if (!apiKey) return sendJson(res, { subtitles: [] }, 'no-store');

  const all = await fetchAll(type, id, extra);
  const english = pickLang(all, ['eng', 'en']);
  const sources = english.slice(0, MAX_SOURCES);
  const refUrl = REF_LANG
    ? (pickLang(all, langs.aliasesOf(REF_LANG))[0] || {}).url
    : undefined;
  log(`subtitles ${type}/${id} → ${lang} → ${sources.length} english source(s)${refUrl ? `, ${REF_LANG} reference found` : ''}`);
  if (!sources.length) return sendJson(res, { subtitles: [] }, 'no-store');

  const base = publicBase(req);
  const who = callerId(req, token);
  const subtitles = [];
  for (const [i, s] of sources.entries()) {
    const key = cacheKey(idOf(s.url, refUrl, lang));
    if (!readCache(key) && !withinRate(who, key)) {
      log(`rate limit reached for ${who} - skipping`);
      break;
    }
    // Warm the cache now so the file is usually ready the moment it is picked.
    buildTranslation(key, s.url, apiKey, refUrl, english.filter((o) => o.url !== s.url).map((o) => o.url), lang).catch(() => {});
    // The key itself never travels here: on a public server `token` is the
    // sealed blob, and on a local one the key already lives in the env.
    const carry = token ? `&c=${encodeURIComponent(token)}` : '';
    subtitles.push({
      // Same language code for every candidate. A distinct code such as
      // "heb-2" makes the player list a second, separate entry for the same
      // language; sharing one code keeps them together under one heading, the
      // way an upstream addon offering several English tracks behaves.
      id: `ai-${i + 1}-${key}`,
      url:
        `${base}/sub/${key}.srt?src=${encodeURIComponent(s.url)}` +
        (refUrl ? `&ref=${encodeURIComponent(refUrl)}` : '') +
        `&l=${encodeURIComponent(lang)}&s=${sign(s.url, refUrl, lang)}${carry}`,
      lang,
    });
  }

  sendJson(res, { subtitles }, 'no-store');
}

async function handleSrt(req, res, url) {
  const key = path.basename(url.pathname).replace(/\.srt$/i, '');
  const src = url.searchParams.get('src');
  const ref = url.searchParams.get('ref') || undefined;
  const carried = url.searchParams.get('c');
  const cfg = carried ? decodeConfig(carried) : null;
  const apiKey = (cfg && cfg.key) || ENV_KEY;
  const lang = langs.normalize(url.searchParams.get('l') || (cfg && cfg.lang) || TARGET);

  const headers = {
    'content-type': 'application/x-subrip; charset=utf-8',
    'cache-control': 'public, max-age=86400',
  };

  // Something already translated and vetted is safe to serve as-is.
  const cached = readCache(key);
  if (cached) return send(res, 200, cached, headers);
  if (!src || !apiKey) return send(res, 404, 'not found');

  // Two checks, and both have to pass before anything is fetched.
  //  - the signature proves this server issued the link, so the source cannot
  //    be swapped for an address of the caller's choosing;
  //  - the name must be the one this source hashes to, so nothing can be
  //    stored under a name that belongs to a different episode.
  if (!signOk(src, ref, lang, url.searchParams.get('s'))) return send(res, 404, 'not found');
  if (key !== cacheKey(idOf(src, ref, lang))) return send(res, 404, 'not found');

  const who = callerId(req, carried || null);
  if (!withinRate(who, key)) {
    return send(res, 429, 'daily limit reached', { 'content-type': 'text/plain' });
  }

  try {
    const body = await buildTranslation(key, src, apiKey, ref, undefined, lang);
    send(res, 200, body, headers);
  } catch (e) {
    // The detail goes to the log, not to the caller: distinct messages told an
    // outsider the difference between a closed port and a refused request.
    log('srt error:', e.message);
    send(res, 502, 'translation failed', { 'content-type': 'text/plain' });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  // A pasted address often ends up as ".com//pob/manifest.json". A path that
  // starts with two slashes is read as a host name ("pob"), so the language
  // silently disappeared and the default one was installed instead.
  const url = new URL(String(req.url || '/').replace(/^\/{2,}/, '/'), 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // A leading path segment is either a sealed configuration - someone's own
  // API key and chosen language - or a plain language code, which carries no
  // secret and is therefore safe to accept on any deployment. Installing
  // /spa/manifest.json alongside /heb/manifest.json gives two languages from
  // one server.
  const RESERVED = ['manifest.json', 'subtitles', 'sub', 'health', 'configure', 'api', ''];
  let apiKey = ENV_KEY;
  let token = null;
  let lang = TARGET;
  if (parts.length && !RESERVED.includes(parts[0].toLowerCase())) {
    const seg = parts[0];
    const cfg = decodeConfig(seg);
    if (cfg && cfg.key) {
      apiKey = cfg.key;
      if (cfg.lang) lang = langs.normalize(cfg.lang);
      token = seg;
      parts.shift();
    } else if (KNOWN_LANG.has(langs.normalize(seg))) {
      lang = langs.normalize(seg);
      parts.shift();
    } else {
      // An unreadable first segment is not a route prefix. Consuming it anyway
      // gave every endpoint unlimited aliases.
      return send(res, 404, 'not found');
    }
  }

  try {
    if (!parts.length) {
      const base = publicBase(req);
      // A public deployment has no key of its own - send people to configure.
      if (secret.enabled() && !ENV_KEY) {
        return send(res, 200, configurePage(base), {
          'content-type': 'text/html; charset=utf-8',
        });
      }
      return send(
        res,
        200,
        `<!doctype html><meta charset="utf-8"><title>AI Subtitles</title>
<body style="font-family:system-ui;max-width:640px;margin:3rem auto;padding:0 1rem;line-height:1.6">
<h1>AI Subtitles for Stremio</h1>
<p>The server is running. To install in Stremio, paste this address into the Addons search box:</p>
<p><code style="background:#eee;padding:.5rem;display:block">${escapeHtml(base)}/${langs.get(TARGET).code}/manifest.json</code></p>
<p>Default language: <b>${escapeHtml(langs.get(TARGET).native)}</b> (${escapeHtml(langs.get(TARGET).name)}).
For another language, put its code in the path instead — for example
<code>${escapeHtml(base)}/spa/manifest.json</code> for Spanish. Install several side by side if you like.</p>
<p style="color:#666">Model: <b>${escapeHtml(MODEL)}</b> · English sources: ${UPSTREAMS.length} · API key: ${
          ENV_KEY ? 'set' : 'missing'
        }</p>
<p style="color:#666">Languages available: ${langs.list().map((l) => escapeHtml(l.code)).join(', ')}</p>
</body>`,
        { 'content-type': 'text/html; charset=utf-8' }
      );
    }

    if (parts[0] === 'health') return sendJson(res, { ok: true, model: MODEL, key: !!apiKey, lang });
    if (parts[0] === 'manifest.json') return sendJson(res, manifest(!!token || !!ENV_KEY, lang));

    // Awaited, not just returned: an un-awaited rejection here escapes the
    // catch below and, on current Node, takes the whole process down.
    if (parts[0] === 'sub') return await handleSrt(req, res, url);

    if (parts[0] === 'subtitles') {
      // /subtitles/:type/:id.json  or  /subtitles/:type/:id/:extra.json
      const type = parts[1];
      const rest = parts.slice(2).join('/').replace(/\.json$/i, '');
      const segs = rest.split('/');
      const id = decodeURIComponent(segs[0] || '');
      const extra = segs.length > 1 ? segs.slice(1).join('/') : '';
      if (!type || !id) return sendJson(res, { subtitles: [] }, 'no-store');
      return await handleSubtitles(req, res, { type, id, extra, apiKey, token, lang });
    }

    // Turn a pasted key into a personal install URL. The key is used to build
    // the token and is never written to disk or to the log.
    if (parts[0] === 'api' && parts[1] === 'url' && req.method === 'POST') {
      // A deployment with its own key is not a sign-up service. Leaving this
      // open meant hosting a key-entry form nobody asked for, and a free
      // "is this Google key valid?" oracle running from this server's address.
      if (ENV_KEY) return send(res, 404, 'not found');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) return sendJson(res, { error: 'too large' }, 'no-store');
      }
      let key = '';
      let wanted = TARGET;
      try {
        const parsed = JSON.parse(body);
        key = String(parsed.key || '').trim();
        if (parsed.lang) wanted = langs.normalize(parsed.lang);
      } catch { /* handled below */ }
      if (key.length < 20) return sendJson(res, { error: 'That does not look like an API key.' }, 'no-store');
      if (!secret.enabled()) {
        return sendJson(res, { error: 'This server has no SECRET set, so it cannot issue links.' }, 'no-store');
      }
      // Check it against Google before handing back a link that cannot work.
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10000);
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { 'x-goog-api-key': key },
          signal: ctl.signal,
        }).finally(() => clearTimeout(timer));
        if (!r.ok) return sendJson(res, { error: 'Google rejected that key.' }, 'no-store');
      } catch {
        return sendJson(res, { error: 'Could not reach Google to check the key.' }, 'no-store');
      }
      return sendJson(
        res,
        { url: `${publicBase(req)}/${secret.seal({ key, lang: wanted })}/manifest.json` },
        'no-store'
      );
    }

    if (parts[0] === 'configure') {
      if (ENV_KEY) return send(res, 404, 'not found');
      return send(res, 200, configurePage(publicBase(req)), {
        'content-type': 'text/html; charset=utf-8',
      });
    }

    send(res, 404, 'not found');
  } catch (e) {
    log('error:', e.stack || e.message);
    send(res, 500, 'internal error');
  }
});

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

// A subtitle addon is not worth taking the process down for. Anything that
// slips past a handler is logged and the service keeps answering - otherwise
// one malformed reply from an upstream addon becomes a restart loop.
process.on('unhandledRejection', (e) => log('unhandled rejection:', (e && e.stack) || e));
process.on('uncaughtException', (e) => log('uncaught exception:', (e && e.stack) || e));

module.exports = server;
// Exposed for the tests only.
module.exports._callerId = callerId;

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress();
  if (process.env.QUIET) return;
  console.log('');
  console.log('  AI Subtitles for Stremio');
  console.log('  ------------------------');
  console.log(`  model:      ${MODEL}`);
  console.log(`  language:   ${langs.get(TARGET).name} (${TARGET})`);
  console.log(`  Gemini key: ${ENV_KEY ? 'set' : '*** missing - set GEMINI_API_KEY ***'}`);
  console.log('');
  console.log('  Install in Stremio with this address:');
  console.log(`      from this computer:  http://127.0.0.1:${PORT}/${TARGET}/manifest.json`);
  console.log(`      from a phone or TV:  http://${ip}:${PORT}/${TARGET}/manifest.json`);
  console.log('');
});
