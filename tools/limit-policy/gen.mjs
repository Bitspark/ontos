#!/usr/bin/env node
/*
 * limit-policy gen: the seeded generator behind the two generated limit-policy tests
 * (Bitspark/ontos#13, docs/design/0009-generated-limit-policy-tests.md,
 * docs/spec/ontos-codec.md §4.2 Testing).
 *
 * It writes one corpus with two sections, and each face's own limits test replays both
 * through the library decoder:
 *
 *   differential  AGREEMENT-ZONE cases. A small valid encoding, exactly one bound
 *                 lowered to a stated value, and every other bound either absent (the
 *                 shipped default) or explicitly at least what the value needs. Inside
 *                 that zone the outcome is a function of the input and the settings
 *                 alone: accept when the lowered bound is at least the value's need for
 *                 it, otherwise limit_exceeded with that bound's kind. No byte-contract
 *                 code can fire (the input is valid), no other bound can (each is at or
 *                 above its need), and native_width cannot (every length and arity is
 *                 tiny next to the narrowest native width, 2^31 - 1 on a 32-bit Go
 *                 build). So each case carries ONE expectation, and every face must
 *                 produce it. Faces that all produce the expectation agree.
 *
 *   metamorphic   VALUES only, with no settings and no expectation. Each face derives
 *                 its own checks: decode under the shipped defaults (which must accept),
 *                 measure the decoded value's depth, largest atom and largest arity, then
 *                 lower exactly one bound below that need and expect that bound's kind,
 *                 and set every bound to exactly its need and expect acceptance. The
 *                 expectation comes from the face's own acceptance, never from this file.
 *
 * Every input is a valid canonical encoding. Malformed inputs are deliberately absent: on
 * one of those, loosening a limit can correctly reveal a later normative rejection, so a
 * kind is not a function of the settings there (§4.2, "Observational, not portable").
 *
 * SEEDED AND DETERMINISTIC. The corpus is a pure function of the seed and the two counts.
 * With no arguments the generator writes vectors/codec-limits.generated.json from the
 * pinned seed, and `scripts/check.sh vectors` asserts that the committed file has not
 * drifted from that. `--seed fresh` derives a seed from $GITHUB_SHA when set, else from
 * the clock, which `scripts/check.sh fuzz` uses to replay a new corpus through the same
 * four tests on every commit. The effective seed is always printed.
 *
 * SELF-CHECKED. The generator builds a value tree, encodes it, and computes its needs from
 * the tree. Then it reads the bytes back with an independent reader, recomputes the needs
 * from the bytes, and refuses to write a case whose two derivations disagree, whose bytes
 * are not fully consumed, or whose settings leave the agreement zone.
 *
 * CLI:
 *   node tools/limit-policy/gen.mjs [--seed <u64>|fresh] [--differential <N>]
 *                                   [--metamorphic <N>] [--out <path>|-]
 *
 * Dependency-free Node ESM (node: builtins only), like tools/fuzz/gen.mjs.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "..", "vectors", "codec-limits.generated.json");

// The pinned seed of the committed corpus (13, after the issue). Changing it, or either
// default count, regenerates the whole file.
const PINNED_SEED = 13n;
const DEFAULT_DIFFERENTIAL = 384;
const DEFAULT_METAMORPHIC = 128;

// The shipped depth default every face uses (§4.1 invariant 1). Atom bytes and tuple
// arity are unbounded by default.
const DEFAULT_MAX_DEPTH = 1024;

// The largest explicit bound written to the corpus. Every face holds it exactly: a Go int
// on a 32-bit build, a Rust usize on wasm32, a JS number, a Python int.
const MAX_EXPLICIT_BOUND = 2 ** 31 - 1;

// A differential input is "small": it stays far inside every face's native width and
// keeps the committed file reviewable.
const MAX_DIFFERENTIAL_BYTES = 1024;

/** The three bounds of the zone, in the order the faces report them. */
const BOUNDS = [
  { key: "maxDepth", need: "depth", kind: "decode_depth" },
  { key: "maxAtomBytes", need: "atom", kind: "atom_bytes" },
  { key: "maxTupleArity", need: "arity", kind: "tuple_arity" },
];

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Deterministic PRNG: the same 64-bit LCG as tools/fuzz/gen.mjs and
// codec/go/fuzz_test.go (Knuth's MMIX multiplier, an odd increment), drawn from the
// high bits. BigInt arithmetic, since a JS number cannot hold a u64.
// ---------------------------------------------------------------------------

