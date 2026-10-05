# DESIGN.md — the poster's identity

Companion to [SEAM.md](SEAM.md). SEAM.md fixes what is true; this fixes how it looks, and
why. A refinement run keeps this identity and improves inside it. Citations below point into
this repository's tree; the full evidence is in SEAM.md.

---

## Primary reader

**A consumer** — an engineer in another repository deciding whether to depend on ontos, and
then attaching to it from a public registry. Not a contributor, and not an operator: there is
nothing to deploy and nothing to run in production here.

Secondary readers are served **after** the consumer's questions are answered, never in
competition with them:

- a **contributor** gets §07 (how conformance is enforced, and how to add an implementation)
  and §09 (the spec map);
- a **sceptic** gets §03's verbatim transcript, §05's three runs and §08's non-goals, which are
  the fastest way to decide ontos is the *wrong* dependency.

The test this keeps failing safely: no fact whose only audience is a contributor appears
above §05.

## Plain-language proposition

> A value model with two constructors and one canonical spelling per value.

And the differentiator, in one more sentence:

> Its public surface is not an API — it is a byte string, produced identically by four
> independent implementations, because the layers above sign and hash those exact bytes.

Both are in the first viewport, in the standfirst, before any count, path, or status line.

## Reading passes

| pass | what the reader must come away with | carried by |
|---|---|---|
| **5 seconds** | ontos is a value model whose public surface is a byte string, not an API. | wordmark · standfirst · the `ONTOS-CODEC-V1 · FROZEN` stamp |
| **30 seconds** | The seam is two tags, length-prefixed; four peers must produce identical bytes because arche signs and logos hashes them; the mapping is frozen; and it installs from npmjs, crates.io and the Go proxy with no credential. | the masthead install block · §00 lede + Fig. 1 · §02 lede + Fig. 2 |
| **5 minutes** | One value decomposed to its ten octets, a verbatim transcript, three consumer programs that print those same octets, the rules that bind (exit codes, rejection codes, producer admission, one ontos per Rust graph), what ontos refuses, and where to go. | §03 · §05 · §06 · §08 · §09 |

## Content budget

- **One central claim** — the seam is a byte string, and it has exactly one spelling.
- **Five supporting claims** — closed tag set · frozen mapping · L2 adds readings and no
  equality · the differential harness compares bytes *and* exit codes · four peers, no
  reference implementation.
- **One primary attachment path** — the public registries, one release number (masthead and
  §05). Alternatives (the CLI from the Go module, a new `--impl`) are visibly subordinate in
  §09's second column.
- **One minimal complete interaction** — §03's transcript (authoring notation in, canonical
  bytes out, evidence, digest), and its consumer-side twin in §05: three languages, one call
  each, the same ten octets.
- **Rules/boundaries** — the trust-critical rows in SEAM.md §11.
- **Two next actions** — use it, or check it (§09).

Displaced deliberately: the per-language symbol tables (one grouped five-row surface), the
vector corpus (counts and the pinning mechanism only), the release machinery, the bridge's
`P`/`R` semantics, and every maintainer-workflow fact.

## Storyboard

| Beat | Reader question | One-sentence answer | Evidence | Representation | Priority |
|---|---|---|---|---|---|
| Masthead | What is this, and how do I get it? | A value model with two constructors and one canonical spelling per value — on three public registries. | `ontos-core.md:24-27`, `ontos-codec.md:48-51`, `README.md:109-113` | wordmark + standfirst + stamp + install block | must |
| §00 | What crosses the boundary? | Bytes — and four peers must produce the same ones because arche signs and logos hashes them. | `ontos-codec.md:27-39` | **Fig. 1**, radial seam, each door labelled with its registry | must |
| §01 | What is a value? | `Atom \| Tuple`, structural identity, nothing else. | `ontos-core.md:39-43,91-100` | formal block + two rule columns + grouped API table | must |
| §02 | What exactly are the bytes? | Two tags, length-prefixed, shortest form — and it is frozen. | `ontos-codec.md:48-71,277-282` | **Fig. 2** field diagram + **Fig. 3** tag space | must |
| §03 | Show me one. | `int(0)` is ten octets, and here is the tool saying so, and their digest. | run transcript | **Fig. 4** + verbatim console | must |
| §04 | What can I say with it? | Eight registered readings, and not one new equality. | `ontos-data.md:93-97,271-275` | label register + run byte table | must |
| §05 | How do I attach? | Any of three registries, no credential, one number; each lane's own code emits the same ten octets. | `distribution.md:3-13`, three anonymous runs | three run columns ending in byte tapes + dependency matrix | must |
| §06 | What does the tool do? | Bytes in, evidence out — and the exit code is contract. | `ontos-cli.md:121-132,217-225` | **Fig. 5** process seam + command table | should |
| §07 | Why should I believe the parity claim? | Because it is a check that fails, over a pinned corpus, on stdout *and* exit code. | `tools/conformance/run.mjs:15-46` | three modes + corpus table + maturity ladder | should |
| §08 | What does it refuse? | Truth, authority, time, schema, arithmetic, float, a second no-value. | `README.md:60-66`, `ontos-core.md:182-192`, `ontos-data.md:755-763` | two columns of hollow-marked exclusions | must |
| §09 | What now? | Use it, or check it — and the specs are the truth. | `CONTRIBUTING.md:59-63` | two routing columns + linked spec map | must |

