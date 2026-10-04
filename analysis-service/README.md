# Yugen Japanese analysis service

This small local service exposes the DC-004 Japanese analysis boundary. It uses
Sudachi for tokenization/readings and JMdict for English word glosses. KANJIDIC2 supplies separate character
meanings and Japanese on/kun readings, available as optional kanji details.
It can also forward an explicitly selected corrected sentence and its local
word surfaces to OpenAI. The whole sentence is translated first, followed by
contextual meanings for the supplied words. These remain separate from the
saved source text, deterministic furigana, and local dictionary results.

## Setup and run

Requirements: JDK 17, `curl`, `unzip`, `gzip`, and `shasum`.

From this directory:

```sh
rtk proxy ./scripts/setup-data.sh
rtk proxy ./gradlew test
rtk proxy ./gradlew run
```

The service listens on `127.0.0.1:8080` by default. `YUGEN_ANALYSIS_HOST`,
`YUGEN_ANALYSIS_PORT`, and `YUGEN_ANALYSIS_DATA` (defaults to `.data`) may be
set for local development. Do not expose this unauthenticated development
endpoint to untrusted networks.

For the complete connected-iPhone workflow, run this from the repository root:

```sh
pnpm --dir mobile start:dev-client
```

It downloads missing data automatically, starts this service on the LAN, sets
Expo's analysis address, starts Metro, and builds/installs the development client.
`YUGEN_ANALYSIS_LAN_IP` overrides the detected Mac address. See `DEVELOPMENT.md`.
Keep the service on a trusted private LAN.

AI translation is disabled by default (`YUGEN_AI_ENABLED=false`) and disabled
in the mobile request function. The device launcher also removes an inherited
`OPENAI_API_KEY`. Local readings, JMdict meanings and cards do not need a key.
The retained translator reads server-only `OPENAI_API_KEY`, `AI_PROVIDER`
(default `openai`) and `AI_MODEL` (default `gpt-5-nano`, minimal reasoning).
That inexpensive model is currently deprecated; check availability before any
future enablement. Requests use `store: false`. Never put provider credentials
in the mobile bundle. No provider request is made while translation is disabled.

Tests use the real downloaded tokenizer dictionary and JMdict and KANJIDIC2 data. The golden
case is `鶏肉をください。`; it checks Sudachi tokenization, hiragana readings,
dictionary lookup, script units, and real character definitions. Tests fail clearly if setup data is absent.

## API contract

`POST /v1/analyze`

Request:

```json
{"contractVersion":2,"language":"ja","text":"鶏肉をください。"}
```

Smoke test:

```sh
rtk proxy curl -X POST http://127.0.0.1:8080/v1/analyze \
  -H 'Content-Type: application/json' \
  -d '{"contractVersion":2,"language":"ja","text":"鶏肉をください。"}'
```

Response:

```json
{"contractVersion":2,"language":"ja","normalizedText":"鶏肉をください。","tokens":[{"surface":"鶏肉","lemma":"鶏肉","reading":"けいにく","partOfSpeech":"名詞","dictionaryCandidates":[{"id":"<JMdict-entry>:とりにく","reading":"とりにく","meanings":["chicken meat"],"recommended":false}],"curatedMeaning":null,"scriptUnits":["鶏","肉"]}]}
```