const U64_MASK = (1n << 64n) - 1n;
const LCG_MUL = 6364136223846793005n;
const LCG_INC = 1442695040888963407n;

class Lcg {
  constructor(seed) {
    this.state = BigInt.asUintN(64, seed);
  }
  next() {
    this.state = (this.state * LCG_MUL + LCG_INC) & U64_MASK;
    return this.state;
  }
  /** An integer in [0, n); 0 when n <= 1. */
  uintn(n) {
    if (n <= 1) return 0;
    return Number((this.next() >> 33n) % BigInt(n));
  }
  /** An integer in [lo, hi]. */
  between(lo, hi) {
    return lo + this.uintn(hi - lo + 1);
  }
  byteVal() {
    return Number((this.next() >> 56n) & 0xffn);
  }
  bytes(n) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) b[i] = this.byteVal();
    return b;
  }
}

// ---------------------------------------------------------------------------
// Values and their encoding (ontos-codec.md §2-§3), reimplemented here so that the
// generator depends on no face. A value is { atom: Uint8Array } | { tuple: Value[] }.
// ---------------------------------------------------------------------------

const atom = (bytes) => ({ atom: bytes });
const tuple = (items) => ({ tuple: items });

function uvarint(n, out) {
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
}

/** Pre-order with an explicit stack, so a 1024-deep spine needs no deep JS stack. */
function encode(value) {
  const out = [];
  const stack = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v.atom !== undefined) {
      out.push(0x00);
      uvarint(v.atom.length, out);
      for (const b of v.atom) out.push(b);
    } else {
      out.push(0x01);
      uvarint(v.tuple.length, out);
      for (let i = v.tuple.length - 1; i >= 0; i -= 1) stack.push(v.tuple[i]);
    }
  }
  return Uint8Array.from(out);
}

/**
 * What a value needs from each bound: its depth (the root at 0, as the decoder counts
 * it), its longest atom and its widest tuple, each 0 when the value has none.
 */
function needsOfTree(value) {
  const needs = { depth: 0, atom: 0, arity: 0 };
  const stack = [[value, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop();
    needs.depth = Math.max(needs.depth, depth);
    if (v.atom !== undefined) {
      needs.atom = Math.max(needs.atom, v.atom.length);
    } else {
      needs.arity = Math.max(needs.arity, v.tuple.length);
      for (const child of v.tuple) stack.push([child, depth + 1]);
    }
  }
  return needs;
}

/**
 * The independent derivation: read the bytes as a decoder would, with no limits, and
 * compute the same needs from them. Throws when the bytes are not exactly one canonical
 * value, which would mean the encoder above is wrong.
 */
function needsOfBytes(bytes) {
  let pos = 0;
  const readUvarint = () => {
    let value = 0;
    let scale = 1;
    for (let i = 0; ; i += 1) {
      if (pos >= bytes.length) throw new Error("self-check: uvarint runs past the end");
      const b = bytes[pos];
      pos += 1;
      value += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) {
        if (i > 0 && b === 0) throw new Error("self-check: non-canonical uvarint");
        return value;
      }
      scale *= 128;
      if (i >= 4) throw new Error("self-check: a uvarint this generator never writes");
    }
  };
  const needs = { depth: 0, atom: 0, arity: 0 };
  // The number of values still to read at each open depth.
  const pending = [1];
  while (pending.length > 0) {
    if (pending[pending.length - 1] === 0) {
      pending.pop();
      continue;
    }
    pending[pending.length - 1] -= 1;
    const depth = pending.length - 1;
    needs.depth = Math.max(needs.depth, depth);
    if (pos >= bytes.length) throw new Error("self-check: a value runs past the end");
    const tag = bytes[pos];
    pos += 1;
    const n = readUvarint();
    if (tag === 0x00) {
      needs.atom = Math.max(needs.atom, n);
      pos += n;
      if (pos > bytes.length) throw new Error("self-check: an atom runs past the end");
    } else if (tag === 0x01) {
      needs.arity = Math.max(needs.arity, n);
      pending.push(n);
    } else {
      throw new Error(`self-check: unknown tag ${tag}`);
    }
  }
  if (pos !== bytes.length) throw new Error("self-check: trailing bytes");
  return needs;
}

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// ---------------------------------------------------------------------------
// Shapes. Each class stresses one way a need gets large; all stay valid.
// ---------------------------------------------------------------------------