---

## Thesis

**ontos is a value model whose entire public surface is a two-tag, length-prefixed byte
string that four independent implementations are forbidden to spell differently — because
the layers above sign and hash those exact bytes.**

Not "a foundational data model library." The specific, checkable thing: two tags, one
canonical spelling per value, four peers, no reference implementation.

---

## Direction

**Datasheet — the byte-layout specification sheet.**

Derived from the subject: a repository whose deliverable *is* a byte layout should look like
the sheet that specifies one. The idiom: offset rulers, field boxes drawn at their literal
byte width, hex set as hex, hairline rules, small-caps section marks, generous measurement
and no ornament.

It is deliberately **not** the technical-drawing/blueprint direction, which measures
*space*. This measures *bytes*, and the ruler is an offset ruler.

Rejected when the identity was first chosen, and still rejected: a *parts catalogue* of the
four language faces (it would make the languages the subject, when the subject is the one
byte string they agree on), and a *terminal/teletype* sheet built around the CLI (the CLI is
deliberately unpublished; making it the frame would put the subordinate door first).

---

## Derivation

Each line: *because <fact from SEAM.md>, therefore <decision>*.

1. **Because the entire public seam is a two-tag, length-prefixed byte string**
   (`docs/spec/ontos-codec.md:48-51`), **therefore** the page is a byte-layout datasheet:
   field diagrams drawn at literal byte widths, offset rulers under them, and hex rendered as
   hex rather than described in prose.

2. **Because the byte mapping is frozen and immutable — a change ships as `ontos-codec-v2`,
   never an edit to v1** (`docs/spec/ontos-codec.md:277-282`), **therefore** the single
   accent colour appears *only* as a stamped seal on frozen/normative facts. It reads as an
   impression pressed into the sheet, never as decoration.

3. **Because the repository's source of truth is a specification, not code** ("When code and
   specification disagree, the specification is right", `CONTRIBUTING.md:59-63`;
   `docs/spec/ontos-cli.md:3-6`), **therefore** prose is set in an old-style document serif,
   not a UI sans. The page should read as a standards sheet that happens to describe
   software.

4. **Because the tag set is CLOSED at `{0x00, 0x01}` with `0x02`–`0xFF` reserved**
   (`docs/spec/ontos-codec.md:61-71`), **therefore** one figure is a literal 256-cell
   tag-space map with two cells lit. The negative space *is* the argument.

5. **Because there are four peer implementations and no reference one**
   (`docs/spec/ontos-conformance.md:26-38`), **therefore** the seam figure is radially
   symmetric — four doors equidistant around one byte string — rather than a hierarchy with a
   primary at the top.

6. **Because `Atom("") ≠ Tuple()` and the two constructors are disjoint**
   (`docs/spec/ontos-core.md:98-105`), **therefore** atom and tuple are distinguished by
   *fill and literal label* — solid vs. hollow, `0x00` vs. `0x01` — never by hue alone.

7. **Because a value's canonical bytes are what get signed and hashed**
   (`docs/spec/ontos-codec.md:27-31`), **therefore** the worked example is drawn, not
   printed: `int(0)` decomposed byte-by-byte with each octet tied by a leader to the part of
   the tree it encodes.

8. **Because each language attaches from its own public registry, with one release number
   and no credential** (`docs/distribution.md:3-17`), and the claim the attachment must
   honour is that every door yields the same bytes, **therefore** §05 is three run columns
   that each end in the *same* byte tape, set on one line — the datasheet's own tape notation
   used as the attachment's acceptance test, rather than a table of coordinates.

