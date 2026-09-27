'use strict';

// Checks for the 2.2.4 hardening. Each one reproduces a way a stranger could
// have frozen the server or spent the owner's quota with a crafted subtitle
// file or request, measured before the fix. No network, no API key.

process.env.NAME_GLOSSARY = '0';
process.env.CONCURRENCY = '1';
process.env.GEMINI_RETRIES = '6';

const assert = require('assert');

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const rnd = () => Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6) || 'abcdef';

function cues(n, text) {
  return Array.from({ length: n }, (_, i) => ({ start: i * 1000, end: i * 1000 + 900, lines: [text(i)] }));
}

async function main() {
  // ---- 1. the names pass stays fast on a file full of distinct names -------
  // Before: 4,000 such lines froze the event loop for 25 s; 2 MB, for hours.
  {
    const { extractNames } = require('../src/names');
    const lines = Array.from({ length: 6000 }, () =>
      `and ${cap(rnd() + 'a')} ${cap(rnd() + 'b')} met ${cap(rnd() + 'c')}.`);
    let t = Date.now();
    extractNames(lines);
    const many = Date.now() - t;
    const long = 'and ' + Array.from({ length: 40000 }, () => cap(rnd() + 'x')).join(' ') + '.';
    t = Date.now();
    extractNames([long]);
    const one = Date.now() - t;
    assert.ok(many < 2000, `6,000 lines of distinct names took ${many} ms`);
    assert.ok(one < 1000, `one 280 KB line took ${one} ms`);
    console.log(`✓ names pass stays fast on a hostile file (${many} ms for 6,000 lines, ${one} ms for one huge line)`);
  }

  const { translateCues, MAX_CUES } = require('../src/translate');
  const realFetch = global.fetch;

  // ---- 2. an absurdly long "episode" is refused before any request ---------
  {
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('must not be called'); };
    await assert.rejects(
      translateCues(cues(MAX_CUES + 1, () => 'Hi there'), 'k', () => {}, null, null, 'heb'),
      /too many lines/
    );
    assert.strictEqual(calls, 0, 'no request may be made for an oversized file');
    console.log(`✓ a file over ${MAX_CUES} lines is refused without a single request`);
  }

  // A reply Google gives when its content filter refuses the passage.
  const BLOCKED = () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ finishReason: 'SAFETY' }], promptFeedback: {} }),
  });

  // ---- 3. a blocked passage is not asked for again -------------------------
  {
    process.env.MIN_SPLIT = '8';
    process.env.CHUNK_SIZE = '8';
    delete require.cache[require.resolve('../src/translate')];
    const t = require('../src/translate');
    let calls = 0;
    global.fetch = async () => { calls++; return BLOCKED(); };
    await t.translateCues(cues(8, (i) => 'A perfectly ordinary line number ' + i), 'k', () => {}, null, null, 'heb')
      .catch(() => {});
    assert.strictEqual(calls, 1, `a blocked 8-line chunk cost ${calls} requests; it must cost 1`);
    console.log('✓ a passage the content filter refuses is not retried');
  }

  // ---- 4. and a whole episode of it hits the per-episode budget -------------
  // Before: with render.yaml's CHUNK_SIZE 80 and MIN_SPLIT 2, one always-blocked
  // 80-line chunk cost 570 requests, and a 10-chunk episode about 5,700.
  {
    process.env.MIN_SPLIT = '2';
    process.env.CHUNK_SIZE = '80';
    delete require.cache[require.resolve('../src/translate')];
    const t = require('../src/translate');
    let calls = 0;
    global.fetch = async () => { calls++; return BLOCKED(); };
    await t.translateCues(cues(800, (i) => 'A perfectly ordinary line number ' + i), 'k', () => {}, null, null, 'heb')
      .catch(() => {});
    const budget = 20 + 10 * 8;
    assert.ok(calls <= budget, `an always-blocked 800-line episode cost ${calls} requests (budget ${budget})`);
    console.log(`✓ a hostile episode stops at its request budget (${calls} requests, was ~5,700)`);
  }
  global.fetch = realFetch;

  // ---- 5. a forged X-Forwarded-For no longer creates a new caller ----------
  {
    process.env.PORT = '0';
    process.env.QUIET = '1';
    const server = require('../src/server');
    const id = (xff) => server._callerId({ headers: { 'x-forwarded-for': xff }, socket: {} }, null);
    assert.strictEqual(id('1.1.1.1, 203.0.113.9'), id('2.2.2.2, 203.0.113.9'),
      'only the entry the hosting proxy appended may count');
    assert.strictEqual(id('203.0.113.9'), 'ip:203.0.113.9');
    server.close();
    console.log('✓ a forged X-Forwarded-For does not make a new caller');
  }

  // ---- 6. the Gemini wrapper: exact host, and a bad key changes nothing ----
  {
    delete require.cache[require.resolve('../src/gemini-fetch')];
    const seen = [];
    const stub = async (u) => {
      seen.push(String(u));
      return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.',
        details: [{ reason: 'API_KEY_INVALID' }] } }), { status: 400 });
    };
    const logs = [];
    require('../src/gemini-fetch').install({ fetch: stub, log: (m) => logs.push(m), fastRetries: true });

    // A URL that merely mentions the host is not treated as a Gemini call.
    await global.fetch('https://example.com/?x=generativelanguage.googleapis.com', {});
    assert.strictEqual(seen.length, 1, 'a look-alike URL must pass straight through');

    seen.length = 0;
    await global.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      { method: 'POST', body: JSON.stringify({ contents: [] }) });
    assert.ok(!logs.some((m) => /safety setting|thinkingConfig/.test(m)),
      'a bad key must not change the safety or thinking settings for everyone');
    assert.ok(seen.length <= 2, `a bad key cost ${seen.length} requests; one per model at most`);
    global.fetch = realFetch;
    console.log('✓ Gemini calls match the exact host, and a bad key leaves shared settings alone');
  }

  console.log('\nall hardening checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ ' + (e.stack || e.message));
  process.exit(1);
});