/** A random tree, bounded in depth, arity, atom length and node count. */
function randTree(rng, shape, depth = shape.depth, budget = { n: shape.nodes }) {
  budget.n -= 1;
  if (depth <= 0 || budget.n <= 0 || rng.uintn(5) < 2) {
    return atom(rng.bytes(rng.uintn(shape.atom + 1)));
  }
  const arity = rng.uintn(shape.arity + 1);
  const items = [];
  for (let i = 0; i < arity && budget.n > 0; i += 1) items.push(randTree(rng, shape, depth - 1, budget));
  return tuple(items);
}

const SMALL = { depth: 5, arity: 4, atom: 8, nodes: 24 };
const MEDIUM = { depth: 7, arity: 5, atom: 12, nodes: 40 };
const TINY = { depth: 2, arity: 3, atom: 8, nodes: 8 };

/** `wide` placed among a few tiny siblings, so its need is set by the one wide part. */
function among(rng, wide) {
  const items = [];
  const n = rng.between(0, 3);
  for (let i = 0; i < n; i += 1) items.push(randTree(rng, TINY));
  items.splice(rng.uintn(items.length + 1), 0, wide);
  return tuple(items);
}

/** An atom whose length needs a two-byte uvarint (128..200). */
const wideAtom = (rng) => among(rng, atom(rng.bytes(rng.between(128, 200))));

/** A tuple whose arity needs a two-byte uvarint (128..140), of empty atoms. */
function wideTuple(rng) {
  const n = rng.between(128, 140);
  const items = [];
  for (let i = 0; i < n; i += 1) items.push(atom(new Uint8Array()));
  return among(rng, tuple(items));
}

/** A spine `levels` deep: tuples of arity 1..3 around a tiny tree, siblings tiny atoms. */
function spine(rng, levels) {
  let v = randTree(rng, TINY);
  for (let i = 0; i < levels; i += 1) {
    const items = [];
    const n = rng.between(0, 2);
    for (let j = 0; j < n; j += 1) items.push(atom(rng.bytes(rng.uintn(3))));
    items.splice(rng.uintn(items.length + 1), 0, v);
    v = tuple(items);
  }
  return v;
}

/** A bare chain: `levels` one-item tuples around an atom of up to 4 bytes. */
function chain(rng, levels) {
  let v = atom(rng.bytes(rng.uintn(5)));
  for (let i = 0; i < levels; i += 1) v = tuple([v]);
  return v;
}

/** Pick a class by weight: [[weight, name, build], ...]. */
function pick(rng, classes) {
  const total = classes.reduce((s, [w]) => s + w, 0);
  let r = rng.uintn(total);
  for (const [w, name, build] of classes) {
    if (r < w) return { name, value: build(rng) };
    r -= w;
  }
  throw new Error("unreachable");
}

const DIFFERENTIAL_CLASSES = [
  [76, "tree", (rng) => randTree(rng, SMALL)],
  [8, "wide-atom", wideAtom],
  [6, "wide-tuple", wideTuple],
  [10, "spine", (rng) => spine(rng, rng.between(7, 30))],
];

