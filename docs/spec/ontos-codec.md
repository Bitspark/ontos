# ontos/codec — canonical binary encoding (normative)

**Axis:** `ontos/codec` — a side axis over [`ontos/core`](ontos-core.md), **not** a
higher layer of the value model ([0003](../design/0003-layered-architecture.md),
[0004](../design/0004-repo-layout.md)). It answers exactly one question: **what
are the canonical bytes of an ontos value?** It adds no values and no identity;
`decode ∘ encode = identity`, and `encode` is a *function* (one byte string per
value).

**Status:** **FROZEN as `ontos-codec-v1`** (2026-05-31). The byte mapping in §2–§3
is immutable; any change ships as a *new version* with an explicit migration
(§7). Implemented and differentially vector-pinned across Go/Rust/TS/Python (under
[`codec/`](../../codec/), pinned by [`vectors/codec.json`](../../vectors/codec.json)).
Freezing was safe because the format is a two-tag, length-prefixed, shortest-form
encoding with no undecided design content — the prior `-draft-` status reflected
caution, not an open question.

The keywords MUST, MUST NOT, SHOULD, MAY are used in the IETF sense.

---

## 1. Why this is security-critical

The codec is **not** "just serialization." Two layers above ontos derive security
properties from its canonical-ness:

- **arche signs over ontos encodings** — a signed fact is an Ed25519 signature
  over the canonical bytes of its value. If two cores encode the same value
  differently, a signature verifies in one and fails in another.
- **logos hashes encodings** — proof-DAG leaf citations and clause identity flow
  through the canonical hash of a value.

Therefore:

1. **Four-language (Go/Rust/TS/Python) byte-for-byte agreement is mandatory** —
   it is what makes four independent cores unable to disagree.
2. The codec is **versioned**, and any change to the byte mapping is a **breaking
   change for the entire stack** (every signature and every hash above it),
   gated per §7 — never a silent edit.
3. `encode` MUST be **canonical**: exactly one byte string per value, and a
   decoder MUST reject non-canonical encodings of a value it could otherwise
   accept (§4).

## 2. The encoding

Two value constructors, two tags. `‖` is byte concatenation.

```text
encode(Atom(b))            = 0x00 ‖ uvarint(len(b)) ‖ b
encode(Tuple(v0 … v_{n-1})) = 0x01 ‖ uvarint(n) ‖ encode(v0) ‖ … ‖ encode(v_{n-1})
```

- **`0x00`** — Atom. Followed by the byte length, then the exact bytes.
- **`0x01`** — Tuple. Followed by the arity `n`, then the `n` children encoded in
  order, recursively.

The encoding is **self-delimiting** (length/arity-prefixed): the end of every
value's bytes is determined without a terminator. This makes the byte string
**prefix-free**, which §6 relies on.

### 2.1 The tag set is CLOSED

