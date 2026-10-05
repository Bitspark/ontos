#!/usr/bin/env node
/*
 * ontos-fuzz-gen — the seeded generative corpus generator for the DIFFERENTIAL
 * fuzz bout across the four `ontos` CLIs (go · rs · ts · py).
 *
 * WHAT THIS IS. The conformance runner (tools/conformance/run.mjs) drives a corpus
 * of vector hexes through every `--impl` and asserts their `--format json|human`
 * output is BYTE-IDENTICAL (docs/spec/ontos-conformance.md). By default that corpus
 * is the FROZEN vectors (vectors/codec.json + vectors/data.json). This tool widens
 * the differential oracle BEYOND the frozen corpus: it emits an EPHEMERAL corpus of
 * arbitrary hexes — valid ontos-codec-v1 encodings, near-valid single-byte mutations
 * of them, and deliberately reject-shaped inputs — in exactly the vectors-file shape
 * the runner's `--vectors` override reads. A generated input that makes any two of
 * the four impls disagree (decode-mode JSON, or human-mode rendering) then fails the
 * bout loudly (ontos-internal#127).
 *
 * WHY A GENERATOR AND NOT A RUNNER CHANGE. The runner is the protocol; its judgment
 * semantics MUST NOT change (a non-goal of ontos-internal#127). The decode/human modes read ONLY
 * each `encode[].hex` (run.mjs `collectHexes`), comparing all impls byte-for-byte —
 * that differential agreement IS the judgment, and it needs no pinned expectation.
 * So this corpus carries only `{ name, hex }` per case: no `value`, because random
 * bytes have no pinned authoring JSON, which is exactly why the from-json oracle mode
 * stays vector-only. The runner is reused UNCHANGED.
 *
 * SEEDED + DETERMINISTIC. The corpus is a pure function of the seed: same seed →
 * byte-identical corpus, so any disagreement is replayable. The seed is printed
 * loudly to stderr (and embedded in the corpus `note`). With no --seed it derives a
 * stable default from $GITHUB_SHA (the commit under test in CI) when present, else a
 * time-based seed; either way the chosen seed is printed so a CI failure can be
 * replayed locally with `--seed <printed>`.
 *
 * THE THREE FAMILIES (mirrors codec/go/fuzz_test.go's strategy, dependency-free):
 *   1. VALID    — encode a randomly built Value tree (atoms of random bytes, tuples
 *                 of bounded arity/depth) with the spec's two-tag, uvarint-prefixed
 *                 encoding (ontos-codec.md §2–§3). All four impls MUST decode it and
 *                 agree; many also recognize an L2 embedding, exercising the data lane.
 *   2. NEAR-VALID — take a valid encoding and flip ONE byte by a non-zero delta.
 *                 Single-byte mutations of canonical bytes land in the decode-success
 *                 branch far more often than uniform-random bytes, stressing agreement
 *                 on inputs with real nested structure (and on the reject paths a
 *                 mutation opens: unknown_tag, non_canonical_uvarint, trailing_bytes…).
 *   3. REJECT-SHAPED — uniform-random byte buffers plus a few structural reject
 *                 literals (bare tag, unknown tag, truncated tuple, non-terminated
 *                 uvarint). Almost all reject; the property is that all four impls
 *                 reject IDENTICALLY (same JSON error object + exit code).
 *
 * CLI:
 *   node tools/fuzz/gen.mjs [--seed <u64>] [--count <N>] [--out <path>]
 *
 *   --seed <u64>   Decimal or 0x-hex unsigned 64-bit seed. Default: derived from
 *                  $GITHUB_SHA if set (stable per commit, so CI reruns reproduce),
 *                  else a time-based seed. The effective seed is ALWAYS printed.
 *   --count <N>    Total number of cases to emit (default 300). Split across the three
 *                  families in fixed proportions so the mix is stable per seed.
 *   --out <path>   Write the corpus JSON to <path>. Default: stdout (so it can be
 *                  piped to a temp file the runner then reads via --vectors).
 *
 * This is dependency-free maintainer tooling (node: builtins only, no new deps),
 * matching tools/conformance/run.mjs + tools/vector/gen.mjs house style. The corpus
 * is EPHEMERAL — never committed; it is generated, consumed by the runner, discarded.
 */

