# `json-projection`: the JSON projection vectors' tools, and their differential fuzz

Four dependency-free Node ESM maintainer tools for the two JSON profiles,
[`ontos-total-json/1`](../../docs/spec/ontos-total-json.md) and
[`ontos-readable-json/1`](../../docs/spec/ontos-readable-json.md)
([design record 0010](../../docs/design/0010-json-projections.md),
[issue 33](https://github.com/Bitspark/ontos/issues/33)):

| tool | what it does | run by |
| --- | --- | --- |
| [`gen.mjs`](gen.mjs) | fills the derived fields (`input_hex`, `value_hex`, `provenance`) of the hand-authored vectors in [`projection/json/vectors/`](../../projection/json/vectors/) | `scripts/check.sh vectors` |
| [`check.mjs`](check.mjs) | the **independent checker**: its own codec, `ontos/data` encoders and recognizer, strict JSON reader, both interpreters and both writers, written from the spec pages. It imports nothing, checks every committed case, and is the oracle below | `scripts/check.sh vectors` |
| [`oracle.mjs`](oracle.mjs) | runs `check.mjs`'s reader and writer under a case's limits and returns the case's expected fields | `fuzz.mjs` |
| [`fuzz.mjs`](fuzz.mjs) | the seeded generator of the differential fuzz: a fresh corpus in the vectors' format, every expectation computed by the oracle | `scripts/check.sh fuzz` |

## The differential fuzz

The committed vectors pin what their authors thought of. The fuzz checks all four faces
(`projection/json/{go,rs,ts,py}`) on new inputs on every CI run. Each face's reader and writer
must agree with the oracle on every generated case. Faces that each agree with the oracle
also agree with each other, so the check covers all four faces against each other.

**Each face's existing vector replay runs the fuzz.** The corpus has exactly the format of
`projection/json/vectors/{total,readable}.json` (its [README](../../projection/json/vectors/README.md),
"What a case pins"). Each replay reads the directory that `ONTOS_JSON_PROJECTION_VECTORS` names
in place of the committed one. So a generated case is judged exactly as a committed one is: the
read, the refusal (code, path, span, kind), the value's codec bytes, the origins, the
preferred output, the write refusal (code, kind), the laws on every output, and, for every
input that is UTF-8, the host-string reader against the byte reader (Rust, TypeScript, Python).
Nothing about the judgement is new code in the faces.

| face | replay | alone, on a corpus |
| --- | --- | --- |
| Go | `TestVectors` in `projection/json/go/{total,readable}` (`internal/vectors`) | `ONTOS_JSON_PROJECTION_VECTORS=$PWD/c go test -count=1 -run '^TestVectors$' -v ./projection/json/go/total ./projection/json/go/readable` |
| Rust | `total_vectors`, `readable_vectors` in `projection/json/rs/tests/vectors.rs` | `ONTOS_JSON_PROJECTION_VECTORS=$PWD/c cargo test -p bitspark-ontos-json --test vectors -- --nocapture` |
| TypeScript | `projection/json/ts/test/{total,readable}.test.ts` (`vectors.ts`) | `ONTOS_JSON_PROJECTION_VECTORS=$PWD/c node --test projection/json/ts/test/total.test.ts projection/json/ts/test/readable.test.ts` |
| Python | `projection/json/py/test/test_vectors.py` | `ONTOS_JSON_PROJECTION_VECTORS=$PWD/c python3 projection/json/py/test/test_vectors.py` |

Each replay prints the path it read and its counts. Give the variable an absolute path,
because each face's test runs from its own directory. The TypeScript replay imports the built
packages, so build the workspace first (`npm ci && npm run build --workspaces --if-present`).

## Where it runs

- **`scripts/check.sh fuzz`** generates `FUZZ_JSON_COUNT` cases per profile (default 2000) from
  a fresh seed and replays them in all four faces, Go at both widths (`GOARCH=386` too). Then it
  deletes the corpus. CI's fuzz job runs it. `scripts/check.ps1 fuzz` mirrors it.
- **`scripts/check.sh test`** and **`vectors`** are unchanged: they replay and check the
  committed vectors.

The seed follows the rules of the other generated corpora (design record
[0009](../../docs/design/0009-generated-limit-policy-tests.md)): `FUZZ_SEED` pins it, else it is
derived from `$GITHUB_SHA`, so a rerun on one commit replays one corpus, else from the clock.
The generator prints it.

## Running the generator

```sh
node tools/json-projection/fuzz.mjs                                 # fresh seed, 2000 per profile, ./json-projection-corpus
node tools/json-projection/fuzz.mjs --seed 0x2a --count 10000 --out /tmp/c
node tools/json-projection/fuzz.mjs --seed 0x2a --case readable:1717 # one case, to stdout
FUZZ_SEED=0x2a FUZZ_JSON_COUNT=500 scripts/check.sh fuzz
```

- `--seed <u64>|fresh`: decimal or `0x` hex. `fresh` is the default.
- `--count <N>`: cases per profile.
- `--out <dir>`: writes `<dir>/total.json` and `<dir>/readable.json`.
- `--case <profile>:<i>`: regenerates case `i` alone. Case `i` of a profile is a pure function of
  the seed, the profile, `i` and the committed vectors' inputs (which seed the mutations), so a
  failing case named `readable-001717-…` in a CI log is `--case readable:1717` under the printed
  seed, whatever the count was.

The generator also prints the corpus's outcomes: read refusals by code and limit kind,
accepted reads, values written, write refusals by kind, and how many cases carry origins and
limits. At 1000 cases per profile or more, it fails if a refusal code of the profile, a limit
kind (read or write), an accepted read, a value to write, or (readable) origins are left
unexercised.

## What it generates

Each case comes from one family, named in its `group` (`fuzz:<family>`) and described in its
`note`:

| family | inputs |
| --- | --- |
| `spelled` | a random value (below), spelled at random among the spellings the profile accepts: preferred, `raw`, `compound` for registered labels, tagged small ints, `-0`, the `map` tag for text-keyed maps, `["bytes", …]` labels for UTF-8 labels, members and entries in any order. Then serialized with random whitespace and random escapes (`\uXXXX` of either case, surrogate pairs for astral characters, `\/`) |
| `deviant` | a spelling with one or two nodes made wrong: malformed envelopes (arity, kinds, tags, extra members, empty), bad integer text, non-canonical decimals and base64, duplicate members, duplicate map keys and set elements across spellings, `$ontos` beside other members, bad numbers; in total form, every way a node misses `{"atom": hex}` or `{"tuple": […]}` |
| `mutant` | a committed vector's input or a fresh spelling, with one to three byte mutations: deletions, insertions of bytes, tokens (`\u`, `\ud800`, `$ontos`, `{"atom":"`, U+00A0, U+2028, U+FEFF, comments, …) and ill-formed UTF-8, replacements, copies, truncation, splices |
| `escapes`, `surrogates` | strings of valid and invalid escapes, and lone, paired, reversed, truncated and mixed-case surrogate escapes, in names and values, after multi-byte text |
| `numbers`, `integers` | lexemes at the integer window (±(2⁵³ − 1) and one past), `-0`, leading zeros, fractions, exponents, signs; `int` tag and decimal texts, canonical and not, up to and past 4300 digits |
| `base64`, `reserved`, `hex` | canonical and non-canonical base64 (pad bits, padding, alphabet, line breaks), the reserved name spelled with escapes and beside other members, hex of every wrong kind |
| `deep` | nesting at and past the defaults (value depth 1024, JSON depth 2050 and 3076) and at small depths with lowered limits, through lists, objects, `compound`, `set`, `map` and `raw`, some cut short |
| `utf8`, `framing`, `duplicates` | ill-formed UTF-8 of every maximal-subpart class at random offsets, often after multi-byte text; byte order marks, non-JSON whitespace, trailing data, empty texts; repeated names after escape decoding, and repeated keys and elements by ground-value equality |
| `value`, `near miss`, `integers to write`, `deep value` | values for the writer alone: random data-shaped values (texts with every escaping class, integers at every magnitude, decimals, lists, maps with keys around the 128- and 256-byte uvarint boundaries, sets, compounds with UTF-8, non-UTF-8 and registered labels, atoms, `raw`-only tuples), tuples that come close to a registered kind and miss it, and chains up to depth 1023 |

**Limits.** About half the cases set limits: one bound or several, each at the case's need,
one below, one above, 0, or a random or very large value. The need comes from the input (its
length and JSON depth) and from its value (depth, longest atom, widest tuple, most digits) or,
for a value to write, from the value and its output. Every bound is at most 2³¹ − 1, which
every face's bound type holds, Go's `int` on 386 included.

**Expectations.** For an input, the oracle reads it under the case's limits. A refusal gives
`refusal`. An accepted input gives `value_hex` and, for the readable profile, `origins`. The
writer then writes that value under the same limits, which gives `output` or `render_refusal`.
For a value alone, the writer's result is the whole case. Each output also checks the laws in
every face.

**Two scope choices.** Origins are pinned unless their rows hold more than 20,000 path
segments: a deep value's origins would be megabytes, and the Python replay checks the origins
reader's consistency on every accepted case anyway. And no case carries a value deeper than
1024, the codec decoder's default depth, because the Rust replay decodes `value_hex` under the
decoder's defaults. So no case raises `max_value_depth`, and deeper texts are always refused.

## Why to trust the expectations

The oracle is `check.mjs`. It is written from the two spec pages, imports nothing, and agrees
with every committed case. `fuzz.mjs` and `oracle.mjs` add no judgement of their own. Three
checks keep the generator and the oracle honest:

- **The laws, on the oracle.** `oracle.mjs` reads every output it computes under the same limits
  and writes the value again (total §7, §9.3). A failure stops the run as an oracle defect.
- **Values derived twice.** The generator builds its values with its own small encoder and
  `ontos/data` builders, not `check.mjs`'s. A `spelled` input without limits must read back,
  through the oracle, to exactly the value the generator spelled, or stop at a shipped default.
  Anything else stops the run.
- **Coverage.** The run fails if an outcome is left unexercised (above).

A face that disagrees with a generated case has found a defect in the face or the oracle, and
the spec page decides which. When all four faces disagree with the oracle, suspect the oracle
first. Either way the oracle is never changed to match a face without the spec saying so. A
fix to the oracle comes with a committed vector that pins the case.

## It is verified to fail

Before this landed, a corpus with three expectations corrupted per profile (a refusal's span,
a write-only output, an accepted read's value) failed in every face: Go 6 failing cases, Rust
and TypeScript 8 failures, Python 8 failing subtests.

A local sweep of 10 seeds × 10,000 cases per profile (100,000 per profile, 200,000 per face)
found no divergence between any face and the oracle.