The complete tag set is `{0x00, 0x01}`. Tag bytes `0x02`–`0xFF` are **reserved**;
a decoder MUST reject them (`unknown_tag`). In particular **there is no variable
tag** — ontos values are ground, ontos has no variable, and the codec cannot
encode one (resolves ontos-internal#2:
ontos/codec is **ground-only**). A consumer that needs to encode logos's `Var`
(e.g. logos's own superset codec) MUST do so in its **own** codec, either by
reframing or by using a tag outside this closed set; it MUST NOT redefine `0x00`
or `0x01`. How logos extends the tag table without renumbering is documented in
logos, not here.

## 3. uvarint — the length/arity encoding

`uvarint` is unsigned LEB128 in **shortest (canonical) form**:

```text
encode: emit 7 bits per byte, little-endian; set the high bit (0x80) on every
        byte except the last. The encoding of 0 is the single byte 0x00.
```

### 3.1 The integer domain is pinned to u64 (the cross-core fix)

A uvarint encodes an unsigned integer in the domain **`[0, 2^64 − 1]`** (64-bit).
This is the normative pin that makes all four cores agree at the extremes (it was
previously unpinned — Rust `usize`, Go `int`, TS 53-bit safe integer all differed,
which is why no `uvarint_overflow` vector could exist).

Consequences, all normative:

- A canonical uvarint is **at most 10 bytes**.
- A decoder MUST reject, as **`uvarint_overflow`**, any uvarint whose value would
  be **≥ 2^64** (more than 10 bytes, or a 10th byte whose high bits exceed the
  64-bit ceiling). This is the cross-core agreement point.
- A decoder MUST reject, as **`non_canonical_uvarint`**, any uvarint that is not
  shortest-form (e.g. a trailing `0x80 0x00` that re-encodes a smaller value).
- **Representation limits are a separate, implementation-local concern.** The
  *encoding domain* is u64, but an implementation whose native length type is
  narrower (e.g. a TS core using `Number`, safe to 2^53−1) MAY reject a uvarint
  that is valid u64 but exceeds its representable/usable length as a **resource
  limit** (§5 of [ontos-core](ontos-core.md); a `limit_exceeded`-class rejection),
  **not** as `uvarint_overflow`. Such limits are documented per implementation and
  are **not** cross-core vector-pinned — two cores with different length ceilings
  do not thereby disagree about *which byte strings are valid encodings*, only
  about which they have resources to materialize.

## 4. Decoding & rejection codes

A decoder reads exactly one value and MUST reject trailing bytes. The stable,
cross-core rejection codes (pinned in [`vectors/codec.json`](../../vectors/codec.json)):

| code | when |
|---|---|
| `unexpected_eof` | input ends mid-value (missing tag, truncated uvarint, atom/child bytes shorter than declared) |
| `unknown_tag` | a tag byte outside `{0x00, 0x01}` (§2.1) |
| `non_canonical_uvarint` | a uvarint not in shortest form (§3) |
| `uvarint_overflow` | a uvarint encoding a value ≥ 2^64 (§3.1) |
| `trailing_bytes` | input has bytes left after one complete value |

The code is **normative**; an implementation's human-readable message is not.
A decoder MAY additionally impose documented resource limits (max atom length,
max arity, max depth, max total size) and reject inputs exceeding them, failing
**safely** (reject; never truncate or partially accept) — these are operational
policy, not part of the byte contract (mirrors [ontos-core §5](ontos-core.md)).

### 4.1 The per-implementation resource limits (documented; non-divergent on valid input)

§3 and the paragraph above make a `limit_exceeded` rejection **implementation-local**:
two cores with different ceilings do not thereby disagree about *which byte strings
are valid encodings* — only about which they have resources to materialize. This
section discharges the "documented per implementation" obligation by stating every
core's defaults in one place, and pins **why those differences can never make one
core accept an encoding another rejects.**

| limit (default) | `go` | `rs` | `ts` | `py` |
|---|---|---|---|---|
| max decode depth | 1024 | 1024 | 1024 | 1024 |
| max atom byte length | unbounded (`maxInt`) | unbounded (`usize::MAX`) | unbounded (`Number.MAX_SAFE_INTEGER`) | unbounded |
| max tuple arity | unbounded (`maxInt`) | unbounded (`usize::MAX`) | unbounded (`Number.MAX_SAFE_INTEGER`) | unbounded |
| uvarint host-width ceiling → `limit_exceeded` | `2^63−1` (`maxInt`) | `usize::MAX` — `2^64−1` on 64-bit, so it **never fires** there; only reachable on a 32-bit target | **`2^53−1`** (`Number.MAX_SAFE_INTEGER`) | none — Python ints are unbounded; the only over-domain code is `uvarint_overflow` (`≥ 2^64`, §3.1) |

Two invariants hold across this table, and together they guarantee the cores never
disagree on **validity**:

1. **The one limit that *could* bite a valid input — `max depth` — is identical
   (1024) in all four cores.** A value is *nested N deep* when its deepest value is at
   depth N, with the root at depth 0, so 1024 tuples around an atom is nested 1024 deep.
   A value nested 1025 deep is rejected as
   `limit_exceeded` by every core; a 1024-deep one is accepted by every core. (A
   consumer may override `maxDepth` per call, but the shipped default is harmonized,
   so the conformance corpus never diverges on depth.)
2. **The differing host-width ceilings cannot bite an input a core can receive.** That
   ceiling applies to a uvarint used as an **atom byte length** or **tuple arity**, and
   every core decodes from one complete, in-memory buffer. No core can be handed a
   buffer longer than its own host-width ceiling: a TS typed array is at most `2^53−1`
   long, a Go slice at most `maxInt` (`2^63−1`, or `2^31−1` on a 32-bit build), and a
   Rust slice at most `isize::MAX`, which is below the 32-bit `usize::MAX` (`2^32−1`). So
   a length or arity past the ceiling declares more content than the buffer holds: the
   field is **over-declared** relative to the bytes that follow. The wider-typed cores
   run out of bytes and reject as `unexpected_eof`, while the narrower core rejects the
   length itself as `limit_exceeded`. The disagreement is therefore confined to inputs
   that are **already truncated in every core**. They differ only on *which* rejection
   code fires, never on whether the input is valid. (The claim is about the buffers a
   core can receive, not about which lengths the format permits: a canonical encoding
   that really contains `2^32` bytes is valid, and a 32-bit core simply cannot be handed
   it.)

This is why the frozen vector corpus (which stays inside the agreement zone) is
byte-for-byte identical across all four cores, while the **generative** differential
fuzz bout — which can mint over-declared/truncated inputs — must exclude
`limit_exceeded` cases from its byte comparison (it is the one code §3/§4 mark as
impl-local; see [`tools/conformance`](../../tools/conformance/) / the differential
fuzz bout).

### 4.2 Operational limit reporting

*Status: ruled 4 October 2026, and implemented in all four cores since v0.11.0
(ontos-internal#360; Rust's 32-bit path executes on
wasm32 since ontos-internal#361). A core older than
v0.11.0 carries no kind, and a consumer handles that as described under **Stability**
below.*

`limit_exceeded` reports that decoding stopped at an operational bound. It does not
establish whether the input is a valid encoding under this codec. This section fixes
how that stop is *reported*, which is an API contract. It does not extend the byte
contract in §2–§3 or the normative code table at the head of §4, and it does not make any limit's
value part of the value model ([ontos-core §5](ontos-core.md)).

**The kind.** A decoder-generated `limit_exceeded` MUST expose a machine-readable
**limit kind** through the implementation's documented error API. The kind MUST name
the bound that is responsible for the reported stop:

| kind | meaning |
|---|---|
| `decode_depth` | The nesting depth of the value about to be read exceeded the effective depth bound (the root is at depth 0). |
| `atom_bytes` | A declared atom byte length exceeded the effective atom-length bound. |
| `tuple_arity` | A declared tuple arity exceeded the effective tuple-arity bound. |
| `native_width` | A valid, canonical uvarint (§3.1) used as a length or arity could not be represented in the implementation's native length type (the host-width ceiling of §4.1). |

The kind is the same whether the bound is a shipped default or a caller's override. An
implementation MUST NOT report a kind for a bound it does not enforce. A core without a
host-width ceiling (Python), or one whose ceiling cannot fire on its target (Rust on a
64-bit target), never reports `native_width`. A failure that is not one of these bounds,
such as an allocation failure, a host recursion limit or an internal fault, MUST NOT be
reported as a limit kind. It is a defect of that implementation, not a bound.

**Observational, not portable.** A kind identifies the check that stopped *this*
decode. Unless a named operational profile says otherwise, implementations are **not**
required to select the same kind for the same input: selection may depend on the
effective settings, on the implementation's native width, and on the order of its
checks. For example, with an atom bound of 10 and an input declaring a `2^60`-byte
atom, a core whose native width holds `2^60` reports `atom_bytes`, while TS reports
`native_width`. A kind also does not imply that other bounds would be satisfied, that
the rest of the input is well formed, or that raising the bound would make decoding
succeed. A consumer MUST NOT treat a kind as validation of the unexamined input, or as
an instruction to retry with larger limits.

**Stability.** Kind identifiers and their meanings are stable. The vocabulary is
append-only: an identifier is never reassigned to a different meaning, but a kind is
not promised to stay reachable. A new kind may be added without changing the parent
code, and adding one is a vocabulary change, reviewed separately from any change to
which bound fires first. An absent or unrecognized kind carries no more than the generic
`limit_exceeded`; a consumer handles it as that, not as malformed input. Only the kind
is required. An implementation MAY also expose the observed value or the bound, but a
consumer MUST NOT rely on those across implementations. Human-readable messages remain
diagnostic.

**The shipped depth default is exact.** Every core ships `max decode depth` = 1024
(§4.1 invariant 1): with default limits, a value nested 1024 deep is accepted, and one
nested 1025 deep is rejected as `limit_exceeded` with kind `decode_depth`. This is a
promise about the shipped default, not a statement that depth 1025 is invalid under
`ontos-codec-v1`.

**Testing.** Limit reporting is tested by a separate operational suite, under explicit
settings stated in each case, never inferred from the host. It is not part of the byte
corpus [`vectors/codec.json`](../../vectors/codec.json), and the command-line tools'
output is unchanged: their `error` field carries the code only (see
[ontos-cli](ontos-cli.md)). The differential fuzz bout's exemption of `limit_exceeded`
covers byte-result **equality** only. A crash, a timeout, or malformed output from any
core is a failure even when another core reports a limit for the same input.

*(Ruled on ontos-internal#341 after the expert
consultation recorded in
`research-docs/0003-typed-decode-limit-kinds-under-an-implementation-local-code.md`.
The four cores' implementation is tracked in
ontos-internal#352, and the fuzz bout's equality-only
exemption in ontos-internal#353.)*

## 5. Canonicality obligations (the contract a conforming codec satisfies)

- **Determinism:** `encode(v)` yields exactly one byte string for a given value.
- **Round-trip:** `decode(encode(v)) = v` for every value `v`.
- **Injectivity:** distinct values encode to distinct bytes (follows from §2 +
  canonical uvarints + tag disjointness).
- **Canonical rejection:** a decoder MUST reject any byte string that is not the
  canonical encoding of some value — specifically non-canonical uvarints and
  trailing bytes — so that "valid encoding" and "canonical encoding" coincide.
  (This is what lets a hash/signature over the bytes stand in for the value.)

## 6. The canonical total order over values (unblocks `map`)

Define **`order(A, B)`** as the lexicographic comparison of `encode(A)` and
`encode(B)` as byte strings. Because the encoding is canonical (one byte string
per value), injective, and prefix-free (§2), this is a **total order** over all
ontos values, deterministic and identical across cores.

This is the order [`ontos/data`'s `map`](../design/0003-layered-architecture.md)
needs: a canonical `map` sorts its entries by key using `order(·,·)`. This is why
**`map` was reserved-until-codec** — the dependency is now satisfied. (Defining
the `map` embedding itself remains an `ontos/data` task; this spec only supplies
the order it stands on.) Note `order` is a codec-derived convenience for higher
layers; it is **not** part of L0 identity, which remains purely structural and
defines no ordering ([ontos-core §3](ontos-core.md)).

## 7. Versioning (frozen)

- The codec id is **`ontos-codec-v1`**, and the byte mapping in §2–§3 is its
  **immutable** normative definition.
- Because signatures (arche) and hashes (logos) are taken over these exact bytes
  (§1), any change to the mapping is a **breaking change for the whole stack** and
  MUST ship as a *new version* (`ontos-codec-v2`) with an explicit migration —
  never as an edit to v1.
- v1 froze the `-draft-v0` mapping unchanged; the only thing v0→v1 settled beyond
  the bytes everyone already produced was the §3.1 u64 domain pin at the
  previously-undefined ≥ 2^64 extreme. No practical value's bytes changed.

## 8. Relationship to the plexis `Nil` drop

The plexis `Pure` carrier had a third sort, `Nil`, with its own tag. ontos has no
`Nil` and no tag for it; the plexis→ontos port maps `Pure::Nil` onto a chosen
ontos convention (likely `Tuple()`) **before** encoding
([0003 migration notes](../design/0003-layered-architecture.md)). The codec
therefore needs no `Nil` tag, consistent with the closed tag set (§2.1).

## 9. Conformance

Pinned by [`vectors/codec.json`](../../vectors/codec.json) (codec id
`ontos-codec-v1`), covering: `uvarint` shortest-form encodings;
`encode`/round-trip for atoms, tuples, empties, and nesting; and `reject` cases
for each code in §4. A conforming codec MUST agree with every vector. As of this
writing the `go`, `rs`, and `ts` codecs under [`codec/`](../../codec/) replay it
green.