---

## System

### Type — exactly two faces

| role | stack |
|---|---|
| **prose, headings** | `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Charter, Cambria, Georgia, serif` |
| **all byte/field/code content** | `"Cascadia Mono", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace` |

Both resolve offline from fonts present on Windows / macOS / Linux. No webfont, no embedded
font — the page carries no font payload at all. Small caps (`letter-spacing` + uppercase on
the monospace) mark section labels and figure captions; that is a treatment, not a third
typeface.

### Colour — five, no more

| token | hex | role |
|---|---|---|
| `--stock` | `#f3f0e7` | the sheet. Warm spec-paper, not white. |
| `--ink` | `#16150f` | text, field outlines, filled Atom cells. |
| `--rule` | `#b8b09a` | hairlines, offset rulers, reserved cells, secondary text. |
| `--wash` | `#e6e1d1` | field fills, table banding, figure grounds. |
| `--seal` | `#8f2e1d` | **the accent.** Oxide red. Its two roles are below. Nothing else, ever. |

The page commits to one deliberate look (a printed sheet); it does not theme-swap.
Background and text are painted explicitly.

**`--seal` has exactly two roles, and no third one may be added:**

1. *The stamp* — frozen / normative facts: the masthead stamp, the two live cells in the tag
   map, the `$` shell prompts, and the language headings of the §05 attach columns.
2. *Structural numbering* — section numbers (`§00`…) and figure numbers, plus the emphasis
   underline under a keyed term.

Never a fill, never a background, never body text.

### Grid — the module is a byte

One page module = 36px; one byte cell in a figure = 72 units = two modules. Figures are
authored in a 1080-unit viewBox; every figure's geometry is a multiple of the cell. Body
measure is capped at 1224px; the page is centred with 36px gutters, 20px below 560px. The
§05 tapes are the Fig. 4 tape at half scale (36-unit cells), capped at 330px so all three
render at one size.

### Shape language

- **Sharp corners everywhere.** No `border-radius`, anywhere.
- **Hairlines at 1px `--rule`**; emphasis rules at 2px `--ink`. Nothing between.
- **No shadows, no gradients, no glows.** The sheet is flat.
- **Filled vs. hollow is meaningful**: filled = Atom / present / live / depended on; hollow =
  Tuple / structure / reserved / absent. Dashed = not published (the Python face) or outside
  ontos (the deixis column of the dependency matrix).
- Leader lines are 1px, straight, with a terminal arrow or dot.

### Section numbering

Sections are numbered in **hex, as byte offsets** — `§00`, `§01`, … `§09`.

---

## Figures (all hand-authored inline SVG)

| # | figure | carries | narrow variant |
|---|---|---|---|
| 1 | **The seam** | four peer doors radially around one byte string, each labelled with the registry it ships from; consumers (sign / hash) drawing from the bytes. | 2 × 2 faces joined to one spine by equal stubs, then plate, then the consumers stacked. |
| 2 | **The byte layout** | the two encoding rules as field diagrams with offset rulers. | the same fields as a **register map**: offset, field box, meaning. |
| 3 | **The tag space** | 256 cells, 2 lit, 254 reserved. | none needed — a square lattice scales. |
| 4 | **A value, decomposed** | `int(0)` from L0 tree → L2 label → the ten canonical octets. | tree and L2 panel stacked, then a **vertical tape**, one row per octet. |
| 5 | **The tool as a process** | `ontos` as a box: argv / stdin / `--from-json` in; stdout, stderr, exit code out. | the same contract poured down the page. |
| — | **The three emits tapes** (§05, unnumbered) | each lane's printed output, as the Fig. 4 tape. | they stack with their columns. |
| — | **Dependency matrix** (§05) | which package depends on which; the one edge leaving ontos. | scales; drawn at a 380-unit width so its labels stay ≥ 10px on a phone, with its conclusions in prose below rather than in the drawing. |

---

## Responsive plan

One rule behind every breakpoint: **nothing is solved by shrinking type or by letting content
scroll out of sight without saying so.**

| region | ≥ 901px | ≤ 900px | ≤ 560px |
|---|---|---|---|
| **Figs. 1, 2, 4, 5** | landscape plate (1080 units) | separately drawn portrait plate (360 units), capped at 460px | same |
| **masthead install block** | registry label beside its command | same | label above its command |
| **`.attach` (§05)** | three columns, tapes aligned on one line | stacked lanes | same |
| **label register, API table** | tables | one entry per row | same |
| **transcripts, code** | one block per logical line, hanging its own wrap | same | same |
| **package names, flags** | — | never broken inside a token (`.nw`) | paths break only at `/` (`<wbr>`) |