const METAMORPHIC_CLASSES = [
  [58, "tree", (rng) => randTree(rng, MEDIUM)],
  [10, "wide-atom", wideAtom],
  [8, "wide-tuple", wideTuple],
  [22, "spine", (rng) => spine(rng, rng.between(7, 80))],
  [2, "deep-chain", (rng) => chain(rng, rng.between(900, DEFAULT_MAX_DEPTH))],
];

/** Values every metamorphic corpus starts with, independent of the random stream. */
const METAMORPHIC_EDGES = [
  ["edge-empty-atom", atom(new Uint8Array())],
  ["edge-empty-tuple", tuple([])],
  ["edge-one-byte-atom", atom(Uint8Array.of(0x61))],
  ["edge-atom-127", atom(new Uint8Array(127))],
  ["edge-atom-128", atom(new Uint8Array(128))],
  ["edge-arity-128", tuple(Array.from({ length: 128 }, () => atom(new Uint8Array())))],
  ["edge-chain-1024", (() => {
    let v = atom(new Uint8Array());
    for (let i = 0; i < DEFAULT_MAX_DEPTH; i += 1) v = tuple([v]);
    return v;
  })()],
];

// ---------------------------------------------------------------------------
// The two sections
// ---------------------------------------------------------------------------

/** A built value with its bytes and needs, both derivations checked against each other. */
function realize(value) {
  const bytes = encode(value);
  const fromTree = needsOfTree(value);
  const fromBytes = needsOfBytes(bytes);
  for (const k of ["depth", "atom", "arity"]) {
    if (fromTree[k] !== fromBytes[k]) {
      throw new Error(`self-check: ${k} need ${fromTree[k]} from the tree, ${fromBytes[k]} from the bytes`);
    }
  }
  return { bytes, hex: toHex(bytes), needs: fromTree };
}

/** The lowered bound's value: below, at or above the need, weighted toward the boundary. */
function chooseLowered(rng, need) {
  const r = rng.uintn(100);
  if (need === 0) return r < 50 ? 0 : rng.between(1, 4);
  if (r < 30) return need - 1;
  if (r < 55) return need;
  if (r < 75) return rng.uintn(need);
  if (r < 90) return need + rng.between(1, 4);
  return 0;
}

/** Another bound's value: absent (the default), exactly the need, or above it. */
function chooseOther(rng, need) {
  const r = rng.uintn(10);
  if (r < 4) return undefined;
  if (r < 7) return need;
  return need + rng.between(1, 1000);
}

/** The zone's rule, stated once. */
function expectation(bound, lowered, need) {
  return lowered >= need ? "accept" : { code: "limit_exceeded", limitKind: bound.kind };
}

/** Refuse a case whose settings leave the agreement zone. */
function assertInZone(c, needs) {
  if (c.bytes.length > MAX_DIFFERENTIAL_BYTES) throw new Error(`${c.name}: ${c.bytes.length} bytes is not small`);
  for (const b of BOUNDS) {
    const set = c.limits[b.key];
    if (set !== undefined && (!Number.isInteger(set) || set < 0 || set > MAX_EXPLICIT_BOUND)) {
      throw new Error(`${c.name}: ${b.key}=${set} is not a bound every face holds`);
    }
    if (b.key === c.lowered) continue;
    const effective = set ?? (b.key === "maxDepth" ? DEFAULT_MAX_DEPTH : Infinity);
    if (effective < needs[b.need]) throw new Error(`${c.name}: ${b.key} interferes (${effective} < ${needs[b.need]})`);
  }
}