`reading` is the furigana reading: for a multi-token selection it uses
Sudachi's sentence reading when available; only an isolated lexical item can
use a unique JMdict priority recommendation. It may be `null` when neither
source provides a reading. Sudachi's reading never filters out JMdict entries
with the same written form. `dictionaryCandidates`
keeps each JMdict entry's reading paired with its meanings. A uniquely higher
commonness priority for the exact written form is marked `recommended` only for
an isolated lexical item; this is a rough lexicon hint, not context
understanding. `米` therefore returns both the `こめ` / rice and `べい` /
America candidates, recommending rice from JMdict's written-form priority. In
any multi-token selection, dictionary candidates are not automatically
recommended; Sudachi supplies the displayed furigana and the user may choose a
dictionary candidate explicitly.
`curatedMeaning` is reserved for the small app-maintained known-term list and
is never represented as a JMdict entry. Word glosses are not a sentence
translation. Priority values are rough frequency indicators
([JMdict DTD](https://www.edrdg.org/jmdict/jmdict_dtd_h.html)), not contextual
analysis. `normalizedText` currently echoes the exact submitted text; callers
must keep the captured raw OCR separate from any user correction.

## Kanji detail boundary

Each token also includes `kanjiDetails`, in its unique `scriptUnits` order:

```json
{"character":"肉","meanings":["meat"],"onReadings":["ニク"],"kunReadings":["しし"]}
```

These are character dictionary definitions, not a translation of the compound.
The actual word reading remains `reading` / the explicitly chosen JMdict
candidate. Unlisted characters return empty detail arrays; do not guess meanings.
This is an additive contract-2 field. The mobile parser accepts older cached
responses without it; new data is retrieved when studying an old group online.

## Sentence translation

`POST /v1/translate` accepts the exact corrected text, source/target language
codes, and ordered local word tokens:

```json
{"contractVersion":2,"sourceLanguage":"ja","targetLanguage":"en","text":"金芽米使用","words":[{"tokenIndex":0,"surface":"金芽米"},{"tokenIndex":1,"surface":"使用"}]}
```

The response includes the exact source text, a natural whole-sentence
translation, and one contextual word meaning for each submitted token index
and surface. Missing provider configuration returns HTTP 503; provider failures
return HTTP 502 without exposing provider details. This endpoint returns HTTP 503 while AI is disabled. The mobile UI does not
expose it during local-study testing. Retained translation data is separate
from local readings and matched to its exact source text.

## Data and licensing

`setup-data.sh` downloads the pinned SudachiDict core binary (20260116, V0
format, compatible with Sudachi 0.7.5) and verifies its SHA-256 before
extraction. It also downloads the current English JMdict NG and KANJIDIC2 XML data. All
downloaded/extracted files and the generated manifest live under ignored
`.data/`; dictionary archives are not committed.

JMdict and KANJIDIC2 are provided by the Electronic Dictionary Research and Development Group
(EDRDG) under CC BY-SA 4.0. EDRDG requires software and smartphone apps to
acknowledge JMdict and its source in documentation and provide the license and
documentation as files or links; the app acknowledgement must be reachable
from a menu (for example, a Sources screen), not only from the launch screen.
If JMdict data is adapted and redistributed, share-alike applies. EDRDG also
requires a regular update procedure; its example for dictionary servers is at
least monthly. This development setup fetches the current feed and records its
retrieval date and SHA-256; production must establish and operate a regular
refresh process. See the [EDRDG license](https://www.edrdg.org/edrdg/licence.html)
and [JMdict index](https://ftp.edrdg.org/pub/Nihongo/00INDEX.html). The root
`docs/COST-AND-LICENSES.md` records the product licensing gate.

Sudachi source and the distributed dictionary are marked Apache-2.0. The
dictionary archive also contains `LEGAL` and `LICENSE-2.0.txt`; its legal notice
describes UniDic- and NEologd-derived data and associated notices/conditions.
Review and preserve those notices before redistributing the dictionary. See the
[SudachiDict license notes](https://github.com/WorksApplications/SudachiDict#licenses).
Pin/update the tokenizer library and its matching dictionary together.

The EDRDG JMdict NG feed changes over time. Setup records the retrieval date and
SHA-256 locally so test results identify the exact data snapshot. To reproduce
a previous run, set `SUDACHI_SOURCE_FILE`, `JMDICT_SOURCE_FILE`, and `KANJIDIC_SOURCE_FILE` to the same
locally archived files before running setup. Never commit dictionary data or a
JMdict-derived database export.

The launcher calls `setup-data.sh --missing`: existing data is kept and only
missing files are downloaded. Running `setup-data.sh` without that option refreshes
all dictionaries. The manifest records checksums and retrieval dates; refresh
EDRDG feeds regularly (at least monthly for a dictionary server). Neither raw
data nor derived personal vocabulary exports belong in version control.