**Hard rule, verified every run:** at 390, 768 and 1440 px and at 200% zoom there is **no
page-level horizontal scroll** and **no element whose `scrollWidth` exceeds its
`clientWidth`**. The page has no wide-table escape hatch.

---

## Identity invariants — what a refinement run must not trade away

1. **The sheet is a byte-layout datasheet**, not a landing page. Offset rulers, field boxes at
   literal byte width, hex set as hex.
2. **Two type roles only** — an old-style serif for prose, one monospace for every byte,
   field, symbol, flag, and path. **No font payload ever ships with this page.**
3. **`--seal` keeps exactly its two roles** (the stamp; structural numbering).
4. **Sharp corners, hairlines, flat.** No radius, no shadow, no gradient, no glow.
5. **Filled vs. hollow is meaningful.** No fact is ever carried by hue alone.
6. **Sections are numbered in hex**, as byte offsets.
7. **Every figure is hand-authored inline SVG** and carries information prose would carry
   worse.
8. **Radial symmetry in the seam figure.** Four peers, no favoured position.
9. **No claim without a `path:line` in SEAM.md.** Byte strings, transcripts *and attachment
   snippets* are run, never transcribed.

Free to change when legibility, semantics, or the reading passes demand it: exact palette
values, type sizes, spacing, breakpoints, section order, and every implementation detail of
the responsive plan above.

---

## Anti-goals for this page

No hero band, no feature cards, no badges, no gradient, no emoji, no rounded corners, no UI
sans, no README section order, no sentence that would survive being moved to a different
repository's poster — and no issue numbers, no internal repository names, roles or agent
names, and no registry or credential set-up that a public consumer does not need.

---

## Refinement log

### 2026-10-05 — reframe for the public repository (at `5482386`, release v0.14.0)

**Classification: reframe.** The identity, thesis and figures held; the facts and the
attachment story did not. The previous edition predates this repository and described
v0.7.0.

**What drifted (truth audit):**

- Release `v0.7.0` → `v0.14.0`, and every attach coordinate → npmjs, crates.io under
  `bitspark-` names with unchanged library names, and the public Go proxy, with no
  credential and no registry configuration.
- `vectors/data.json` grew from 34 to 36 encode cases; `codec-limits.json` (13) and the
  producer corpus count (12) are new.
- The CLI spec's hash pipe (`ontos canon --emit <hex> | sha256sum`) hashes hex text, not the
  octets; the poster now shows `| xxd -r -p | sha256sum`, the tree's own oracle form, with
  the run digest. (SEAM.md §8.)
- The refusal list's owners: the public README no longer names an authority repository or a
  record repository, so those two names left the poster; arche and logos stay, cited to the
  codec spec.
- "ontos is not a serialization format" had no public source; it became "the codec is not
  the model", cited to `docs/spec/ontos-codec.md:3-8`.
- `limit_exceeded` now names the bound that stopped it (since v0.11.0).
- The deixis bridge went from a footnote to an optional, one-way bridge with three published
  faces.

**What changed on the page:**

- The masthead gained the README's install block, so the attachment route is in the 30-second
  pass; the meta row lost the codec id (the stamp already carries it) and gained the license
  and a live repository link.
- Fig. 1's doors are labelled with the registry each ships from; the legend says
  published-on-a-public-registry versus source-only.
- §05 was rebuilt: three columns, each an install, an import and one call, ending in the byte
  tape that call printed when run anonymously against the published packages. The dependency
  matrix gained the deixis bridge row and an *outside ontos* column, and its conclusions moved
  into prose.
- §09 links every spec on GitHub and the three registry pages, and offers the CLI straight
  from the Go module (`go install …@v0.14.0`).
- Repairs found by rendering: transcripts hung only their first line (text-indent applies
  once per block) — every transcript is now one block per logical line; a long heading
  orphaned its `§` number at phone width; package names and flags broke after a hyphen; table
  `th.m` headers rendered at body size.

**What was removed, and why:** every coordinate and registry setting a public consumer does
not need, the access warning that had used the stamp role, issue numbers and internal
repository names (from SEAM.md and DESIGN.md too), the claims cited only to files this tree
does not carry, and two neighbour names with no source in this tree.