import { writeFileSync } from "node:fs";

// --- usage error -------------------------------------------------------------
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Deterministic PRNG: a 64-bit linear congruential generator, no imports. Same
// constants as codec/go/fuzz_test.go's lcg (Knuth's MMIX multiplier + odd
// increment) so the families read the same way across the two harnesses. All
// arithmetic is in BigInt masked to 64 bits — JS Numbers cannot hold u64.
// ---------------------------------------------------------------------------

const U64_MASK = (1n << 64n) - 1n;
const LCG_MUL = 6364136223846793005n;
const LCG_INC = 1442695040888963407n;

class Lcg {
  constructor(seed) {
    this.state = BigInt.asUintN(64, seed);
  }

  // Advance and return the next 64-bit state (BigInt in [0, 2^64)).
  next() {
    this.state = (this.state * LCG_MUL + LCG_INC) & U64_MASK;
    return this.state;
  }

  // uintn returns an integer in [0, n). n must be > 0. Uses the high bits (an LCG's
  // low bits are poorly distributed), matching the Go helper.
  uintn(n) {
    if (n <= 1) return 0;
    return Number((this.next() >> 33n) % BigInt(n));
  }

  // A single random byte (0..255), drawn from the high bits.
  byteVal() {
    return Number((this.next() >> 56n) & 0xffn);
  }

  // randBytes builds a byte array of length [0, maxLen].
  randBytes(maxLen) {
    const n = this.uintn(maxLen + 1);
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) b[i] = this.byteVal();
    return b;
  }
}

// ---------------------------------------------------------------------------
// ontos-codec-v1 encoding (docs/spec/ontos-codec.md §2–§3), independently
// reimplemented here in stdlib so the generator does not depend on any core/codec
// build. uvarint is shortest-form unsigned LEB128; the value domain we emit (small
// lengths/arities) is far inside u64, so plain Number arithmetic is exact.
// ---------------------------------------------------------------------------

const TAG_ATOM = 0x00;
const TAG_TUPLE = 0x01;