function buildDifferential(rng, count) {
  const cases = [];
  for (let i = 0; i < count; i += 1) {
    const { name: cls, value } = pick(rng, DIFFERENTIAL_CLASSES);
    const { bytes, hex, needs } = realize(value);
    // Mostly a bound the value actually needs, since a need of 0 can only accept.
    const needed = BOUNDS.filter((b) => needs[b.need] >= 1);
    const from = needed.length > 0 && rng.uintn(5) > 0 ? needed : BOUNDS;
    const bound = from[rng.uintn(from.length)];
    const need = needs[bound.need];
    const lowered = chooseLowered(rng, need);
    const limits = {};
    for (const b of BOUNDS) {
      const v = b === bound ? lowered : chooseOther(rng, needs[b.need]);
      if (v !== undefined) limits[b.key] = v;
    }
    const c = {
      name: `d${i}-${cls}`,
      hex,
      lowered: bound.key,
      limits,
      expect: expectation(bound, lowered, need),
    };
    assertInZone({ ...c, bytes }, needs);
    cases.push(c);
  }
  return cases;
}

function buildMetamorphic(rng, count) {
  const values = [];
  for (const [name, value] of METAMORPHIC_EDGES) {
    if (values.length < count) values.push({ name, ...realize(value) });
  }
  for (let i = values.length; i < count; i += 1) {
    const { name: cls, value } = pick(rng, METAMORPHIC_CLASSES);
    values.push({ name: `m${i}-${cls}`, ...realize(value) });
  }
  for (const v of values) {
    // The faces decode these under their shipped defaults, which must accept them.
    if (v.needs.depth > DEFAULT_MAX_DEPTH) throw new Error(`${v.name}: deeper than the default depth`);
  }
  return values.map(({ name, hex }) => ({ name, hex }));
}

/**
 * Positive controls: a corpus that never rejects, or never exercises a kind, would pass
 * every face while testing nothing. Refuse to write one.
 */
