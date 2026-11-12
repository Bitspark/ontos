#!/usr/bin/env node
/*
 * fuzz.mjs — the seeded generator of the JSON projections' differential fuzz.
 *
 * It writes a fresh corpus, <out>/total.json and <out>/readable.json, in the format of the
 * committed vectors (projection/json/vectors/README.md), every expectation computed by the
 * oracle: tools/json-projection/check.mjs, through oracle.mjs. Each face's existing vector
 * replay reads the corpus that ONTOS_JSON_PROJECTION_VECTORS names (a directory), so the four
 * faces judge every generated case exactly as they judge the committed ones. `scripts/check.sh
 * fuzz` runs it on a fresh seed. tools/json-projection/README.md says what it generates and
 * why the expectations can be trusted.
 *
 * SEEDED AND DETERMINISTIC. Case i of a profile is a pure function of the seed, the profile, i
 * and the committed vectors (whose inputs seed the mutations), so a count change keeps the
 * cases both counts share, and `--case readable:17` regenerates one case alone.
 *
 * Run: node tools/json-projection/fuzz.mjs [--seed <u64>|fresh] [--count <N>] [--out <dir>]
 *      node tools/json-projection/fuzz.mjs --seed <u64> --case <total|readable>:<i>
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { CODES, KINDS, b64Encode, bytesToHex, hexToBytes, isAtom, recognize, utf8Fault } from "./check.mjs";
import { OracleDefect, expectRead, expectWrite, jsonDepthOf, measureValue } from "./oracle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, "..", "..", "projection", "json", "vectors");
const PROFILES = { total: "ontos-total-json/1", readable: "ontos-readable-json/1" };
const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const M64 = (1n << 64n) - 1n;
const MAX_SAFE = 9007199254740991n;
/** The largest bound a case sets: every face's bound type holds it, Go's int on GOARCH=386 too. */
const MAX_LIMIT = 2 ** 31 - 1;
/**
 * A case with value_hex keeps its value within depth 1024, the codec decoder's default depth,
 * because the Rust replay decodes value_hex under the decoder's defaults. So no case raises
 * max_value_depth above its default, and no value for the writer is deeper.
 */
const MAX_VALUE_DEPTH = 1024;
/** Origins are pinned when their rows hold at most this many path segments in all. */
const ORIGINS_CAP = 20000;
/**
 * From this count per profile on, every refusal code and limit kind must be exercised: the
 * generator draws further cases (count, count + 1, …) until they are, up to twice the count,
 * and fails if any is still missing. Below it, a missing one is reported only.
 */
const COVERAGE_FLOOR = 1000;
const DEFAULT_COUNT = 2000;

// --- the random stream: xoshiro128**, seeded per case by splitmix64 -------------------

