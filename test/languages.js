'use strict';

// The names pass adds one request per episode; it has its own suite
// (test/names.js). Off here so these checks stay about their own subject.
process.env.NAME_GLOSSARY = '0';

// Stub addons run on 127.0.0.1; the server refuses private addresses otherwise.
process.env.ALLOW_PRIVATE_SOURCES = '1';

// The addon used to be Hebrew-only. These checks cover what had to become
// general for it to serve any language, and — just as important — that the
// Hebrew path still behaves exactly as it did.

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hebsubs-lang-'));

const SAMPLE = `1
00:00:01,000 --> 00:00:03,200
Morning. You're up early.

2
00:00:03,400 --> 00:00:05,900
Couldn't sleep.
`;

function fakeGemini(reply) {
  return (url, opts) => {
    const body = JSON.parse(opts.body);
    const prompt = body.contents[0].parts[0].text;
    const block = prompt.split('TRANSLATE')[1].split('CONTEXT AFTER')[0];
    const nums = [...block.matchAll(/^(\d+)\|/gm)].map((m) => Number(m[1]));
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{
          text: JSON.stringify(nums.map((n) => ({ n, he: reply(n) }))),
        }] } }],
      }),
    });
  };
}

async function main() {
  const langs = require('../src/languages');
  const srt = require('../src/srt');
  const { systemPrompt } = require('../src/translate');

  // ---- 1. the table itself holds together ------------------------------
  {
    const all = langs.list();
    assert.ok(all.length >= 40, 'the table should cover a lot of the world');
    const codes = all.map((l) => l.code);
    assert.strictEqual(new Set(codes).size, codes.length, 'duplicate language code');
    for (const l of all) {
      assert.ok(langs.SCRIPTS[l.script], `${l.code}: unknown script "${l.script}"`);
      assert.ok(l.native && l.name, `${l.code}: missing a name`);
      assert.ok(l.maxLine >= 18 && l.maxLine <= 48, `${l.code}: odd line length`);
      if (l.forms.gender) assert.ok(l.gender2p, `${l.code}: has gender forms but the flag is off`);
      if (l.forms.formal) assert.ok(l.formality, `${l.code}: has polite forms but the flag is off`);
    }
    // Every alias must resolve, and no alias may point at two languages.
    const seen = new Map();
    for (const l of all) {
      for (const a of langs.aliasesOf(l.code)) {
        assert.ok(!seen.has(a) || seen.get(a) === l.code, `alias "${a}" is ambiguous`);
        seen.set(a, l.code);
        assert.strictEqual(langs.normalize(a), l.code, `alias "${a}" does not resolve`);
      }
    }
    console.log(`✓ ${all.length} languages, every script, alias and flag consistent`);

    // Brazilian and European Portuguese are two languages, not one. A viewer
    // asked on the launch post; the single "Portuguese" drifted between them.
    const pob = langs.get('pob'), por = langs.get('por');
    assert.strictEqual(pob.code, 'pob', 'Brazilian Portuguese must be its own language');
    assert.strictEqual(langs.normalize('pt-br'), 'pob');
    assert.strictEqual(langs.normalize('pt'), 'por');
    const { systemPrompt } = require('../src/translate');
    const pb = systemPrompt(pob), pp = systemPrompt(por);
    assert.ok(/Brazilian Portuguese/.test(pb) && /ônibus/.test(pb) && /do not use tu/.test(pb), 'Brazil gets Brazilian guidance');
    assert.ok(/European Portuguese/.test(pp) && /autocarro/.test(pp) && /estou a fazer/.test(pp), 'Portugal gets European guidance');
    assert.ok(!/autocarro/.test(pb) || /Never European/.test(pb), 'no crossed wires');
    console.log('✓ Brazilian and European Portuguese are separate, each with its own guidance');

    // Same story for Spanish, asked for on the launch post the same day.
    const spl = langs.get('spl'), spa = langs.get('spa');
    assert.strictEqual(spl.code, 'spl');
    assert.strictEqual(langs.normalize('es-419'), 'spl');
    assert.strictEqual(langs.normalize('es'), 'spa');
    const sl = systemPrompt(spl), ss = systemPrompt(spa);
    assert.ok(/never vosotros/i.test(sl) && /celular/.test(sl), 'Latin America gets ustedes and its vocabulary');
    assert.ok(/vosotros for the familiar plural/.test(ss) && /móvil/.test(ss), 'Spain keeps vosotros');
    console.log('✓ Spanish for Spain and for Latin America are separate, each with its own guidance');
  }

  // ---- 2. a language never flags its own script as foreign --------------
  // Each entry's native name is written in that language's own script, which
  // makes it a free sample of correct output for all of them at once.
  {
    for (const l of langs.list()) {
      assert.ok(
        !srt.hasForeignScriptFor(l.native, l.code),
        `${l.code}: its own name "${l.native}" was flagged as foreign`
      );
    }
    // And the check still catches the bug it was written for.
    assert.ok(srt.hasForeignScriptFor('שלום مرحبا', 'heb'), 'Arabic inside Hebrew must be caught');
    assert.ok(srt.hasForeignScriptFor('Hola שלום', 'spa'), 'Hebrew inside Spanish must be caught');
    assert.ok(!srt.hasForeignScriptFor('שלום John', 'heb'), 'a Latin name inside Hebrew is fine');
    assert.ok(!srt.hasForeignScriptFor('Hola, ¿qué tal?', 'spa'), 'plain Spanish is fine');
    console.log('✓ every language accepts its own script and rejects the others');
  }

  // ---- 3. direction is applied only where it belongs --------------------
  {
    const rtlCodes = langs.list().filter((l) => l.rtl).map((l) => l.code);
    assert.ok(rtlCodes.includes('heb') && rtlCodes.includes('ara'), 'Hebrew and Arabic are RTL');
    for (const l of langs.list()) {
      const marked = srt.markDirection(l.native, l);
      const wrapped = marked !== l.native;
      assert.strictEqual(wrapped, l.rtl, `${l.code}: direction marking is wrong`);
    }
    assert.strictEqual(
      srt.markDirection('שלום.', langs.get('heb')),
      srt.rtl('שלום.'),
      'the general call must match the Hebrew one exactly'
    );
    assert.strictEqual(srt.markDirection('John Smith', langs.get('heb')), 'John Smith',
      'a line with none of the language\'s own letters is left alone');
    console.log('✓ right-to-left marking applied to RTL languages only, Hebrew unchanged');
  }

  // ---- 4. the prompt is built from the language's properties ------------
  {
    for (const l of langs.list()) {
      const p = systemPrompt(l);
      assert.ok(p.includes(l.name), `${l.code}: prompt never names the language`);
      assert.strictEqual(p.includes('SECOND PERSON'), l.gender2p, `${l.code}: gender section wrong`);
      assert.strictEqual(p.includes('REGISTER OF ADDRESS'), l.formality, `${l.code}: register section wrong`);
      assert.ok(p.includes('NEVER output'), `${l.code}: prompt does not forbid other scripts`);
      if (l.code !== 'heb') {
        assert.ok(!/אתה \/ את/.test(p), `${l.code}: leaked the Hebrew forms into another language`);
      }
    }
    const he = systemPrompt(langs.get('heb'));
    assert.ok(/אתה \/ את \/ אתם \/ אתן/.test(he), 'Hebrew must still spell out its forms');
    assert.ok(/NEVER output Arabic/.test(he), 'Hebrew must still forbid Arabic by name');
    const de = systemPrompt(langs.get('ger'));
    assert.ok(/du \(familiar\) \/ Sie/.test(de), 'German must name du/Sie');
    assert.ok(!de.includes('SECOND PERSON'), 'German does not mark the addressee\'s gender');
    const sv = systemPrompt(langs.get('swe'));
    assert.ok(!sv.includes('SECOND PERSON') && !sv.includes('REGISTER OF ADDRESS'),
      'Swedish needs neither section');
    console.log('✓ each language gets exactly the guidance it needs, and no other language\'s');
  }

  // ---- 5. an unknown code still works ----------------------------------
  {
    const x = langs.get('zzz');
    assert.strictEqual(x.code, 'zzz');
    assert.strictEqual(x.rtl, false);
    assert.ok(systemPrompt(x).includes('NEVER output'), 'an unknown language still gets a prompt');
    console.log('✓ a language that is not in the table falls back to neutral defaults');
  }

  // ---- 6. the server keeps languages apart -----------------------------
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/subtitles/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        subtitles: [{ id: '1', url: `http://127.0.0.1:${upstream.address().port}/file.srt`, lang: 'eng' }],
      }));
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(SAMPLE);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  process.env.UPSTREAM_ADDONS = `http://127.0.0.1:${upstream.address().port}`;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.SECRET = 'S'.repeat(40);
  process.env.CACHE_DIR = TMP;
  process.env.PORT = '0';
  process.env.QUIET = '1';
  process.env.TARGET_LANG = 'heb';

  const realFetch = global.fetch;
  // Whatever language is asked for, answer in Spanish-looking text unless the
  // prompt says Hebrew — enough to tell the two paths apart.
  global.fetch = (u, o) => {
    if (!String(u).includes('generativelanguage')) return realFetch(u, o);
    const sys = JSON.parse(o.body).systemInstruction.parts[0].text;
    const spanish = sys.includes('into modern, natural Spanish');
    return fakeGemini((n) => (spanish ? `Línea número ${n}` : `שורה מספר ${n}`))(u, o);
  };

  delete require.cache[require.resolve('../src/sources')];
  const server = require('../src/server');
  await new Promise((r) => setTimeout(r, 300));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 6a. the default manifest is the configured language
  const m0 = await (await realFetch(`${base}/manifest.json`)).json();
  // Hebrew deliberately keeps the id it was first published under, so nobody
  // who already installed it has to install it again.
  assert.strictEqual(m0.id, 'community.hebrew.ai.subtitles',
    'Hebrew must keep its original addon id');
  assert.ok(/עברית/.test(m0.name), 'and is named in Hebrew');

  // 6b. a language code in the path selects another language
  const mEs = await (await realFetch(`${base}/spa/manifest.json`)).json();
  assert.ok(mEs.id.endsWith('.spa'), 'a /spa prefix gives the Spanish manifest');
  assert.notStrictEqual(mEs.id, m0.id, 'the two manifests must not share an id');
  assert.ok(/Español/.test(mEs.name), 'and is named in Spanish');

  // 6b'. a doubled slash from a careless paste still reaches the language
  const mDbl = await (await realFetch(`${base}//spa/manifest.json`)).json();
  assert.ok(mDbl.id.endsWith('.spa'), '//spa/manifest.json must give Spanish, not the default language');

  // 6c. junk in that position is still refused
  assert.strictEqual((await realFetch(`${base}/NOTALANG/manifest.json`)).status, 404,
    'an unknown prefix must not alias the route');
  console.log('✓ /manifest.json, /spa/manifest.json, a doubled slash and a junk prefix all behave');

  // 6d. the same episode in two languages is two different cache entries
  const sHe = await (await realFetch(`${base}/subtitles/series/tt1234567:1:4.json`)).json();
  const sEs = await (await realFetch(`${base}/spa/subtitles/series/tt1234567:1:4.json`)).json();
  assert.strictEqual(sHe.subtitles[0].lang, 'heb');
  assert.strictEqual(sEs.subtitles[0].lang, 'spa');
  const keyHe = new URL(sHe.subtitles[0].url).pathname.split('/').pop().replace('.srt', '');
  const keyEs = new URL(sEs.subtitles[0].url).pathname.split('/').pop().replace('.srt', '');
  assert.notStrictEqual(keyHe, keyEs, 'two languages must not share one cache entry');
  console.log('✓ the same episode caches separately per language');

  // 6e. a signature issued for one language does not work for another.
  // The cache is checked before anything else — an already-built file costs
  // nothing to serve — so this has to be asked under a name nothing is stored
  // under, which is the state a real attempt would be in.
  const heUrl = new URL(sHe.subtitles[0].url);
  const swapped = new URL(`${base}/sub/${'0'.repeat(16)}.srt`);
  swapped.searchParams.set('src', heUrl.searchParams.get('src'));
  swapped.searchParams.set('l', 'spa');                        // different language
  swapped.searchParams.set('s', heUrl.searchParams.get('s'));  // Hebrew's signature
  assert.strictEqual((await realFetch(swapped.toString())).status, 404,
    'a Hebrew signature must not authorise a Spanish translation');

  // and the same request with Hebrew's own language is refused too, because
  // the cache name still has to match what the source hashes to.
  swapped.searchParams.set('l', 'heb');
  assert.strictEqual((await realFetch(swapped.toString())).status, 404,
    'the cache name must still match the source');
  console.log('✓ a signature is bound to its language as well as its source');

  // 6f. end to end in a left-to-right language
  const es = await realFetch(sEs.subtitles[0].url);
  const esBody = await es.text();
  assert.strictEqual(es.status, 200, 'the Spanish link must work');
  assert.ok(/Línea número/.test(esBody), 'and must come back in Spanish');
  assert.ok(!esBody.includes(srt.RLE), 'a left-to-right language gets no RTL marks');
  const esCues = srt.parse(esBody);
  assert.strictEqual(esCues.length, 2, 'both cues survive');
  assert.strictEqual(esCues[0].start, 1000, 'and keep their timings');

  // 6g. and Hebrew still comes back marked right-to-left
  const he2 = await realFetch(sHe.subtitles[0].url);
  const heBody = await he2.text();
  assert.ok(/[\u0590-\u05FF]/.test(heBody), 'Hebrew link returns Hebrew');
  assert.ok(heBody.includes(srt.RLE), 'and it is still wrapped right-to-left');
  console.log('✓ Spanish returns plain LTR lines, Hebrew keeps its RTL marks — same timings');

  upstream.close();
  server.close();
  console.log('\nall language checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n✗ ' + (e.stack || e.message));
  process.exit(1);
});