// uvarint(n): 7 bits/byte little-endian, high bit set on all but the last. 0 -> [0x00].
function uvarint(n) {
  const out = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

// A value is { atom: Uint8Array } | { tuple: Value[] } — the L0 carrier.
function encodeValue(value, out) {
  if (value.atom !== undefined) {
    out.push(TAG_ATOM, ...uvarint(value.atom.length), ...value.atom);
  } else {
    out.push(TAG_TUPLE, ...uvarint(value.tuple.length));
    for (const child of value.tuple) encodeValue(child, out);
  }
}

function encode(value) {
  const out = [];
  encodeValue(value, out);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Random valid Value trees — atoms of random bytes, tuples of bounded arity,
// bounded depth, total node count capped (mirrors codec/go/fuzz_test.go's P3
// generator so a pathological branch cannot explode).
// ---------------------------------------------------------------------------

const MAX_DEPTH = 6;
const MAX_ARITY = 5;
const MAX_ATOM_LEN = 16;
const MAX_NODES = 64;

function randValue(rng, depth, budget) {
  budget.n -= 1;
  // Force a leaf when out of depth or node budget; ~40% leaves otherwise.
  if (depth <= 0 || budget.n <= 0 || rng.uintn(5) < 2) {
    return { atom: rng.randBytes(MAX_ATOM_LEN) };
  }
  const arity = rng.uintn(MAX_ARITY + 1);
  const items = [];
  for (let i = 0; i < arity && budget.n > 0; i += 1) {
    items.push(randValue(rng, depth - 1, budget));
  }
  return { tuple: items };
}

function buildValue(rng) {
  return randValue(rng, MAX_DEPTH, { n: MAX_NODES });
}

// ---------------------------------------------------------------------------
// hex helpers
// ---------------------------------------------------------------------------

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// A few structural reject literals (mirrors the Go seed corpus' raw edge literals):
// a bare atom tag (truncated), a bare tuple tag, an unknown tag, a tuple claiming a
// child it does not have, a stray trailing byte after a complete value, and a
// non-terminated long uvarint. All MUST reject identically across the four impls.
const REJECT_LITERALS = [
  "00", // atom tag, no length uvarint -> unexpected_eof
  "01", // tuple tag, no arity uvarint -> unexpected_eof
  "0200", // unknown tag 0x02 -> unknown_tag
  "ff", // unknown tag 0xff -> unknown_tag
  "0101", // tuple arity 1, missing the child -> unexpected_eof
  "000100", // atom len 1 with its byte, then a stray 0x00 -> trailing_bytes
  "0180808080", // non-terminated long uvarint -> unexpected_eof
  "008100", // atom length uvarint 0x81 0x00 (non-shortest) -> non_canonical_uvarint
];

// ---------------------------------------------------------------------------
// corpus families
// ---------------------------------------------------------------------------

// VALID: encode a random valid Value tree. Returns a lowercase hex string.
function genValidHex(rng) {
  return toHex(encode(buildValue(rng)));
}

// NEAR-VALID: a valid encoding with exactly one byte flipped by a non-zero delta.
function genNearValidHex(rng) {
  const enc = encode(buildValue(rng));
  const mutated = Uint8Array.from(enc);
  if (mutated.length > 0) {
    const pos = rng.uintn(mutated.length);
    const delta = 1 + rng.uintn(255); // never 0 — guarantee a real change
    mutated[pos] = (mutated[pos] + delta) & 0xff;
  }
  return toHex(mutated);
}

// REJECT-SHAPED: a uniform-random byte buffer (up to 24 bytes). Almost all reject.
function genRejectHex(rng) {
  return toHex(rng.randBytes(24));
}

// Build the full case list for a seed. The mix is fixed proportions of `count` so the
// corpus is stable per seed: ~45% valid, ~35% near-valid, the rest reject-shaped
// (with the structural reject literals prepended so the named error paths always run).
function buildCases(rng, count) {
  const cases = [];
  let i = 0;
  const add = (family, hex) => {
    cases.push({ name: `${family}#${i}`, hex });
    i += 1;
  };

  // Always include the structural reject literals first — named, deterministic shapes
  // that hit each rejection code, independent of the random stream.
  for (let j = 0; j < REJECT_LITERALS.length; j += 1) {
    cases.push({ name: `reject-literal#${j}`, hex: REJECT_LITERALS[j] });
  }

  const nValid = Math.round(count * 0.45);
  const nNear = Math.round(count * 0.35);
  const nReject = Math.max(0, count - nValid - nNear);

  for (let k = 0; k < nValid; k += 1) add("valid", genValidHex(rng));
  for (let k = 0; k < nNear; k += 1) add("near-valid", genNearValidHex(rng));
  for (let k = 0; k < nReject; k += 1) add("reject", genRejectHex(rng));

  return cases;
}

// ---------------------------------------------------------------------------
// seed derivation
// ---------------------------------------------------------------------------

// Parse a --seed token: decimal or 0x-hex, into a u64 BigInt.
function parseSeed(token) {
  const t = token.trim();
  let v;
  try {
    v = t.toLowerCase().startsWith("0x") ? BigInt(t) : BigInt(t);
  } catch {
    throw new UsageError(`--seed must be a u64 (decimal or 0x-hex), got ${JSON.stringify(token)}`);
  }
  if (v < 0n) throw new UsageError(`--seed must be non-negative, got ${JSON.stringify(token)}`);
  return BigInt.asUintN(64, v);
}

// Fold an arbitrary string into a u64 seed with FNV-1a (64-bit). Deterministic and
// dependency-free — used to derive a stable per-commit seed from $GITHUB_SHA.
function fnv1a64(str) {
  let h = 14695981039346656037n; // FNV offset basis
  const prime = 1099511628211n;
  for (let i = 0; i < str.length; i += 1) {
    h ^= BigInt(str.charCodeAt(i) & 0xff);
    h = (h * prime) & U64_MASK;
  }
  return h;
}

// Derive the default seed when --seed is absent: from $GITHUB_SHA when present (so a
// CI rerun on the same commit reproduces the exact corpus), else time-based. Returns
// { seed, source } so the source can be reported.
function deriveDefaultSeed() {
  const sha = process.env.GITHUB_SHA;
  if (sha && sha.trim()) {
    return { seed: fnv1a64(sha.trim()), source: `GITHUB_SHA=${sha.trim()}` };
  }
  const t = BigInt(Date.now()) ^ (BigInt(process.pid) << 32n);
  return { seed: BigInt.asUintN(64, t), source: "time+pid (no --seed, no $GITHUB_SHA)" };
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let seed = null;
  let count = 300;
  let out = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (flag) => {
      if (i + 1 >= argv.length) throw new UsageError(`${flag} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--seed") {
      seed = parseSeed(takeValue("--seed"));
    } else if (arg === "--count") {
      const n = Number(takeValue("--count"));
      if (!Number.isInteger(n) || n <= 0) throw new UsageError("--count must be a positive integer");
      count = n;
    } else if (arg === "--out") {
      out = takeValue("--out");
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }

  return { seed, count, out };
}

function printUsage() {
  process.stderr.write(
    "usage: node tools/fuzz/gen.mjs [--seed <u64>] [--count <N>] [--out <path>]\n",
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`ontos-fuzz-gen: usage error — ${err.message}\n`);
      printUsage();
      process.exit(2);
    }
    throw err;
  }

  let seed = config.seed;
  let seedSource = "--seed";
  if (seed === null) {
    const d = deriveDefaultSeed();
    seed = d.seed;
    seedSource = d.source;
  }

  // Print the effective seed LOUDLY to stderr so any disagreement is replayable with
  // `--seed <printed>`. (stderr keeps stdout pure JSON for piping.)
  const seedHex = `0x${seed.toString(16).padStart(16, "0")}`;
  process.stderr.write(
    `ontos-fuzz-gen: SEED=${seedHex} (${seed.toString(10)}) source=${seedSource} count=${config.count}\n`,
  );

  const rng = new Lcg(seed);
  const cases = buildCases(rng, config.count);

  const corpus = {
    note:
      "EPHEMERAL generative fuzz corpus — do NOT commit. Produced by tools/fuzz/gen.mjs " +
      `with SEED=${seedHex} (source=${seedSource}). Each case carries only { name, hex }: ` +
      "the differential runner (tools/conformance/run.mjs) reads encode[].hex and compares " +
      "all four CLIs (go/rs/ts/py) byte-for-byte in decode + human modes — that agreement IS " +
      "the judgment, so no pinned `value` is needed (and the from-json oracle stays vector-only, " +
      "since random bytes have no pinned hex). Replay a disagreement with --seed " +
      `${seedHex}. Policy: ontos-internal#127.`,
    codec: "ontos-codec-v1",
    generator: "tools/fuzz/gen.mjs",
    seed: seedHex,
    seedSource,
    count: cases.length,
    encode: cases,
  };

  const json = JSON.stringify(corpus, null, 2) + "\n";
  if (config.out) {
    writeFileSync(config.out, json);
    process.stderr.write(`ontos-fuzz-gen: wrote ${cases.length} cases to ${config.out}\n`);
  } else {
    process.stdout.write(json);
  }
}

main();