class Rng {
  constructor(seed) {
    let s = BigInt.asUintN(64, seed);
    const words = [];
    for (let i = 0; i < 2; i++) {
      s = (s + 0x9e3779b97f4a7c15n) & M64;
      let z = s;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
      z ^= z >> 31n;
      words.push(Number(z & 0xffffffffn), Number(z >> 32n));
    }
    this.s = Uint32Array.from(words);
    if (this.s.every((w) => w === 0)) this.s[0] = 1;
  }
  u32() {
    const s = this.s;
    const r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return r;
  }
  float() {
    return this.u32() / 4294967296;
  }
  /** An integer in [0, n). */
  below(n) {
    return n <= 1 ? 0 : Math.floor(this.float() * n);
  }
  between(lo, hi) {
    return lo + this.below(hi - lo + 1);
  }
  chance(p) {
    return this.float() < p;
  }
  pick(a) {
    return a[this.below(a.length)];
  }
  /** One value of [[weight, value], …]. */
  weighted(pairs) {
    let total = 0;
    for (const [w] of pairs) total += w;
    let r = this.float() * total;
    for (const [w, v] of pairs) {
      if ((r -= w) < 0) return v;
    }
    return pairs[pairs.length - 1][1];
  }
  bytes(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.u32() & 0xff;
    return out;
  }
  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.below(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

const rotl = (x, k) => (x << k) | (x >>> (32 - k));

function caseSeed(seed, profile, index) {
  const lane = profile === "total" ? 0x746f74616cn : 0x7265616461626c65n;
  return BigInt.asUintN(64, seed ^ lane ^ (BigInt(index + 1) * 0x9e3779b97f4a7c15n));
}

// --- bytes and text -------------------------------------------------------------------

function concat(...parts) {
  const chunks = parts.map((p) => (typeof p === "string" ? te.encode(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const TWO_BYTE = [0x80, 0xa0, 0xe9, 0xdf, 0xff, 0x100, 0x301, 0x3b1, 0x7ff];
const THREE_BYTE = [0x800, 0x20ac, 0x2028, 0x2029, 0x3000, 0x4e2d, 0xd7ff, 0xe000, 0xfeff, 0xfffd, 0xffff];
const FOUR_BYTE = [0x10000, 0x1f600, 0x1f468, 0x2a6d6, 0x10ffff];
const PUNCT = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

function randChar(rng) {
  switch (rng.weighted([[40, 0], [8, 1], [6, 2], [6, 3], [8, 4], [8, 5], [5, 6]])) {
    case 0:
      return String.fromCharCode(rng.between(0x61, 0x7a));
    case 1:
      return String.fromCharCode(rng.between(0x30, 0x39));
    case 2:
      return rng.pick(PUNCT);
    case 3:
      return String.fromCharCode(rng.chance(0.9) ? rng.between(0, 0x1f) : 0x7f);
    case 4:
      return String.fromCodePoint(rng.pick(TWO_BYTE));
    case 5:
      return String.fromCodePoint(rng.pick(THREE_BYTE));
    default:
      return String.fromCodePoint(rng.pick(FOUR_BYTE));
  }
}

function randString(rng, max) {
  if (rng.chance(0.12)) return "";
  let s = "";
  for (let n = rng.between(1, max); n > 0; n--) s += randChar(rng);
  return s;
}

/** A multi-byte prefix, so that byte spans differ from code point and UTF-16 offsets. */
const multiByte = (rng) => {
  let s = "";
  for (let n = rng.between(1, 4); n > 0; n--) s += String.fromCodePoint(rng.pick([...TWO_BYTE, ...THREE_BYTE, ...FOUR_BYTE]));
  return s;
};

/** Ill-formed UTF-8 (Unicode Table 3-7), each with a different maximal subpart. */
const BAD_UTF8 = [
  [0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xc2], [0xc2, 0x41], [0xe0, 0x80, 0x80], [0xe0, 0x9f, 0xbf],
  [0xe0, 0xa0], [0xe2, 0x82], [0xe2, 0x82, 0x41], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], [0xef, 0xbf],
  [0xf0, 0x80, 0x80, 0x80], [0xf0, 0x8f, 0xbf, 0xbf], [0xf0, 0x9f, 0x98], [0xf0, 0x9f], [0xf4, 0x90, 0x80, 0x80],
  [0xf4, 0x8f, 0xbf], [0xf5, 0x80, 0x80, 0x80], [0xf8, 0x88, 0x80, 0x80, 0x80], [0xfe], [0xff],
];

// --- values: the generator's own builders (ontos-codec §2, ontos-data §5) -------------
// The shape is check.mjs's ({ a: bytes } | { t: [children] }), so the oracle takes them as
// they are. The builders are written again here, not imported, so that a value the generator
// spells and the value the oracle reads back are derived twice.

const A = (bytes) => ({ a: Uint8Array.from(bytes) });
const T = (items) => ({ t: items });
const lab = (s) => A(te.encode(s));

function intPayload(n) {
  if (n === 0n) return [0];
  const neg = n < 0n;
  let h = (neg ? -n : n).toString(16);
  if (h.length % 2) h = "0" + h;
  const out = [neg ? 1 : 0];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

const vInt = (n) => T([lab("int"), A(intPayload(n))]);
const vText = (s) => T([lab("utf8-text"), A(typeof s === "string" ? te.encode(s) : s)]);
const vBool = (b) => T([lab("bool"), A([b ? 1 : 0])]);
const vNull = () => T([lab("null")]);
const vList = (items) => T([lab("list"), ...items]);
const vDecimal = (m, e) => T([lab("decimal"), vInt(m), vInt(e)]);

function enc(v, out = []) {
  const len = (n) => {
    while (n >= 128) {
      out.push((n % 128) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
  };
  if (isAtom(v)) {
    out.push(0);
    len(v.a.length);
    for (const b of v.a) out.push(b);
  } else {
    out.push(1);
    len(v.t.length);
    for (const c of v.t) enc(c, out);
  }
  return out;
}

function cmpEnc(x, y) {
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** Sorted by the encoding of keyOf(item), later duplicates dropped (ontos-data §5.7, §5.8). */
function canonical(items, keyOf) {
  const keyed = items.map((it) => ({ it, k: enc(keyOf(it)) })).sort((x, y) => cmpEnc(x.k, y.k));
  return keyed.filter((x, i) => i === 0 || cmpEnc(keyed[i - 1].k, x.k) !== 0).map((x) => x.it);
}

const vMap = (entries) => T([lab("map"), ...canonical(entries, (e) => e[0]).map(([k, v]) => T([k, v]))]);
const vSet = (items) => T([lab("set"), ...canonical(items, (x) => x)]);

function height(v) {
  let max = 0;
  const stack = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop();
    if (d > max) max = d;
    if (!isAtom(x)) for (const c of x.t) stack.push([c, d + 1]);
  }
  return max;
}

// --- random values ----------------------------------------------------------------------

function digitString(rng, n) {
  let s = String(rng.between(1, 9));
  for (let i = 1; i < n; i++) s += String(rng.below(10));
  return s;
}

const sign = (rng) => (rng.chance(0.5) ? 1n : -1n);

function genInt(rng) {
  switch (rng.weighted([[20, 0], [20, 1], [14, 2], [14, 3], [14, 4], [2, 5], [6, 6]])) {
    case 0:
      return BigInt(rng.between(-20, 20));
    case 1:
      return BigInt(rng.between(-100000, 100000));
    case 2:
      return sign(rng) * (MAX_SAFE + BigInt(rng.between(-3, 3)));
    case 3: {
      const k = BigInt(rng.between(0, 140));
      return sign(rng) * ((1n << k) + BigInt(rng.between(-1, 1)));
    }
    case 4:
      return sign(rng) * BigInt(digitString(rng, rng.between(1, 60)));
    case 5:
      // Around the readable profile's default max_integer_digits (4300).
      return sign(rng) * BigInt(digitString(rng, rng.between(4295, 4305)));
    default:
      return 0n;
  }
}

function genDecimal(rng) {
  let m = genInt(rng);
  while (m !== 0n && m % 10n === 0n) m /= 10n;
  const e = m === 0n ? 0n : rng.chance(0.8) ? BigInt(rng.between(-30, 30)) : genInt(rng);
  return vDecimal(m, e);
}

const KEYS = [
  "", "$ontos", "$bytes", "$undefined", "__proto__", "constructor", "0", "$Ontos", "$ontos ", "ontos",
  "\u00e9", "e\u0301", "Z", "a", "aa", "b", "\u0000", "\ufeff", "\u2028",
];

function randKey(rng) {
  switch (rng.weighted([[10, 0], [4, 1], [2, 2]])) {
    case 0:
      return randString(rng, 6);
    case 1:
      return rng.pick(KEYS);
    default:
      // Around the uvarint length boundaries, where codec order is not length order.
      return "k".repeat(rng.pick([126, 127, 128, 129, 130, 254, 255, 256, 257]));
  }
}

const LABELS = [
  "", "point", "x", "ns:thing", "int", "list", "map", "set", "decimal", "null", "bool", "utf8-text", "Int",
  "utf8", "bytes", "raw", "compound", "$ontos", "\u00e9", "\u{1f600}",
];

function genLabel(rng) {
  switch (rng.weighted([[6, 0], [3, 1], [2, 2]])) {
    case 0:
      return lab(rng.pick(LABELS));
    case 1:
      return lab(randString(rng, 5));
    default:
      return A(concat(randString(rng, 2), Uint8Array.from(rng.pick(BAD_UTF8))));
  }
}

const LEAF_KINDS = [[6, "null"], [6, "bool"], [14, "text"], [14, "int"], [5, "decimal"], [8, "atom"], [8, "near"]];
const ALL_KINDS = [...LEAF_KINDS, [10, "list"], [10, "map"], [6, "set"], [8, "compound"], [4, "tuple"]];

function children(rng, depth, budget) {
  const n = rng.chance(0.03) ? rng.between(120, 260) : rng.between(0, 4);
  const out = [];
  for (let i = 0; i < n; i++) out.push(genValue(rng, depth - 1, budget));
  return out;
}

function genValue(rng, depth, budget) {
  budget.n -= 1;
  const leaf = depth <= 0 || budget.n <= 0;
  switch (rng.weighted(leaf ? LEAF_KINDS : ALL_KINDS)) {
    case "null":
      return vNull();
    case "bool":
      return vBool(rng.chance(0.5));
    case "text":
      return vText(rng.chance(0.03) ? randString(rng, 1).repeat(rng.between(120, 300)) : randString(rng, 10));
    case "int":
      return vInt(genInt(rng));
    case "decimal":
      return genDecimal(rng);
    case "atom":
      return A(rng.bytes(rng.chance(0.08) ? rng.between(120, 300) : rng.between(0, 6)));
    case "near":
      return nearMiss(rng, depth, budget);
    case "list":
      return vList(children(rng, depth, budget));
    case "map": {
      const n = rng.chance(0.03) ? rng.between(120, 200) : rng.between(0, 4);
      const entries = [];
      for (let i = 0; i < n; i++) {
        const k = rng.chance(0.8) ? vText(randKey(rng)) : genValue(rng, Math.min(depth - 1, 1), budget);
        entries.push([k, genValue(rng, depth - 1, budget)]);
      }
      return vMap(entries);
    }
    case "set":
      return vSet(children(rng, depth, budget));
    case "compound":
      return T([genLabel(rng), ...children(rng, depth, budget)]);
    default:
      // Shapes only `raw` spells: the empty tuple, and a tuple whose first child is a tuple.
      return rng.chance(0.4) ? T([]) : T([T(children(rng, depth, budget)), ...children(rng, depth, budget)]);
  }
}

/** Tuples that come close to a registered kind and miss it (ontos-data §5), for the writer. */
function nearMiss(rng, depth, budget) {
  const badText = () => A(concat(randString(rng, 2), Uint8Array.from(rng.pick(BAD_UTF8))));
  const some = () => genValue(rng, Math.min(depth - 1, 1), budget);
  const shapes = [
    () => T([lab("int"), A([])]),
    () => T([lab("int"), A([0, 0])]),
    () => T([lab("int"), A([1])]),
    () => T([lab("int"), A([1, 0])]),
    () => T([lab("int"), A([1, 0, 5])]),
    () => T([lab("int"), A([2, 5])]),
    () => T([lab("int"), A([0, 0, 5])]),
    () => T([lab("int")]),
    () => T([lab("int"), A([0, 5]), A([0])]),
    () => T([lab("int"), vInt(5n)]),
    () => T([lab("bool"), A([2])]),
    () => T([lab("bool"), A([])]),
    () => T([lab("bool"), A([0, 0])]),
    () => T([lab("bool"), vBool(true)]),
    () => T([lab("null"), A([])]),
    () => T([lab("null"), some()]),
    () => T([lab("utf8-text"), badText()]),
    () => T([lab("utf8-text")]),
    () => T([lab("utf8-text"), A(te.encode("a")), A(te.encode("b"))]),
    () => T([lab("map"), T([vText("b"), some()]), T([vText("a"), some()])]),
    () => T([lab("map"), T([vText("a"), vNull()]), T([vText("a"), vBool(true)])]),
    () => T([lab("map"), T([vText("a")])]),
    () => T([lab("map"), T([vText("a"), vNull(), vNull()])]),
    () => T([lab("map"), A([1])]),
    () => T([lab("set"), vInt(2n), vInt(1n)]),
    () => T([lab("set"), vInt(1n), vInt(1n)]),
    () => T([lab("decimal"), vInt(0n), vInt(1n)]),
    () => T([lab("decimal"), vInt(10n), vInt(0n)]),
    () => T([lab("decimal"), vInt(5n)]),
    () => T([lab("decimal"), T([lab("int"), A([0, 0, 5])]), vInt(1n)]),
    () => T([lab("decimal"), vInt(5n), vText("1")]),
    () => T([lab("list")]),
    () => T([lab("Int"), A([0, 5])]),
    () => T([A([0xff]), vNull()]),
    () => T([A([]), vNull()]),
    () => T([T([]), A([1])]),
    () => T([]),
  ];
  return rng.pick(shapes)();
}

// --- JSON trees and their spelling ------------------------------------------------------
// A tree node is { t: "obj", m: [[name, node], …] } | { t: "arr", a: [node, …] } |
// { t: "str", s } | { t: "num", lex } | { t: "lit", v }. `val` on a node is the value it spells.

const obj = (m) => ({ t: "obj", m });
const arr = (a) => ({ t: "arr", a });
const str = (s) => ({ t: "str", s });
const num = (lex) => ({ t: "num", lex });
const lit = (v) => ({ t: "lit", v });
const env = (items) => obj([["$ontos", arr(items)]]);
const tagged = (node, val, kind) => Object.assign(node, { val, kind });

const hexOf = (bytes) => bytesToHex(bytes);
const isText = (bytes) => utf8Fault(bytes) === null;

function spellTotal(v) {
  if (isAtom(v)) return tagged(obj([["atom", str(hexOf(v.a))]]), v);
  return tagged(obj([["tuple", arr(v.t.map(spellTotal))]]), v);
}

/** A readable spelling of v, the preferred one with probability `pref`, else another. */
function spellReadable(v, rng, pref = 0.7) {
  const spell = (x) => spellReadable(x, rng, pref);
  if (isAtom(v)) {
    return tagged(rng.chance(pref) ? env([str("bytes"), str(b64Encode(v.a))]) : env([str("raw"), spellTotal(v)]), v);
  }
  const r = recognize(v);
  const preferred = r && rng.chance(pref);
  if (preferred || (r && rng.chance(0.4))) {
    switch (r.kind) {
      case "null":
        return tagged(lit("null"), v);
      case "bool":
        return tagged(lit(r.b ? "true" : "false"), v);
      case "utf8-text":
        return tagged(str(td.decode(r.bytes)), v);
      case "int": {
        const inWindow = r.n <= MAX_SAFE && r.n >= -MAX_SAFE;
        if (inWindow && (preferred || rng.chance(0.3))) return tagged(num(r.n === 0n && rng.chance(0.3) ? "-0" : r.n.toString()), v);
        return tagged(env([str("int"), str(r.n.toString())]), v);
      }
      case "list":
        return tagged(arr(r.items.map(spell)), v);
      case "map": {
        const plain = r.entries.every(([k]) => {
          const t = recognize(k);
          return t && t.kind === "utf8-text" && td.decode(t.bytes) !== "$ontos";
        });
        if (plain && (preferred || rng.chance(0.3))) {
          const members = r.entries.map(([k, val]) => [td.decode(recognize(k).bytes), spell(val)]);
          return tagged(obj(rng.shuffle(members)), v, "object");
        }
        const entries = r.entries.map(([k, val]) => tagged(arr([spell(k), spell(val)]), k));
        return tagged(env([str("map"), tagged(arr(rng.shuffle(entries)), null, "entries")]), v);
      }
      case "set":
        return tagged(env([str("set"), tagged(arr(rng.shuffle(r.items.map(spell))), null, "elements")]), v);
      case "decimal":
        return tagged(env([str("decimal"), str(r.m.toString()), str(r.e.toString())]), v);
    }
  }
  if (v.t.length && isAtom(v.t[0]) && rng.chance(0.6)) {
    const l = v.t[0].a;
    const label = isText(l) && rng.chance(0.8) ? str(td.decode(l)) : arr([str("bytes"), str(b64Encode(l))]);
    return tagged(env([str("compound"), label, arr(v.t.slice(1).map(spell))]), v);
  }
  return tagged(env([str("raw"), spellTotal(v)]), v);
}

const WS = [" ", "\t", "\n", "\r"];
const SHORT = { 0x08: "\\b", 0x09: "\\t", 0x0a: "\\n", 0x0c: "\\f", 0x0d: "\\r" };

function randomStyle(rng) {
  return {
    ws: rng.pick([0, 0, 0.05, 0.2, 0.6]),
    esc: rng.pick([0, 0, 0.03, 0.15, 0.6]),
    upper: rng.pick([0, 0.5, 1]),
  };
}

/** The text of a tree, with the whitespace and string escapes the style chooses at random. */
function serialize(tree, rng, style) {
  const parts = [];
  const ws = () => {
    if (style.ws && rng.chance(style.ws)) for (let k = rng.between(1, 3); k > 0; k--) parts.push(rng.pick(WS));
  };
  const hex4 = (c) => {
    let h = c.toString(16).padStart(4, "0");
    if (style.upper) h = [...h].map((d) => (rng.chance(style.upper) ? d.toUpperCase() : d)).join("");
    return "\\u" + h;
  };
  const string = (s) => {
    let out = '"';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      const escape = style.esc && rng.chance(style.esc);
      if (c === 0x22) out += escape ? hex4(c) : '\\"';
      else if (c === 0x5c) out += escape ? hex4(c) : "\\\\";
      else if (c < 0x20) out += SHORT[c] && !escape ? SHORT[c] : hex4(c);
      else if (!escape) out += ch;
      else if (c === 0x2f && rng.chance(0.5)) out += "\\/";
      else if (c > 0xffff) out += hex4(0xd800 + ((c - 0x10000) >> 10)) + hex4(0xdc00 + ((c - 0x10000) & 0x3ff));
      else out += hex4(c);
    }
    return out + '"';
  };
  const walk = (n) => {
    switch (n.t) {
      case "obj":
        parts.push("{");
        ws();
        n.m.forEach(([name, val], i) => {
          if (i) {
            parts.push(",");
            ws();
          }
          parts.push(string(name));
          ws();
          parts.push(":");
          ws();
          walk(val);
          ws();
        });
        parts.push("}");
        return;
      case "arr":
        parts.push("[");
        ws();
        n.a.forEach((val, i) => {
          if (i) {
            parts.push(",");
            ws();
          }
          walk(val);
          ws();
        });
        parts.push("]");
        return;
      case "str":
        parts.push(string(n.s));
        return;
      case "num":
        parts.push(n.lex);
        return;
      case "lit":
        parts.push(n.v);
        return;
    }
    throw new Error(`unknown tree node ${n.t}`);
  };
  ws();
  walk(tree);
  ws();
  return te.encode(parts.join(""));
}

// --- deviations: what a valid spelling turns into when one node goes wrong ---------------

const BAD_NUMBERS = [
  "1.0", "1e0", "1E+2", "-0.0", "0.5", "1e400", "9007199254740992", "-9007199254740992", "12345678901234567890",
  "-18446744073709551616",
];
const BAD_INT_TEXT = [
  "+1", "01", "-0", "", " 1", "1 ", "1.0", "1e3", "\u0661", "1\u0662", "0x1", "--1", "-", "1_000", "00", "-01",
  "+0", "\uff11", "1\u0000",
];
const BAD_DECIMALS = [
  ["0", "1"], ["0", "-1"], ["10", "0"], ["-120", "5"], ["01", "1"], ["1", "+2"], ["1", "01"], ["100", "2"],
  ["0", "0"], ["-0", "0"], ["5", "-0"], ["1", ""],
];
const BAD_HEX = ["0", "000", "AB", "aB", "0g", "zz", " 00", "00 ", "0x00", "\u00e90", "0\u0000"];
const BAD_TAGS = ["Int", "integer", "", "bytes ", " int", "RAW", "list", "text", "null", "$ontos", "tuple", "atom", "Map"];

function badBase64(rng) {
  const fixed = [
    "AB==", "AA", "AA==\n", "-_8=", "A===", "AAB=", "=AAA", "AA=A", " AA==", "AA== ", "AAAAA", "AA==AA==", "QQ",
    "QUI", "QUJD\n", "Zm9v YmFy", "\u00c0A==", "====", "A", "AAA==",
  ];
  if (rng.chance(0.5)) return rng.pick(fixed);
  const good = b64Encode(rng.bytes(rng.between(1, 10)));
  const chars = [...good];
  const i = rng.below(chars.length);
  switch (rng.below(4)) {
    case 0:
      chars[i] = rng.pick(["-", "_", "=", " ", "\n", "*", "\u00e9"]);
      break;
    case 1:
      return good.replace(/=+$/, "");
    case 2: {
      // Non-zero pad bits in the last character before the padding.
      const j = good.indexOf("=") > 0 ? good.indexOf("=") - 1 : -1;
      if (j < 0) return good + "=";
      const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      chars[j] = B64[(B64.indexOf(chars[j]) | 1) & 63];
      break;
    }
    default:
      chars.splice(i, 1);
  }
  return chars.join("");
}

function badTotal(rng) {
  return rng.pick([
    () => obj([]),
    () => obj([["atom", str("00")], ["tuple", arr([])]]),
    () => obj([["tuple", arr([])], ["x", lit("null")]]),
    () => obj([["Atom", str("00")]]),
    () => obj([["atom ", str("00")]]),
    () => obj([["atom", num("0")]]),
    () => obj([["atom", arr([])]]),
    () => obj([["atom", lit("null")]]),
    () => obj([["atom", str(rng.pick(BAD_HEX))]]),
    () => obj([["tuple", obj([])]]),
    () => obj([["tuple", str("[]")]]),
    () => obj([["tuple", lit("null")]]),
    () => obj([["tuple", arr([num("1")])]]),
    () => arr([]),
    () => str("00"),
    () => num("0"),
    () => lit("true"),
    () => obj([["bytes", str("AA==")]]),
  ])();
}

function badEnvelope(rng) {
  const small = () => spellReadable(genValue(rng, 1, { n: 3 }), rng);
  return rng.pick([
    () => obj([["$ontos", arr([])]]),
    () => obj([["$ontos", str("int")]]),
    () => obj([["$ontos", obj([])]]),
    () => obj([["$ontos", lit("null")]]),
    () => obj([["$ontos", arr([num("1"), str("1")])]]),
    () => obj([["$ontos", arr([arr([]), str("1")])]]),
    () => env([str(rng.pick(BAD_TAGS)), str("1")]),
    () => obj([["a", lit("null")], ["$ontos", arr([str("int"), str("1")])]]),
    () => obj([["$ontos", arr([str("int"), str("1")])], ["b", lit("null")]]),
    () => env([str("int")]),
    () => env([str("int"), str("1"), str("2")]),
    () => env([str("decimal"), str("1")]),
    () => env([str("map")]),
    () => env([str("raw")]),
    () => env([str("raw"), spellTotal(A([1])), lit("null")]),
    () => env([str("compound"), str("x")]),
    () => env([str("bytes")]),
    () => env([str("set"), arr([]), arr([])]),
    () => env([str("int"), num("1")]),
    () => env([str("bytes"), num("5")]),
    () => env([str("bytes"), arr([])]),
    () => env([str("map"), obj([])]),
    () => env([str("map"), arr([arr([num("1")])])]),
    () => env([str("map"), arr([num("1")])]),
    () => env([str("map"), arr([arr([num("1"), lit("null"), lit("null")])])]),
    () => env([str("map"), arr([arr([str("a"), lit("null")]), arr([str("a"), lit("true")])])]),
    () => env([str("map"), arr([arr([num("1"), small()]), arr([env([str("int"), str("1")]), small()])])]),
    () => env([str("set"), obj([])]),
    () => env([str("set"), arr([num("1"), num("1")])]),
    () => env([str("set"), arr([str("a"), env([str("raw"), spellTotal(vText("a"))])])]),
    () => env([str("compound"), num("5"), arr([])]),
    () => env([str("compound"), arr([str("text"), str("x")]), arr([])]),
    () => env([str("compound"), arr([str("bytes")]), arr([])]),
    () => env([str("compound"), arr([str("bytes"), num("5")]), arr([])]),
    () => env([str("compound"), arr([str("bytes"), str(badBase64(rng))]), arr([])]),
    () => env([str("compound"), arr([str("Bytes"), str("AA==")]), arr([])]),
    () => env([str("compound"), str("x"), obj([])]),
    () => env([str("compound"), str("x"), str("args")]),
    () => env([str("decimal"), num("1"), str("2")]),
    () => env([str("decimal"), str("1"), num("2")]),
    () => env([str("int"), str(rng.pick(BAD_INT_TEXT))]),
    () => env([str("decimal"), ...rng.pick(BAD_DECIMALS).map(str)]),
    () => env([str("bytes"), str(badBase64(rng))]),
    () => env([str("raw"), badTotal(rng)]),
  ])();
}

/** Every node of a tree with the slot that holds it, so that a deviation can replace it. */
function slots(holder) {
  const out = [];
  const visit = (node, set, parent) => {
    out.push({ node, set, parent });
    if (node.t === "obj") node.m.forEach((member, i) => visit(member[1], (x) => (node.m[i][1] = x), node));
    if (node.t === "arr") node.a.forEach((x, i) => visit(x, (y) => (node.a[i] = y), node));
  };
  visit(holder.root, (x) => (holder.root = x), null);
  return out;
}

const DEVIATIONS = {
  readable: [
    [3, "number", (rng, s) => s.set(num(rng.pick(BAD_NUMBERS)))],
    [8, "envelope", (rng, s) => s.set(badEnvelope(rng))],
    [2, "raw", (rng, s) => s.set(env([str("raw"), badTotal(rng)]))],
    [3, "duplicate member", (rng, s, all) => duplicateMember(rng, all)],
    [3, "duplicate key", (rng, s, all) => duplicateEntry(rng, all, "entries")],
    [3, "duplicate element", (rng, s, all) => duplicateEntry(rng, all, "elements")],
    [2, "reserved", (rng, s, all) => {
      const objs = all.filter((x) => x.node.t === "obj");
      const o = objs.length ? rng.pick(objs).node : null;
      if (o) o.m.splice(rng.below(o.m.length + 1), 0, ["$ontos", spellReadable(genValue(rng, 1, { n: 2 }), rng)]);
      else s.set(obj([["$ontos", spellReadable(genValue(rng, 1, { n: 2 }), rng)], ["x", lit("null")]]));
    }],
    [2, "tag", (rng, s, all) => {
      const tags = all.filter((x) => x.parent?.t === "arr" && x.node.t === "str" && x.parent.a[0] === x.node);
      if (tags.length) rng.pick(tags).node.s = rng.pick([...BAD_TAGS, "int", "bytes", "decimal", "map", "set", "compound", "raw"]);
      else s.set(badEnvelope(rng));
    }],
    [2, "kind", (rng, s) => s.set(rng.pick([arr([]), obj([]), str("x"), num("1"), lit("null")]))],
  ],
  total: [
    [8, "total form", (rng, s) => s.set(badTotal(rng))],
    [3, "duplicate member", (rng, s, all) => duplicateMember(rng, all)],
    [3, "hex", (rng, s, all) => {
      const atoms = all.filter((x) => x.node.t === "str" && x.parent?.t === "obj");
      if (atoms.length) rng.pick(atoms).node.s = rng.pick(BAD_HEX);
      else s.set(badTotal(rng));
    }],
    [2, "kind", (rng, s) => s.set(rng.pick([arr([]), obj([]), str("x"), num("1"), lit("null")]))],
  ],
};

function duplicateMember(rng, all) {
  const objs = all.filter((x) => x.node.t === "obj" && x.node.m.length);
  if (!objs.length) return;
  const o = rng.pick(objs).node;
  const [name, val] = rng.pick(o.m);
  o.m.splice(rng.between(1, o.m.length), 0, [name, val]);
}

function duplicateEntry(rng, all, kind) {
  // Entries and elements that still spell a known value (an earlier deviation may have
  // replaced one with a node that spells none).
  const known = (list) => list.a.flatMap((x, i) => (x.val ? [i] : []));
  const lists = all.filter((x) => x.node.kind === kind && known(x.node).length);
  if (!lists.length) return duplicateMember(rng, all);
  const list = rng.pick(lists).node;
  const i = rng.pick(known(list));
  const original = list.a[i];
  // The same ground value again, spelled anew (another spelling, as often as not).
  const again =
    kind === "entries"
      ? tagged(arr([spellReadable(original.val, rng, 0.3), spellReadable(genValue(rng, 1, { n: 2 }), rng)]), original.val)
      : spellReadable(original.val, rng, 0.3);
  list.a.splice(rng.between(i + 1, list.a.length), 0, again);
}

// --- byte mutations -----------------------------------------------------------------------

const TOKENS = [
  "{", "}", "[", "]", ",", ":", '"', "\\", "\\u", "\\ud800", "\\udc00", "\\ud83d\\ude00", "$ontos", '"$ontos"',
  "null", "true", "false", "-0", "-", "0", "1", "1e5", "1.5", "9007199254740992", "9007199254740991",
  '{"atom":"', '{"tuple":[', '{"$ontos":[', '"raw"', '"bytes"', '"int"', '"map"', '"set"', '"compound"',
  '"decimal"', "AA==", " ", "\t", "\n", "\r", "//", "/*", "\u00a0", "\u2028", "\ufeff", "\u00e9", "\u20ac",
  "\u{1f600}", "\u000b", "\u000c", "\u0000", "\u001f", "\u007f",
];

function mutate(bytes, rng, pool) {
  let b = bytes;
  const ops = [];
  for (let k = rng.weighted([[6, 1], [3, 2], [1, 3]]); k > 0; k--) {
    const at = rng.below(b.length + 1);
    switch (rng.below(10)) {
      case 0:
        b = concat(b.subarray(0, at), b.subarray(Math.min(b.length, at + 1)));
        ops.push(`delete @${at}`);
        break;
      case 1: {
        const end = Math.min(b.length, at + rng.between(1, 8));
        b = concat(b.subarray(0, at), b.subarray(end));
        ops.push(`delete @${at}..${end}`);
        break;
      }
      case 2: {
        const x = rng.u32() & 0xff;
        b = concat(b.subarray(0, at), Uint8Array.of(x), b.subarray(at));
        ops.push(`insert ${x.toString(16)} @${at}`);
        break;
      }
      case 3:
      case 4: {
        const t = rng.pick(TOKENS);
        b = concat(b.subarray(0, at), t, b.subarray(at));
        ops.push(`insert ${JSON.stringify(t)} @${at}`);
        break;
      }
      case 5: {
        const bad = Uint8Array.from(rng.pick(BAD_UTF8));
        b = concat(b.subarray(0, at), bad, b.subarray(at));
        ops.push(`insert ${bytesToHex(bad)} @${at}`);
        break;
      }
      case 6:
        if (at < b.length) {
          b = Uint8Array.from(b);
          b[at] = rng.u32() & 0xff;
          ops.push(`replace @${at}`);
        }
        break;
      case 7: {
        const from = rng.below(b.length + 1);
        const piece = b.subarray(from, Math.min(b.length, from + rng.between(1, 12)));
        b = concat(b.subarray(0, at), piece, b.subarray(at));
        ops.push(`copy @${from} to @${at}`);
        break;
      }
      case 8:
        b = b.subarray(0, at);
        ops.push(`truncate @${at}`);
        break;
      default: {
        const other = rng.pick(pool).bytes;
        const cut = rng.below(other.length + 1);
        b = concat(b.subarray(0, at), other.subarray(cut));
        ops.push(`splice @${at}`);
      }
    }
  }
  return { bytes: b, ops };
}

// --- the families -------------------------------------------------------------------------
// Each makes { input } (bytes to read) or { value } (a value to write), and a note.

function spelledText(profile, rng) {
  const value = genValue(rng, rng.between(0, 5), { n: rng.between(1, 40) });
  const tree = profile === "total" ? spellTotal(value) : spellReadable(value, rng, rng.pick([0.2, 0.7, 0.95]));
  return { value, tree };
}

const wrapString = {
  readable: (rng, s) =>
    rng.pick([
      () => `"${s}"`,
      () => `["${s}"]`,
      () => `{"${s}":1}`,
      () => `{"k":"${s}"}`,
      () => `{"$ontos":["compound","${s}",[]]}`,
      () => `["${multiByte(rng)}","${s}"]`,
      () => `{"${multiByte(rng)}":["${s}"]}`,
    ])(),
  total: (rng, s) =>
    rng.pick([
      () => `{"${s}":"00"}`,
      () => `{"atom":"${s}"}`,
      () => `{"tuple":[{"atom":"${s}"}]}`,
      () => `{"tuple":[{"atom":"00"},{"${s}":[]}]}`,
    ])(),
};

const ESCAPES = [
  '\\"', "\\\\", "\\/", "\\b", "\\f", "\\n", "\\r", "\\t", "\\u0041", "\\u00e9", "\\u00E9", "\\u20AC", "\\uFFFF",
  "\\uffff", "\\u0000", "\\u001f", "\\u001F", "\\ud83d\\ude00", "\\uD83D\\uDE00", "\\x", "\\'", "\\U0041",
  "\\u12", "\\u12G4", "\\u 123", "\\0", "\\a", "\\v", "\\", "\u0001", "\t", "\u007f", "a", "\u00e9", "\u{1f600}",
  "\\u0024", "\\u0061",
];
const SURROGATES = [
  "\\ud800", "\\udbff", "\\udc00", "\\udfff", "\\uD800\\uDC00", "\\udbff\\udfff", "\\ud800\\u0041", "\\ud800\\ud800",
  "\\udc00\\ud800", "\\ud800\\n", "\\ud800\\", "\\ud800\\u", "\\ud800\\udc0", "\\ud800\\uDc00", "\\uD83D",
  "\u{1f600}", "\u00e9", "x",
];
const NUMBERS = [
  "0", "-0", "1", "-1", "9007199254740991", "-9007199254740991", "9007199254740992", "-9007199254740992",
  "18446744073709551616", "00", "01", "-01", "-", "--1", "+1", "1.", "1.0", "1.5", ".5", "1e", "1e+", "1e-",
  "1E5", "1e+5", "0e0", "-0.0", "1e400", "0x10", "Infinity", "NaN", "1_0", "-a", "2.", "123456789012345",
];

function soup(rng, pieces) {
  let s = "";
  for (let n = rng.between(1, 4); n > 0; n--) s += rng.chance(0.3) ? randString(rng, 2).replace(/["\\]/g, "") : rng.pick(pieces);
  return s;
}

function deep(profile, rng) {
  const L = profile === "total";
  const target = rng.weighted([
    [3, () => rng.between(1021, 1027)],
    [2, () => (L ? rng.between(1023, 1027) : rng.between(1022, 1028))],
    [5, () => rng.between(1, 80)],
  ])();
  const parts = [];
  const close = [];
  const wrappers = L
    ? [['{"tuple":[', "]}"], ['{"tuple":[{"atom":"00"},', "]}"]]
    : [
        ["[", "]"],
        ['{"k":', "}"],
        ['{"$ontos":["compound","c",[', "]]}"],
        ['{"$ontos":["set",[', "]]}"],
        ['{"$ontos":["map",[["k",', "]]]}"],
        ['{"$ontos":["compound","c",[1,', "]]}"],
      ];
  const mix = rng.chance(0.3) ? wrappers : [rng.pick(wrappers)];
  for (let i = 0; i < target; i++) {
    const [o, c] = rng.pick(mix);
    parts.push(o);
    close.push(c);
  }
  let raw = false;
  if (!L && rng.chance(0.2)) {
    raw = true;
    parts.push('{"$ontos":["raw",');
    close.push("]}");
    for (let i = rng.between(0, 40); i > 0; i--) {
      parts.push('{"tuple":[');
      close.push("]}");
    }
  }
  const leaves = L || raw
    ? ['{"atom":""}', '{"tuple":[]}', '{"atom":"0"}', "[]", '{"atom":"00"}']
    : ["null", "1", '"x"', "[]", "{}", '{"$ontos":["raw",{"tuple":[]}]}', "1.5", '"\\ud800"', '{"$ontos":[]}', "nul"];
  parts.push(rng.pick(leaves));
  close.reverse();
  const keep = rng.chance(0.1) ? rng.below(close.length) : close.length;
  return { input: te.encode(parts.join("") + close.slice(0, keep).join("")), note: `deep: ${target} levels${raw ? " into raw" : ""}` };
}

function deepValue(rng) {
  const n = rng.weighted([[3, () => rng.between(1000, MAX_VALUE_DEPTH - 1)], [5, () => rng.between(1, 80)]])();
  const kinds = ["tuple", "list", "compound", "set", "map"];
  const mix = rng.chance(0.3) ? kinds : [rng.pick(kinds)];
  let v = rng.pick([vNull(), A([]), T([]), vInt(1n), vText("x")]);
  // A map wraps its child two levels down, so a chain of n wrappers stays within depth 1024.
  for (let d = height(v); d < n; ) {
    let k = rng.pick(mix);
    if (k === "map" && d + 2 > n) k = "list";
    v = k === "tuple" ? T([v]) : k === "list" ? vList([v]) : k === "compound" ? T([lab("c"), v]) : k === "set" ? vSet([v]) : vMap([[vText("k"), v]]);
    d += k === "map" ? 2 : 1;
  }
  return { value: v, note: `deep value: depth ${height(v)}` };
}

function family(profile) {
  const R = profile === "readable";
  return [
    [14, "spelled", (rng) => {
      const { value, tree } = spelledText(profile, rng);
      return { input: serialize(tree, rng, randomStyle(rng)), note: "a valid spelling", spells: value };
    }],
    [14, "deviant", (rng) => {
      const { tree } = spelledText(profile, rng);
      const holder = { root: tree };
      const done = [];
      for (let k = rng.weighted([[4, 1], [1, 2]]); k > 0; k--) {
        const all = slots(holder);
        const [, name, apply] = (() => {
          const list = DEVIATIONS[profile];
          const choice = rng.weighted(list.map((d) => [d[0], d]));
          return choice;
        })();
        apply(rng, rng.pick(all), all);
        done.push(name);
      }
      return { input: serialize(holder.root, rng, randomStyle(rng)), note: `a spelling with deviations: ${done.join(", ")}` };
    }],
    [14, "mutant", (rng, pool) => {
      const base = rng.chance(0.6) ? rng.pick(pool) : { name: "a fresh spelling", bytes: serialize(spelledText(profile, rng).tree, rng, randomStyle(rng)) };
      const { bytes, ops } = mutate(base.bytes, rng, pool);
      return { input: bytes, note: `mutation of ${base.name}: ${ops.join("; ")}` };
    }],
    [5, "escapes", (rng) => ({ input: te.encode(wrapString[profile](rng, soup(rng, ESCAPES))), note: "string escapes" })],
    [5, "surrogates", (rng) => {
      const text = wrapString[profile](rng, soup(rng, SURROGATES));
      return { input: te.encode(rng.chance(0.15) ? text.slice(0, rng.below(text.length)) : text), note: "surrogate escapes" };
    }],
    [R ? 5 : 2, "numbers", (rng) => {
      const n = rng.pick(NUMBERS);
      const ctx = rng.pick(R ? [`${n}`, `[${n}]`, `{"k":${n}}`, `[${n},`, `{"$ontos":["int",${n}]}`, `["${multiByte(rng)}",${n}]`] : [`${n}`, `{"atom":${n}}`, `{"tuple":[${n}]}`]);
      return { input: te.encode(ctx), note: `number ${n}` };
    }],
    [R ? 6 : 0, "integers", (rng) => {
      const big = () => (rng.chance(0.3) ? "-" : "") + digitString(rng, rng.weighted([[2, rng.between(1, 30)], [1, rng.between(4295, 4305)]]));
      const t = rng.chance(0.6) ? big() : rng.pick(BAD_INT_TEXT);
      const ctx = rng.weighted([
        [3, () => `{"$ontos":["int","${t}"]}`],
        [2, () => `{"$ontos":["decimal","${t}","${rng.chance(0.5) ? big() : "0"}"]}`],
        [1, () => `{"$ontos":["decimal","${rng.pick(["1", "-7", "25"])}","${t}"]}`],
        // Canonical integers that are not the canonical pair: a mantissa ending in 0, or 0
        // with an exponent.
        [2, () => `{"$ontos":["decimal","${rng.chance(0.5) ? "-" : ""}${digitString(rng, rng.between(1, 6))}0","${rng.between(-9, 9)}"]}`],
        [1, () => `{"$ontos":["decimal","0","${rng.chance(0.5) ? "-" : ""}${digitString(rng, rng.between(1, 4))}"]}`],
        [1, () => `{"$ontos":["decimal",${rng.pick(BAD_DECIMALS).map((x) => JSON.stringify(x)).join(",")}]}`],
        [2, () => `[${rng.chance(0.5) ? "" : "-"}${MAX_SAFE + BigInt(rng.between(-2, 2))}]`],
        [1, () => `{"$ontos":["map",[[{"$ontos":["int","${t}"]},null]]]}`],
      ])();
      return { input: te.encode(ctx), note: "integer text" };
    }],
    [R ? 5 : 0, "base64", (rng) => {
      const b = rng.chance(0.4) ? b64Encode(rng.chance(0.5) ? rng.bytes(rng.between(0, 8)) : te.encode(randString(rng, 3))) : badBase64(rng);
      const ctx = rng.pick([`{"$ontos":["bytes",${JSON.stringify(b)}]}`, `{"$ontos":["compound",["bytes",${JSON.stringify(b)}],[]]}`, `[1,{"$ontos":["bytes",${JSON.stringify(b)}]}]`]);
      return { input: te.encode(ctx), note: "base64" };
    }],
    [R ? 5 : 0, "reserved", (rng) => {
      const name = rng.pick(["$ontos", "$ontos", "\\u0024ontos", "\\u0024\\u006f\\u006e\\u0074\\u006f\\u0073", "$ont\\u006fs", "$Ontos", "$ontos ", "ontos", "$$ontos"]);
      const tag = rng.pick(['"int"', '"\\u0069nt"', '"INT"', '"bytes"']);
      const ctx = rng.pick([
        () => `{"${name}":[${tag},"1"]}`,
        () => `{"${name}":["bytes","AA=="],"x":1}`,
        () => `{"x":1,"${name}":["int","1"]}`,
        () => `{"$ontos":["map",[["${name}",null]]]}`,
        () => `{"$ontos":["map",[["${name}",null],["a",1]]]}`,
        () => `{"a":{"${name}":[${tag},"5"]}}`,
        () => `{"${name}":${rng.pick(["[]", "{}", "1", '"int"', "[1]", "null"])}}`,
        () => `{"${name}":[${JSON.stringify(rng.pick(BAD_TAGS))},"1"]}`,
      ])();
      return { input: te.encode(ctx), note: `the reserved name, spelled ${name}` };
    }],
    [3, "deep", (rng) => deep(profile, rng)],
    [5, "utf8", (rng) => {
      const text = serialize(spelledText(profile, rng).tree, rng, randomStyle(rng));
      const bad = Uint8Array.from(rng.pick(BAD_UTF8));
      const at = rng.below(text.length + 1);
      const prefix = rng.chance(0.5) ? te.encode(`["${multiByte(rng)}",`) : new Uint8Array(0);
      return { input: concat(prefix, text.subarray(0, at), bad, text.subarray(at)), note: `ill-formed UTF-8 ${bytesToHex(bad)} @${at}` };
    }],
    [4, "framing", (rng) => {
      const text = serialize(spelledText(profile, rng).tree, rng, randomStyle(rng));
      const junk = rng.pick(["x", ",", "]", "}", " 1", "//c", "/*c*/", "\u00a0", "\u2028", "\u000b", "\u000c", "\ufeff", "\u3000", "{}", "\u0000"]);
      return rng.pick([
        () => ({ input: concat("\ufeff", text), note: "a byte order mark" }),
        () => ({ input: concat(text, junk), note: `trailing ${JSON.stringify(junk)}` }),
        () => ({ input: concat(junk, text), note: `leading ${JSON.stringify(junk)}` }),
        () => ({ input: te.encode(rng.pick(["", " ", "\n\t", "\ufeff", "\ufeff ", "\u00a0"])), note: "an empty text" }),
      ])();
    }],
    [4, "duplicates", (rng) => {
      const mb = multiByte(rng);
      const ctx = rng.pick(
        R
          ? [
              `{"a":1,"\\u0061":2}`, `{"${mb}":1,"x":2,"${mb}":3}`, `{"\u00e9":1,"\\u00e9":2}`, `{"\u00e9":1,"e\\u0301":2}`,
              `{"$ontos":["map",[[1,null],[{"$ontos":["int","1"]},null]]]}`,
              `{"$ontos":["map",[["a",1],[{"$ontos":["raw",{"tuple":[{"atom":"7574662d38"},{"atom":"61"}]}]},2]]]}`,
              `{"$ontos":["map",[["a",1],[{"$ontos":["raw",{"tuple":[{"atom":"757466382d74657874"},{"atom":"61"}]}]},2]]]}`,
              `{"$ontos":["map",[["${mb}",1],["x",0],["${mb}",2]]]}`,
              `{"$ontos":["map",[[null,1],[{"$ontos":["raw",{"tuple":[{"atom":"6e756c6c"}]}]},2]]]}`,
              `{"$ontos":["map",[[{"$ontos":["decimal","1","2"]},1],[{"$ontos":["decimal","1","2"]},2]]]}`,
              `{"$ontos":["set",[[],{"$ontos":["compound","list",[]]}]]}`,
              `{"$ontos":["set",["${mb}",1,"${mb}"]]}`,
              `{"$ontos":["set",[{"$ontos":["bytes","AA=="]},{"$ontos":["raw",{"atom":"00"}]}]]}`,
            ]
          : [`{"atom":"00","atom":"01"}`, `{"atom":"00","\\u0061tom":"01"}`, `{"tuple":[],"tuple":[]}`, `{"tuple":[{"atom":"00","${mb}":1,"${mb}":2}]}`],
      );
      return { input: te.encode(ctx), note: "repeated names, keys or elements" };
    }],
    [L(profile) ? 5 : 2, "hex", (rng) => {
      const h = rng.chance(0.5) ? rng.pick(BAD_HEX) : hexOf(rng.bytes(rng.between(0, 6))).replace(/[a-f]/, (c) => (rng.chance(0.5) ? c.toUpperCase() : c));
      const total = rng.pick([`{"atom":"${h}"}`, `{"tuple":[{"atom":"${h}"}]}`]);
      return { input: te.encode(R ? `{"$ontos":["raw",${total}]}` : total), note: `hex ${JSON.stringify(h)}` };
    }],
    [12, "value", (rng) => ({ value: genValue(rng, rng.between(0, 5), { n: rng.between(1, 60) }), note: "a value to write" })],
    [6, "near miss", (rng) => ({ value: rng.chance(0.5) ? nearMiss(rng, 2, { n: 6 }) : vList([nearMiss(rng, 2, { n: 6 }), genValue(rng, 2, { n: 6 })]), note: "a value close to a registered kind" })],
    [R ? 4 : 2, "integers to write", (rng) => {
      const n = rng.chance(R ? 0.25 : 0) ? sign(rng) * BigInt(digitString(rng, rng.between(4295, 4305))) : genInt(rng);
      return { value: rng.pick([vInt(n), genDecimal(rng), vList([vInt(n)]), vMap([[vInt(n), vNull()]])]), note: "integers" };
    }],
    [2, "deep value", (rng) => deepValue(rng)],
  ].filter(([w]) => w > 0);
}

const L = (profile) => profile === "total";

// --- limits around a case's needs ---------------------------------------------------------

const BOUNDS = {
  total: ["max_text_bytes", "max_json_depth", "max_value_depth", "max_atom_bytes", "max_tuple_arity"],
  readable: ["max_text_bytes", "max_json_depth", "max_value_depth", "max_atom_bytes", "max_tuple_arity", "max_integer_digits"],
};

/** The bounds stage 4 checks at each node (total §4.4, readable §4.9), in their order. */
const VALUE_SIDE = ["max_value_depth", "max_tuple_arity", "max_integer_digits", "max_atom_bytes"];

function chooseLimits(profile, rng, needs) {
  // "under" lowers two or more value-side bounds below their needs at once, so that one node
  // exceeds several and the order of the checks decides the kind. A lowered stage 1-3 bound
  // would refuse before stage 4, so "under" leaves those alone, and when it lowers
  // max_value_depth it often raises max_json_depth past the text's depth, which the derived
  // bound would otherwise refuse first.
  const mode = rng.weighted([[46, "none"], [28, "one"], [14, "some"], [12, "under"]]);
  if (mode === "none") return undefined;
  const need = (name) => needs[name] ?? rng.between(0, 8);
  const out = {};
  if (mode === "under") {
    const side = VALUE_SIDE.filter((n) => BOUNDS[profile].includes(n));
    const lowered = rng.shuffle([...side]).slice(0, rng.between(2, side.length));
    for (const name of BOUNDS[profile]) {
      if (!lowered.includes(name)) continue;
      const n = need(name);
      out[name] = Math.max(0, n - rng.weighted([[6, 1], [2, 2], [1, n]]));
    }
    if (lowered.includes("max_value_depth") && rng.chance(0.7)) {
      out.max_json_depth = rng.chance(0.8) ? need("max_json_depth") + rng.between(0, 2) : MAX_LIMIT;
    }
    return out;
  }
  const names = rng.shuffle([...BOUNDS[profile]]).slice(0, mode === "one" ? 1 : rng.between(2, BOUNDS[profile].length));
  for (const name of BOUNDS[profile]) {
    if (!names.includes(name)) continue;
    const n = need(name);
    let v = rng.weighted([
      [5, n],
      [5, n - 1],
      [2, n + 1],
      [1, 0],
      [2, rng.between(0, 2 * n + 2)],
      [1, rng.between(0, 64)],
      [1, MAX_LIMIT],
    ]);
    v = Math.max(0, Math.min(v, MAX_LIMIT));
    if (name === "max_value_depth") v = Math.min(v, MAX_VALUE_DEPTH);
    out[name] = v;
  }
  // A lowered value depth bound with the derived JSON depth bound refuses in stage 3
  // (json_depth) first; an explicit JSON depth bound lets stage 4 decide (decode_depth).
  if (out.max_value_depth !== undefined && out.max_json_depth === undefined && rng.chance(0.35)) {
    out.max_json_depth = rng.chance(0.8) ? need("max_json_depth") + rng.between(0, 2) : MAX_LIMIT;
  }
  return out;
}

function needsOfValue(m) {
  return { max_value_depth: m.depth, max_atom_bytes: m.atom, max_tuple_arity: m.arity, max_integer_digits: m.digits };
}

// --- one case -------------------------------------------------------------------------------

function makeCase(profile, index, seed, pool) {
  const rng = new Rng(caseSeed(seed, profile, index));
  const [, fam, make] = (() => {
    const list = family(profile);
    return rng.weighted(list.map((f) => [f[0], f]));
  })();
  const made = make(rng, pool);
  const name = `${profile}-${String(index).padStart(6, "0")}-${fam.replace(/ /g, "-")}`;
  const c = { name, group: `fuzz:${fam}`, note: made.note };
  let value;
  let limits;
  if (made.input) {
    const bytes = made.input;
    const plain = expectRead(profile, bytes);
    const needs = { max_text_bytes: bytes.length, max_json_depth: jsonDepthOf(bytes) };
    if (!plain.refusal) Object.assign(needs, needsOfValue(measureValue(plain.value)));
    limits = chooseLimits(profile, rng, needs);
    const read = limits ? expectRead(profile, bytes, limits) : plain;
    // A valid spelling reads, without limits, to exactly the value the generator spelled (or
    // stops at a shipped default). The generator built that value with its own builders, so
    // this derives every such value twice; a disagreement stops the run.
    if (made.spells && !plain.refusal && plain.valueHex !== bytesToHex(Uint8Array.from(enc(made.spells)))) {
      throw new OracleDefect(`${name}: a valid spelling reads to another value: ${plain.valueHex}`);
    }
    if (made.spells && plain.refusal && plain.refusal.code !== "limit_exceeded") {
      throw new OracleDefect(`${name}: the oracle refuses a valid spelling: ${JSON.stringify(plain.refusal)}`);
    }
    if (isText(bytes)) c.input = td.decode(bytes);
    c.input_hex = bytesToHex(bytes);
    if (limits) c.limits = limits;
    if (read.refusal) {
      c.refusal = read.refusal;
      return c;
    }
    value = read.value;
    c.value_hex = read.valueHex;
    if (read.origins) {
      const rows = read.origins();
      let size = 0;
      for (const [vp, jp] of rows) size += vp.length + jp.length;
      if (size <= ORIGINS_CAP) c.origins = rows;
    }
  } else {
    value = made.value;
    const plain = expectWrite(profile, value);
    const needs = needsOfValue(measureValue(value));
    if (plain.output !== undefined) {
      const out = te.encode(plain.output);
      Object.assign(needs, { max_text_bytes: out.length, max_json_depth: jsonDepthOf(out) });
    }
    limits = chooseLimits(profile, rng, needs);
    if (limits) c.limits = limits;
    c.value_hex = bytesToHex(Uint8Array.from(enc(value)));
  }
  if (height(value) > MAX_VALUE_DEPTH) throw new Error(`${name}: a value deeper than ${MAX_VALUE_DEPTH}`);
  const w = expectWrite(profile, value, limits ?? {});
  if (w.renderRefusal) c.render_refusal = w.renderRefusal;
  else c.output = w.output;
  return order(c);
}

const FIELD_ORDER = ["name", "group", "note", "input", "input_hex", "limits", "value_hex", "output", "refusal", "render_refusal", "origins"];
const order = (c) => Object.fromEntries(FIELD_ORDER.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

// --- the corpus -------------------------------------------------------------------------------

function expandRuns(field) {
  if (field === null || typeof field !== "object") return field;
  return field.runs.map(([piece, count]) => piece.repeat(count)).join("");
}

/** The committed vectors' inputs, both files, which the mutations start from. */
function loadPool() {
  const pool = [];
  for (const file of ["total.json", "readable.json"]) {
    const doc = JSON.parse(readFileSync(join(VECTORS, file), "utf8"));
    for (const c of doc.cases) {
      if (c.input_hex !== undefined) pool.push({ name: `${file} ${c.name}`, bytes: hexToBytes(expandRuns(c.input_hex)) });
    }
  }
  return pool;
}

function tally(profile, cases) {
  const t = { cases: cases.length, refusals: 0, accepted: 0, writeOnly: 0, renderRefusals: 0, origins: 0, withLimits: 0, codes: {}, readKinds: {}, writeKinds: {} };
  for (const c of cases) {
    if (c.limits) t.withLimits++;
    if (c.origins) t.origins++;
    if (c.refusal) {
      t.refusals++;
      t.codes[c.refusal.code] = (t.codes[c.refusal.code] ?? 0) + 1;
      if (c.refusal.kind) t.readKinds[c.refusal.kind] = (t.readKinds[c.refusal.kind] ?? 0) + 1;
      continue;
    }
    if (c.input_hex !== undefined) t.accepted++;
    else t.writeOnly++;
    if (c.render_refusal) {
      t.renderRefusals++;
      t.writeKinds[c.render_refusal.kind] = (t.writeKinds[c.render_refusal.kind] ?? 0) + 1;
    }
  }
  const codes = profile === "total" ? CODES.shared : [...CODES.shared, ...CODES.readable];
  const missing = [
    ...codes.filter((code) => !t.codes[code]).map((code) => `read refusal ${code}`),
    ...KINDS[profile].filter((k) => !t.readKinds[k]).map((k) => `read limit kind ${k}`),
    ...KINDS[profile].filter((k) => !t.writeKinds[k]).map((k) => `write limit kind ${k}`),
    ...(t.accepted ? [] : ["an accepted read"]),
    ...(t.writeOnly ? [] : ["a value to write"]),
    ...(profile === "readable" && !t.origins ? ["origins"] : []),
  ];
  return { t, missing };
}

function corpusText(profile, cfg, cases) {
  const head = {
    profile: PROFILES[profile],
    codec: "ontos-codec-v1",
    description:
      "GENERATED by tools/json-projection/fuzz.mjs for the differential fuzz; not committed. Every expectation " +
      "(value_hex, output, refusal, render_refusal, origins) is computed by the oracle, tools/json-projection/check.mjs. " +
      "The format is projection/json/vectors/README.md's; the faces replay it through ONTOS_JSON_PROJECTION_VECTORS.",
    generator: "tools/json-projection/fuzz.mjs",
    seed: cfg.seedHex,
    count: cases.length,
  };
  const top = JSON.stringify(head);
  return `${top.slice(0, -1)},\n"cases":[\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`;
}

function run(cfg) {
  const pool = loadPool();
  if (cfg.only) {
    const c = makeCase(cfg.only.profile, cfg.only.index, cfg.seed, pool);
    process.stdout.write(JSON.stringify(c, null, 1) + "\n");
    return 0;
  }
  mkdirSync(cfg.out, { recursive: true });
  let shortfall = 0;
  for (const profile of ["total", "readable"]) {
    const cases = [];
    let i = 0;
    for (; i < cfg.count; i++) cases.push(makeCase(profile, i, cfg.seed, pool));
    let { t, missing } = tally(profile, cases);
    const before = missing;
    while (missing.length && cfg.count >= COVERAGE_FLOOR && i < 2 * cfg.count) {
      for (const end = Math.min(i + 100, 2 * cfg.count); i < end; i++) cases.push(makeCase(profile, i, cfg.seed, pool));
      ({ t, missing } = tally(profile, cases));
    }
    if (cases.length > cfg.count) {
      console.log(`json-projection fuzz: ${profile}: ${cases.length - cfg.count} more cases drawn to exercise ${before.join(", ")}`);
    }
    writeFileSync(join(cfg.out, `${profile}.json`), corpusText(profile, cfg, cases));
    console.log(
      `json-projection fuzz: ${profile}.json: ${t.cases} cases: ${t.refusals} read refusals, ${t.accepted} accepted reads, ` +
        `${t.writeOnly} values to write, ${t.renderRefusals} write refusals, ${t.origins} with origins, ${t.withLimits} with limits`,
    );
    console.log(`  codes ${JSON.stringify(t.codes)}`);
    console.log(`  read kinds ${JSON.stringify(t.readKinds)}  write kinds ${JSON.stringify(t.writeKinds)}`);
    if (missing.length) {
      const msg = `  ${profile}: the corpus leaves unexercised: ${missing.join(", ")}`;
      if (cfg.count >= COVERAGE_FLOOR) {
        console.error(msg);
        shortfall++;
      } else console.log(`${msg} (under ${COVERAGE_FLOOR} cases, reported only)`);
    }
  }
  console.log(`json-projection fuzz: wrote ${resolve(cfg.out)}/{total,readable}.json; replay with SEED=${cfg.seedHex}`);
  return shortfall ? 1 : 0;
}

// --- the command line -------------------------------------------------------------------------

function fnv1a64(s) {
  let h = 14695981039346656037n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    h = (h * 1099511628211n) & M64;
  }
  return h;
}

function parseArgs(argv) {
  const cfg = { seed: null, seedSource: "", count: DEFAULT_COUNT, out: "json-projection-corpus", only: null };
  let seedArg = "fresh";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--seed") seedArg = val();
    else if (a === "--count") {
      cfg.count = Number(val());
      if (!Number.isInteger(cfg.count) || cfg.count < 1 || cfg.count > 1000000) throw new Error("--count must be an integer in [1, 1000000]");
    } else if (a === "--out") cfg.out = val();
    else if (a === "--case") {
      const m = /^(total|readable):(\d+)$/.exec(val());
      if (!m) throw new Error("--case takes total:<i> or readable:<i>");
      cfg.only = { profile: m[1], index: Number(m[2]) };
    } else throw new Error(`unknown argument ${a}`);
  }
  if (seedArg === "fresh") {
    const sha = (process.env.GITHUB_SHA ?? "").trim();
    if (sha) [cfg.seed, cfg.seedSource] = [fnv1a64(`json-projection:${sha}`), `GITHUB_SHA=${sha}`];
    else [cfg.seed, cfg.seedSource] = [BigInt.asUintN(64, BigInt(Date.now()) ^ (BigInt(process.pid) << 32n)), "time+pid"];
  } else {
    let v;
    try {
      v = BigInt(seedArg.trim());
    } catch {
      throw new Error(`--seed must be a u64 (decimal or 0x-hex) or "fresh", got ${JSON.stringify(seedArg)}`);
    }
    if (v < 0n || v > M64) throw new Error(`--seed must be in [0, 2^64), got ${seedArg}`);
    [cfg.seed, cfg.seedSource] = [v, "--seed"];
  }
  cfg.seedHex = `0x${cfg.seed.toString(16).padStart(16, "0")}`;
  return cfg;
}

if (isMainThread) {
  let cfg;
  try {
    cfg = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`json-projection fuzz: ${e.message}`);
    console.error("usage: node tools/json-projection/fuzz.mjs [--seed <u64>|fresh] [--count <N>] [--out <dir>] [--case <total|readable>:<i>]");
    process.exit(2);
  }
  if (!cfg.only) console.log(`json-projection fuzz: SEED=${cfg.seedHex} source=${cfg.seedSource} count=${cfg.count} per profile`);
  // Deep cases nest some 3000 levels, and the oracle reads and writes recursively.
  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { ...cfg, seed: cfg.seed.toString() },
    resourceLimits: { stackSizeMb: 256 },
  });
  worker.on("message", (code) => (process.exitCode = code));
  worker.on("error", (e) => {
    console.error(e);
    process.exitCode = 1;
  });
} else {
  parentPort.postMessage(run({ ...workerData, seed: BigInt(workerData.seed) }));
}