function assertCoverage(differential, metamorphicValues) {
  const seen = new Map([["accept", 0], ...BOUNDS.map((b) => [b.kind, 0])]);
  for (const c of differential) {
    const k = c.expect === "accept" ? "accept" : c.expect.limitKind;
    seen.set(k, seen.get(k) + 1);
  }
  for (const [k, n] of seen) {
    if (n === 0) throw new Error(`coverage: no differential case expects ${k}; raise --differential`);
  }
  for (const b of BOUNDS) {
    const lowerable = metamorphicValues.filter((v) => needsOfBytes(fromHex(v.hex))[b.need] >= 1).length;
    if (lowerable === 0) throw new Error(`coverage: no metamorphic value needs ${b.key} >= 1; raise --metamorphic`);
  }
  return seen;
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Seeds and arguments
// ---------------------------------------------------------------------------

function parseSeed(token) {
  let v;
  try {
    v = BigInt(token.trim());
  } catch {
    throw new UsageError(`--seed must be a u64 (decimal or 0x-hex) or "fresh", got ${JSON.stringify(token)}`);
  }
  if (v < 0n || v > U64_MASK) throw new UsageError(`--seed must be in [0, 2^64), got ${token}`);
  return v;
}

/** FNV-1a (64-bit), as tools/fuzz/gen.mjs folds $GITHUB_SHA into a seed. */
function fnv1a64(str) {
  let h = 14695981039346656037n;
  for (let i = 0; i < str.length; i += 1) {
    h ^= BigInt(str.charCodeAt(i) & 0xff);
    h = (h * 1099511628211n) & U64_MASK;
  }
  return h;
}

function freshSeed() {
  const sha = (process.env.GITHUB_SHA ?? "").trim();
  if (sha) return { seed: fnv1a64(`limit-policy:${sha}`), source: `GITHUB_SHA=${sha}` };
  const t = BigInt(Date.now()) ^ (BigInt(process.pid) << 32n);
  return { seed: BigInt.asUintN(64, t), source: "time+pid" };
}

function parseCount(flag, token) {
  const n = Number(token);
  if (!Number.isInteger(n) || n <= 0 || n > 100000) throw new UsageError(`${flag} must be an integer in [1, 100000]`);
  return n;
}

function parseArgs(argv) {
  const config = {
    seed: PINNED_SEED,
    seedSource: "pinned",
    differential: DEFAULT_DIFFERENTIAL,
    metamorphic: DEFAULT_METAMORPHIC,
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--seed") {
      const token = value();
      if (token === "fresh") {
        Object.assign(config, freshSeed());
        config.seedSource = config.source;
        delete config.source;
      } else {
        config.seed = parseSeed(token);
        config.seedSource = "--seed";
      }
    } else if (arg === "--differential") {
      config.differential = parseCount(arg, value());
    } else if (arg === "--metamorphic") {
      config.metamorphic = parseCount(arg, value());
    } else if (arg === "--out") {
      config.out = value();
    } else if (arg === "-h" || arg === "--help") {
      process.stderr.write(USAGE);
      process.exit(0);
    } else {
      throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  return config;
}

const USAGE =
  "usage: node tools/limit-policy/gen.mjs [--seed <u64>|fresh] [--differential <N>] [--metamorphic <N>] [--out <path>|-]\n";

// ---------------------------------------------------------------------------
// Output: one case per line, so a regenerated corpus diffs case by case.
// ---------------------------------------------------------------------------

function render(meta, differential, metamorphic) {
  const lines = ["{"];
  for (const [k, v] of Object.entries(meta)) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const section = (key, rows, last) => {
    lines.push(`  ${JSON.stringify(key)}: [`);
    rows.forEach((r, i) => lines.push(`    ${JSON.stringify(r)}${i + 1 < rows.length ? "," : ""}`));
    lines.push(`  ]${last ? "" : ","}`);
  };
  section("differential", differential, false);
  section("metamorphic", metamorphic, true);
  lines.push("}");
  return lines.join("\n") + "\n";
}

function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`limit-policy gen: usage error: ${err.message}\n${USAGE}`);
      process.exit(2);
    }
    throw err;
  }
  const seedHex = `0x${config.seed.toString(16).padStart(16, "0")}`;
  process.stderr.write(
    `limit-policy gen: SEED=${seedHex} source=${config.seedSource} ` +
      `differential=${config.differential} metamorphic=${config.metamorphic}\n`,
  );

  // One stream per section, so changing one count leaves the other section unchanged.
  const differential = buildDifferential(new Lcg(config.seed), config.differential);
  const metamorphic = buildMetamorphic(new Lcg(config.seed ^ 0x6d6574616d6f7270n), config.metamorphic);
  const seen = assertCoverage(differential, metamorphic);

  const meta = {
    codec: "ontos-codec-v1",
    description:
      "GENERATED by tools/limit-policy/gen.mjs; do not edit, regenerate (docs/design/0009, ontos-codec.md §4.2 Testing). " +
      "Every hex is a valid canonical encoding. `differential`: agreement-zone cases in codec-limits.json's shape plus `lowered`, " +
      "the one bound set to test the value's need; every other bound is absent (the shipped default) or at least the value's need, " +
      "so every face MUST produce `expect`: \"accept\" when the lowered bound is at least the need, else limit_exceeded with that bound's kind. " +
      "`metamorphic`: values only. Each face decodes one under its defaults (must accept), measures its depth, longest atom and widest tuple, " +
      "then expects acceptance with every bound at exactly its need, and that bound's kind with one bound lowered below its need " +
      "(to need - 1 and to 0, the others at their defaults or at their needs). native_width is outside the zone.",
    generator: "tools/limit-policy/gen.mjs",
    seed: seedHex,
    counts: { differential: differential.length, metamorphic: metamorphic.length },
  };
  const json = render(meta, differential, metamorphic);
  const summary =
    `${differential.length} differential (` +
    [...seen].map(([k, n]) => `${k} ${n}`).join(", ") +
    `), ${metamorphic.length} metamorphic`;
  if (config.out === "-") {
    process.stdout.write(json);
  } else {
    writeFileSync(config.out, json);
  }
  process.stderr.write(`limit-policy gen: ${summary} -> ${config.out === "-" ? "stdout" : config.out}\n`);
}

main();
