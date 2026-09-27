'use strict';

// Wraps fetch for calls to the Gemini API: retries, model fallback, and the
// workarounds for settings some models reject. Used by the server, the CLI
// and the language test kit, so all three behave the same way.
//
// Model fallback. The default model is Flash, which translates better than
// Flash-Lite but has a smaller free quota. When Flash's quota runs out the
// call moves to Flash-Lite at once rather than waiting and retrying:
//
//   - a per-minute limit (429 with a retry delay) is worth waiting for;
//   - a per-day limit, or a model with no free quota at all, is not. Waiting
//     two and a half minutes per chunk for a quota that resets tomorrow would
//     turn a one-minute episode into a twenty-minute one.
//
// A model found out of daily quota is skipped for the next hour, so the rest
// of the episode does not rediscover it on every chunk.
//
// Overload (503 and friends) is handled the same way, on a shorter clock.
// When another model is there to take the call, a model that is overloaded
// twice in a row is set aside for five minutes: waiting out a full retry
// ladder on it cost about a minute per chunk, on every chunk. When there is
// no other model, the full ladder still applies - waiting is all that is left.

const RETRYABLE = [408, 429, 500, 502, 503, 504];
const CATS = [
  'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
];
const LEVELS = ['OFF', 'BLOCK_NONE', 'BLOCK_ONLY_HIGH', null];
const RESTING_MS = 60 * 60 * 1000;
const OVERLOAD = [500, 502, 503, 504];
const OVERLOAD_REST_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function install(opts = {}) {
  const ORIG = opts.fetch || global.fetch;
  const log = opts.log || ((m) => console.log(m));

  // GEMINI_FALLBACK unset → Flash-Lite. Set to an empty string → no fallback.
  const fbEnv = process.env.GEMINI_FALLBACK;
  const FB = (fbEnv === undefined ? 'gemini-flash-lite-latest' : fbEnv)
    .split(',').map((s) => s.trim()).filter(Boolean);
  const TRIES = parseInt(process.env.GEMINI_RETRIES || '6', 10);
  const OVERLOAD_TRIES = Math.max(1, parseInt(process.env.GEMINI_OVERLOAD_TRIES || '2', 10));

  let lvl = 0;
  let noThink = process.env.GEMINI_NOTHINK !== '0';
  const resting = new Map(); // model -> time it may be tried again

  const modelOf = (url) => (/models\/([^:]+):/.exec(url) || [])[1] || '';
  const withModel = (url, m) => url.replace(/models\/[^:]+:/, `models/${m}:`);

  function tweak(body) {
    try {
      const o = JSON.parse(body);
      if (LEVELS[lvl]) o.safetySettings = CATS.map((c) => ({ category: c, threshold: LEVELS[lvl] }));
      else delete o.safetySettings;
      if (noThink) {
        o.generationConfig = o.generationConfig || {};
        o.generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }
      return JSON.stringify(o);
    } catch {
      return body;
    }
  }

  const textOf = (j) =>
    ((j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts) || []).map((p) => p.text || '').join('');

  // A quota that will not come back by waiting a minute.
  const outForTheDay = (status, txt) =>
    status === 429 && (/PerDay/i.test(txt) || /"quotaValue"\s*:\s*"0"/.test(txt));

  const wrapped = async function (url, opts2) {
    const u = String(url);
    let host = '';
    try { host = new URL(u).hostname; } catch { /* not a URL we handle */ }
    if (host !== 'generativelanguage.googleapis.com') return ORIG(url, opts2);

    const now = Date.now();
    const first = modelOf(u);
    const all = [first, ...FB.filter((m) => m && m !== first)];
    // Skip models known to be out of quota, unless that would leave nothing.
    let order = all.filter((m) => !(resting.get(m) > now));
    if (!order.length) order = all;

    let last = null;
    let lastModel = first;
    for (let t = 0; t < order.length; t++) {
      const target = withModel(u, order[t]);
      for (let a = 0; a < TRIES; a++) {
        let sent = opts2 || {};
        if (sent.body) sent = Object.assign({}, sent, { body: tweak(sent.body) });
        const res = await ORIG(target, sent);

        if (res.ok) {
          const json = await res.clone().json().catch(() => null);
          if (json) {
            for (const c of json.candidates || []) {
              if (c.content && Array.isArray(c.content.parts)) {
                c.content.parts = c.content.parts.filter((p) => !p.thought);
              }
            }
            if (!textOf(json)) {
              const c = (json.candidates || [])[0] || {};
              log(`   empty answer (finish=${c.finishReason || '-'} block=${(json.promptFeedback || {}).blockReason || '-'} safety=${LEVELS[lvl]})`);
            }
            return new Response(JSON.stringify(json), {
              status: 200, headers: { 'content-type': 'application/json' },
            });
          }
          return res;
        }

        const txt = await res.clone().text().catch(() => '');
        lastModel = order[t];

        if (outForTheDay(res.status, txt)) {
          resting.set(order[t], Date.now() + RESTING_MS);
          last = res;
          if (t < order.length - 1) {
            log(`   ${order[t]}: daily quota used up - switching to ${order[t + 1]} for the next hour`);
          } else {
            log(`   ${order[t]}: daily quota used up, and no other model left to try`);
          }
          break; // straight to the next model, no waiting
        }

        // A bad or revoked key is not a settings problem. Changing the shared
        // settings over it would change them for every other user too.
        if (/API_KEY_INVALID|API key not valid|API_KEY_/i.test(txt) || res.status === 401 || res.status === 403) {
          last = res;
          break;
        }

        if (res.status === 400 && noThink && /think/i.test(txt)) {
          log('   model rejects thinkingConfig - retrying without it');
          noThink = false; continue;
        }
        if (res.status === 400 && lvl < LEVELS.length - 1) {
          lvl++;
          log(`   safety setting rejected - falling back to ${LEVELS[lvl] || 'model default'}`);
          continue;
        }
        if (res.status === 400 && noThink) {
          log('   400 - retrying without thinkingConfig');
          noThink = false; continue;
        }

        last = res;
        if (RETRYABLE.indexOf(res.status) < 0) break;

        // Overloaded, and another model can take it: stop queueing for this one.
        if (t < order.length - 1 && OVERLOAD.indexOf(res.status) >= 0 && a + 1 >= OVERLOAD_TRIES) {
          resting.set(order[t], Date.now() + OVERLOAD_REST_MS);
          log(`   ${order[t]} overloaded (${res.status}) - using ${order[t + 1]} for the next 5 minutes`);
          break;
        }
        const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(txt);
        const hinted = m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
        const wait = Math.max(hinted, Math.min(60000, 2000 * 2 ** a + Math.random() * 1000));
        if (a < TRIES - 1) {
          log(`   gemini ${res.status} - waiting ${Math.round(wait / 1000)}s (try ${a + 1}/${TRIES})`);
          await sleep(opts.fastRetries ? 1 : wait);
        } else {
          log(`   gemini ${res.status} - out of retries for ${order[t]}`);
        }
      }
      if (t < order.length - 1 && !(resting.get(order[t]) > Date.now())) {
        log(`   switching to fallback model ${order[t + 1]}`);
      }
    }
    // Say which model the final failure came from: the caller only knows the
    // one it asked for, and would otherwise report Flash for a Flash-Lite error.
    if (!last) return last;
    const body = await last.clone().text().catch(() => '');
    return new Response(body, { status: last.status, headers: { 'x-gemini-model': lastModel } });
  };

  global.fetch = wrapped;
  return { resting, fallbacks: FB };
}

module.exports = { install };
