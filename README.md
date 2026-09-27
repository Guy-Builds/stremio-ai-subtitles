# AI Subtitles for Stremio

> Translates English subtitles into **56 languages** with a language model. It reads the
> dialogue as one continuous passage instead of line by line, and returns it on the
> original timings. Free to run. Everyone uses their own Gemini API key.

One server gives you every language. You pick one by putting its three-letter code in the
install address, so you can add a language at any time without deploying again.

---

Subtitle lines are cut by screen timing, not by sentence. One sentence is often split
across three lines. A single line on its own often means nothing. This is why line-by-line
machine translation is so hard to follow.

This addon works differently. It sends the model a long stretch of dialogue at once. The
lines before and after it are included as context, but are not translated. The model reads
the whole passage first. Only then does it spread the translation back across the same
numbered lines, in the target language's word order.

**Timings never move.** The file is checked before it is written. If any line has moved,
the process stops. You never get subtitles that are out of sync.

<p align="center">
  <a href="https://github.com/sponsors/Guy-Builds"><img src="images/coffee.svg" alt="Buy me a coffee" height="40"></a>
</p>

---

## Install

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Guy-Builds/stremio-ai-subtitles)

Press the button. You need to fill in two fields:

- **Blueprint Name** — this field is empty and required. Any name works.
- `GEMINI_API_KEY` — a free key from [Google AI Studio](https://aistudio.google.com/apikey).

Everything else is set for you, including a `SECRET` that is created automatically.

When the deploy finishes, your install address looks like this:

```
https://<your-service>.onrender.com/<language-code>/manifest.json
```

**Those three letters in the middle are the language.** Change them and you get the same
addon in another language:

```
.../spl/manifest.json     Spanish (Latin America)
.../fre/manifest.json     French
.../jpn/manifest.json     Japanese
```

In Stremio on a computer: **Addons** → **+ Add addon** → paste the full address → **Add** →
**Install**. On a phone there is no Add addon button: paste the address into the search
field on the **Addons** screen instead. Installing on one device syncs it to every device
on the same account, including the TV.

Open an episode. Wait about a minute the first time. Then pick the language in the subtitle
menu.

**Stuck?** [`GUIDE.md`](GUIDE.md) is a step-by-step guide. It covers common problems and
how to run the addon on your own computer.

---

## Languages

You can install as many languages as you like at the same time. Each one appears in Stremio
as its own addon. `TARGET_LANG` sets the default for your server, but you do not need to
deploy again to use another language. Just put its code in the address.

| Code | Language | Native |
|---|---|---|
| `heb` | Hebrew | עברית |
| `chi` | Chinese (Simplified) | 简体中文 |
| `hin` | Hindi | हिन्दी |
| `spl` | Spanish (Latin America) | Español (Latinoamérica) |
| `ara` | Arabic | العربية |
| **⋯** | **51 more languages** | **⋯** |

<details>
<summary><b>Show all 56</b></summary>

| Code | Language | Native |
|---|---|---|
| `spa` | Spanish (Spain) | Español (España) |
| `fre` | French | Français |
| `ben` | Bengali | বাংলা |
| `pob` | Portuguese (Brazil) | Português (Brasil) |
| `por` | Portuguese (Portugal) | Português (Portugal) |
| `rus` | Russian | Русский |
| `urd` | Urdu | اردو |
| `ind` | Indonesian | Bahasa Indonesia |
| `jpn` | Japanese | 日本語 |
| `ger` | German | Deutsch |
| `swa` | Swahili | Kiswahili |
| `tel` | Telugu | తెలుగు |
| `tur` | Turkish | Türkçe |
| `tam` | Tamil | தமிழ் |
| `vie` | Vietnamese | Tiếng Việt |
| `kor` | Korean | 한국어 |
| `tgl` | Filipino | Filipino |
| `fas` | Persian | فارسی |
| `may` | Malay | Bahasa Melayu |
| `ita` | Italian | Italiano |
| `tha` | Thai | ไทย |
| `pol` | Polish | Polski |
| `ukr` | Ukrainian | Українська |
| `mal` | Malayalam | മലയാളം |
| `dut` | Dutch | Nederlands |
| `rum` | Romanian | Română |
| `gre` | Greek | Ελληνικά |
| `hun` | Hungarian | Magyar |
| `cze` | Czech | Čeština |
| `swe` | Swedish | Svenska |
| `srp` | Serbian | Српски |
| `bul` | Bulgarian | Български |
| `hrv` | Croatian | Hrvatski |
| `dan` | Danish | Dansk |
| `fin` | Finnish | Suomi |
| `nor` | Norwegian | Norsk |
| `slo` | Slovak | Slovenčina |
| `aze` | Azerbaijani | Azərbaycan |
| `kaz` | Kazakh | Қазақша |
| `alb` | Albanian | Shqip |
| `slv` | Slovenian | Slovenščina |
| `lit` | Lithuanian | Lietuvių |
| `lav` | Latvian | Latviešu |
| `mac` | Macedonian | Македонски |
| `geo` | Georgian | ქართული |
| `arm` | Armenian | Հայերեն |
| `cat` | Catalan | Català |
| `est` | Estonian | Eesti |
| `glg` | Galician | Galego |
| `ice` | Icelandic | Íslenska |
| `baq` | Basque | Euskara |

</details>

The instructions sent to the model are not written by hand for each language. They are
built from four facts about it:

- which script to write in
- which direction it reads
- whether you must choose a gender when you address someone
- whether it has both a familiar and a polite "you"

So adding a language is one row in `src/languages.js`. It is not new code. A code that is
not in the table still works, with neutral settings.

For many languages the table also holds the actual forms, because showing them works better
than describing them: `אתה / את / אתם / אתן` for Hebrew, `tu / vous` for French,
`du / Sie` for German, `сказал / сказала` for Russian. These go straight into the prompt.

**One thing to be clear about.** The model is good at common languages. The rarer the
language, the weaker it gets, and the mistakes can be hard to spot if you do not read it.
The addon will return a valid file in any language. The quality is not something this
project can promise. If you are the first person to try a language here, watch one episode
before you recommend it to anyone.

---

## What it does beyond translating

| | |
|---|---|
| **Context** | Chunks of 80 lines, with 12 neighbouring lines on each side as read-only context |
| **Direction** | Lines in a right-to-left language are wrapped in explicit RTL marks, so a full stop cannot jump to the start of the sentence |
| **Gender** | Dedicated guidance to decide who is being addressed and stay consistent, plus an optional evidence track in a language that marks it |
| **Names** | Every recurring proper name is settled once, before translation, so "Billy the Kid" stays one name and nobody is spelled two ways |
| **Speakers** | Detects an SDH track automatically and extracts who says each line — and from that, who is being addressed |
| **Cleanup** | Sound descriptions ("door creaks", "siren") are removed, and cues that were only a description disappear from the file |
| **Resilience** | Retries with growing backoff, automatic fallback to a second model, and bisection of chunks the content filter blocks |
| **Foreign dialogue** | With a reference track, lines the English skipped entirely are folded back in and translated from it |

---

## Cost and time

**Money: none.** Render's free tier and Gemini's free tier.

**Time: about a minute for a first episode.** Measured on a real one: 709 lines, 8 chunks,
51 seconds. Translation starts when you open the episode, not when you press Play, so you
wait less than that. After the first time the file is saved and loads at once for everyone
in the house.

It can take a few minutes if Google limits the rate (error 429). The addon waits and tries
again by itself. If the model is busy (503), it moves to the backup model instead of waiting.
The log shows what is happening.

Flash has a smaller free daily quota than Flash-Lite. When it runs out, the addon moves to
Flash-Lite straight away, without waiting, and stays there for an hour. You can see your
current limits on the [rate-limit page in AI Studio](https://aistudio.google.com/rate-limit?timeRange=last-28-days).

Two settings change the time. Speaker names from an SDH track add about **8%**, and they
work on their own. `REFERENCE_LANG` adds about **a third**. Start without a reference track.
Add one only if gender is still wrong too often.

On Render's free plan the service sleeps after 15 minutes. Keep it awake by calling
`/health` every 10 minutes, **around the clock** (`*/10 * * * *`), from a free cron service.
Do not add a night-time break: once the service is asleep, the pings cannot wake it. One
service running all month uses at most 744 of the 750 free hours, so keep it the only free
service in the Render account. [`GUIDE.md`](GUIDE.md#step-5--keep-the-server-awake-optional)
has the details.

---

## Configuration

Environment variables. All optional except the key.

| Field | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | — | Your key. Empty means public mode, where each visitor configures their own on the front page |
| `SECRET` | generated | Encrypts a user's key into their personal install address. **Do not change after deploying** |
| `TARGET_LANG` | `heb` | The language for an install address without a code. Any code from the table |
| `GEMINI_MODEL` | `gemini-flash-latest` | The model that translates. Flash chooses words better than Flash-Lite |
| `GEMINI_FALLBACK` | `gemini-flash-lite-latest` | Used when the main model is busy or its free daily quota runs out. Empty = no fallback |
| `CHUNK_SIZE` | `80` | Lines per request. Larger gives better context, but is blocked more often |
| `CONCURRENCY` | `1` | Requests at the same time. **Do not raise it.** This is what uses up the per-minute quota |
| `MIN_SPLIT` | `2` | How far to keep splitting a blocked chunk. Lower leaves less English, but is slower |
| `REFERENCE_LANG` | — | A second track in a language that marks gender, used as evidence |
| `FILL_FOREIGN_GAPS` | `1` | Fold in lines the English track skipped. Requires `REFERENCE_LANG` |
| `KEEP_SOUND_CUES` | — | `1` to keep sound descriptions instead of removing them |
| `NAME_GLOSSARY` | `1` | Settle proper names in one request before translating. `0` turns it off |
| `MAX_SOURCES` | `2` | English sources translated per episode. `1` halves quota use |
| `RATE_LIMIT_PER_DAY` | `40` | New episodes per day per caller |
| `RATE_LIMIT_TOTAL` | `200` | Daily ceiling for the whole service |
| `MAX_JOBS` | `3` | Translations running at once |
| `MAX_SUBTITLE_BYTES` | `2000000` | Largest source file accepted |

---

## Running it locally

You do not need the cloud. On Windows: double-click `INSTALL.bat`, then `START.bat`.
The trade-off is that the computer has to stay on while you watch.

On any other system:

```bash
GEMINI_API_KEY=... node src/boot.js
```

And to convert a single SRT file without Stremio at all:

```bash
GEMINI_API_KEY=... node src/cli.js episode.en.srt
```

---

## Tests

```bash
npm test
```

Six test suites. They run without the network and without using any quota:

- parsing and timings
- the cloud path and key encryption
- text direction and foreign-script filtering
- reference-track alignment and speaker detection
- security — each check matches a real hole that was closed, so it cannot come back unnoticed
- languages — the table, direction, and keeping each language's cache and signature apart

---

## Privacy and security

Your key stays in your own server's environment variables. It appears in no address. It is
never written to the log or to disk.

Every subtitle link the server creates is signed. Nobody can change the source address
inside it to make the server download something else and translate it with your quota.
Private and internal addresses are refused. Downloads have a size limit, and so do
compressed files. There is a daily limit for each caller, and a second limit for the whole
service. The page that asks for a key is only served by a public server that needs it.

In public mode each user brings their own key. That key is encrypted inside their personal
install address. Someone who gets the address cannot read the key out of it, but they can
use it. So treat that address like a password.

The English subtitles come from the public OpenSubtitles addon, the same one Stremio comes
with. This addon does not host or share any subtitles of its own.

---

## Support

The addon is free and stays free. If it made an episode easier to follow, you can
[buy me a coffee](https://github.com/sponsors/Guy-Builds). It helps me keep up with new
Stremio versions and model changes. A star on the repo helps other people find it too.

<a href="https://github.com/sponsors/Guy-Builds"><img src="images/coffee.svg" alt="Buy me a coffee" height="40"></a>

---

AGPL-3.0-or-later — see [`LICENSE`](LICENSE)
