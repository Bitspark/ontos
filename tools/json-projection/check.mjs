#!/usr/bin/env node
/*
 * check.mjs — the independent checker for the JSON projection vectors.
 *
 * It validates every case of projection/json/vectors/{total,readable}.json against
 * docs/spec/ontos-total-json.md and docs/spec/ontos-readable-json.md with its OWN reader
 * and writer, written from those pages. It imports nothing: no @bitspark/ontos-* package
 * and no JSON.parse on the inputs under test. The codec, the ontos/data recognizers, the
 * strict JSON reader, both interpreters and both writers below are all its own. (JSON.parse
 * reads only the vector files themselves.)
 *
 * For each case it checks, independently:
 *   - input_hex is the UTF-8 of `input` when `input` is given;
 *   - value_hex is the codec encoding of the case's `value` datum, built here with this
 *     file's own ontos/data encoders (tools/json-projection/gen.mjs derives the same bytes
 *     with the frozen @bitspark/ontos-data and -codec packages, so the two cross-check);
 *   - reading input_hex gives exactly value_hex, or exactly the pinned refusal
 *     (code, path, span and, for a limit, kind);
 *   - writing the value gives exactly `output`, or the pinned render refusal (code, kind);
 *   - the laws on every accepted case: R(output) = value, W(R(output)) = output;
 *   - origins, where a case pins them.
 *
 * Deep cases nest about 3000 levels, so the work runs in a worker with a large stack.
 * Run: node tools/json-projection/check.mjs [vectors-dir]   (scripts/check.sh vectors runs it)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// --- bytes, hex, runs ----------------------------------------------------------------

const te = new TextEncoder();

function hexToBytes(h) {
  if (typeof h !== "string" || h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) {
    throw new Error(`not even-length lowercase hex: ${String(h).slice(0, 40)}`);
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(2 * i, 2), 16);
  return out;
}

function bytesToHex(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesCmp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** A field is a plain value, or {"runs": [[piece, count], …]} concatenated (README). */
function expandRuns(field) {
  if (field === null || typeof field !== "object" || Array.isArray(field)) return field;
  if (!Array.isArray(field.runs)) throw new Error(`bad runs field: ${JSON.stringify(field).slice(0, 60)}`);
  const pieces = [];
  let isArray = null;
  for (const [piece, count] of field.runs) {
    if (!Number.isInteger(count) || count < 0) throw new Error("bad run count");
    if (isArray === null) isArray = Array.isArray(piece);
    if (isArray !== Array.isArray(piece)) throw new Error("runs mix strings and arrays");
    for (let i = 0; i < count; i++) pieces.push(piece);
  }
  return isArray ? pieces.flat() : pieces.join("");
}

// --- L0 values and the codec (ontos-codec.md §2) --------------------------------------

const atom = (bytes) => ({ a: bytes });
const tuple = (items) => ({ t: items });
const isAtom = (v) => v.a !== undefined;

function uvarint(n, out) {
  while (n >= 128) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function encodeInto(v, out) {
  if (isAtom(v)) {
    out.push(0);
    uvarint(v.a.length, out);
    for (const x of v.a) out.push(x);
  } else {
    out.push(1);
    uvarint(v.t.length, out);
    for (const c of v.t) encodeInto(c, out);
  }
}

function encode(v) {
  const out = [];
  encodeInto(v, out);
  return Uint8Array.from(out);
}

function decode(b) {
  let p = 0;
  const uv = () => {
    let n = 0;
    let mul = 1;
    for (let i = 0; ; i++) {
      if (p >= b.length) throw new Error("codec: unexpected end");
      const x = b[p++];
      n += (x & 0x7f) * mul;
      if (x < 0x80) {
        if (x === 0 && i > 0) throw new Error("codec: non-canonical uvarint");
        return n;
      }
      mul *= 128;
    }
  };
  const val = () => {
    const tag = b[p++];
    if (tag === 0) {
      const len = uv();
      if (p + len > b.length) throw new Error("codec: unexpected end");
      const a = b.slice(p, p + len);
      p += len;
      return atom(a);
    }
    if (tag === 1) {
      const n = uv();
      const items = [];
      for (let i = 0; i < n; i++) items.push(val());
      return tuple(items);
    }
    throw new Error("codec: unknown tag");
  };
  const v = val();
  if (p !== b.length) throw new Error("codec: trailing bytes");
  return v;
}

// --- ontos/data: labels, encoders and recognizers (ontos-data.md §5) ------------------

const LABELS = ["int", "utf8-text", "bool", "list", "map", "set", "decimal", "null"];
const labelAtom = (s) => atom(te.encode(s));

function intPayload(n) {
  if (n === 0n) return Uint8Array.of(0);
  const neg = n < 0n;
  let h = (neg ? -n : n).toString(16);
  if (h.length % 2) h = "0" + h;
  return Uint8Array.from([neg ? 1 : 0, ...hexToBytes(h)]);
}

const intVal = (n) => tuple([labelAtom("int"), atom(intPayload(n))]);
const textVal = (bytes) => tuple([labelAtom("utf8-text"), atom(bytes)]);
const boolVal = (b) => tuple([labelAtom("bool"), atom(Uint8Array.of(b ? 1 : 0))]);
const nullVal = () => tuple([labelAtom("null")]);
const listVal = (items) => tuple([labelAtom("list"), ...items]);
const decimalVal = (m, e) => tuple([labelAtom("decimal"), intVal(m), intVal(e)]);

function sortedUnique(items, keyOf, what) {
  const withKeys = items.map((it) => ({ it, k: encode(keyOf(it)) }));
  withKeys.sort((x, y) => bytesCmp(x.k, y.k));
  for (let i = 1; i < withKeys.length; i++) {
    if (bytesEq(withKeys[i - 1].k, withKeys[i].k)) throw new Error(`duplicate ${what} in a datum`);
  }
  return withKeys.map((x) => x.it);
}

const mapVal = (entries) =>
  tuple([labelAtom("map"), ...sortedUnique(entries, (e) => e[0], "map key").map(([k, v]) => tuple([k, v]))]);
const setVal = (elems) => tuple([labelAtom("set"), ...sortedUnique(elems, (e) => e, "set element")]);

function labelString(v) {
  if (isAtom(v) || v.t.length === 0 || !isAtom(v.t[0])) return null;
  const l = v.t[0].a;
  for (const name of LABELS) if (bytesEq(l, te.encode(name))) return name;
  return "";
}

function intOf(payload) {
  let n = 0n;
  for (let i = 1; i < payload.length; i++) n = (n << 8n) | BigInt(payload[i]);
  return payload[0] === 1 ? -n : n;
}

function isCanonIntPayload(p) {
  if (p.length === 0 || p[0] > 1) return false;
  if (p.length === 1) return p[0] === 0;
  return p[1] !== 0;
}

function isCanonInt(v) {
  return labelString(v) === "int" && v.t.length === 2 && isAtom(v.t[1]) && isCanonIntPayload(v.t[1].a);
}

/** Recognize v as one of the eight kinds (readable §2.3 step 1), or return null. */
function recognize(v) {
  const kind = labelString(v);
  if (!kind) return null;
  const c = v.t;
  switch (kind) {
    case "null":
      return c.length === 1 ? { kind } : null;
    case "bool":
      return c.length === 2 && isAtom(c[1]) && c[1].a.length === 1 && c[1].a[0] <= 1 ? { kind, b: c[1].a[0] === 1 } : null;
    case "utf8-text":
      return c.length === 2 && isAtom(c[1]) && utf8Fault(c[1].a) === null ? { kind, bytes: c[1].a } : null;
    case "int":
      return isCanonInt(v) ? { kind, n: intOf(c[1].a) } : null;
    case "list":
      return { kind, items: c.slice(1) };
    case "map": {
      const entries = c.slice(1);
      if (!entries.every((e) => !isAtom(e) && e.t.length === 2)) return null;
      for (let i = 1; i < entries.length; i++) {
        if (bytesCmp(encode(entries[i - 1].t[0]), encode(entries[i].t[0])) >= 0) return null;
      }
      return { kind, entries: entries.map((e) => e.t) };
    }
    case "set": {
      const items = c.slice(1);
      for (let i = 1; i < items.length; i++) if (bytesCmp(encode(items[i - 1]), encode(items[i])) >= 0) return null;
      return { kind, items };
    }
    case "decimal": {
      if (c.length !== 3 || !isCanonInt(c[1]) || !isCanonInt(c[2])) return null;
      const m = intOf(c[1].t[1].a);
      const e = intOf(c[2].t[1].a);
      if (m === 0n ? e !== 0n : m % 10n === 0n) return null;
      return { kind, m, e };
    }
  }
  return null;
}

// --- the vectors' datum notation (README), built with this file's own encoders --------

function buildDatum(d) {
  if (!Array.isArray(d) || typeof d[0] !== "string") throw new Error(`bad datum ${JSON.stringify(d)}`);
  const [op, ...a] = d;
  switch (op) {
    case "atom":
      return atom(hexToBytes(a[0]));
    case "utf8":
      return atom(te.encode(a[0]));
    case "tuple":
      return tuple(a[0].map(buildDatum));
    case "compound":
      return tuple([atom(te.encode(a[0])), ...a[1].map(buildDatum)]);
    case "int":
      if (!/^(0|-?[1-9][0-9]*)$/.test(a[0])) throw new Error(`datum int not canonical: ${a[0]}`);
      return intVal(BigInt(a[0]));
    case "text":
      return textVal(te.encode(a[0]));
    case "bool":
      return boolVal(a[0]);
    case "null":
      return nullVal();
    case "list":
      return listVal(a[0].map(buildDatum));
    case "map":
      return mapVal(a[0].map(([k, v]) => [buildDatum(k), buildDatum(v)]));
    case "set":
      return setVal(a[0].map(buildDatum));
    case "decimal": {
      const m = BigInt(a[0]);
      const e = BigInt(a[1]);
      if (m === 0n ? e !== 0n : m % 10n === 0n) throw new Error("datum decimal not canonical");
      return decimalVal(m, e);
    }
    case "deep": {
      const [n, kind, inner] = a;
      let v = buildDatum(inner);
      const wrap = (x) =>
        kind === "tuple" ? tuple([x]) : kind === "list" ? listVal([x]) : tuple([atom(te.encode(kind[1])), x]);
      for (let i = 0; i < n; i++) v = wrap(v);
      return v;
    }
  }
  throw new Error(`unknown datum op ${op}`);
}

// --- refusals, paths ----------------------------------------------------------------

class Refusal extends Error {
  constructor(code, path, span, kind) {
    super(`${code}${kind ? `/${kind}` : ""} at ${JSON.stringify(path)} ${JSON.stringify(span)}`);
    this.code = code;
    this.path = path;
    this.span = span;
    this.kind = kind;
  }
}

/** Paths are persistent linked lists while reading, arrays in refusals. */
const ext = (path, seg) => ({ up: path, seg });
function toArr(path) {
  const out = [];
  for (let p = path; p; p = p.up) out.push(p.seg);
  return out.reverse();
}

function refuse(code, path, span) {
  throw new Refusal(code, toArr(path), span, undefined);
}
function limit(kind, path, span) {
  throw new Refusal("limit_exceeded", toArr(path), span, kind);
}

// --- stage 2: UTF-8 (total §4.2) -------------------------------------------------------

/** The span [s, e) of the first maximal ill-formed subpart, or null when well-formed. */
function utf8Fault(b) {
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) {
      i++;
      continue;
    }
    let need;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c === 0xe0) [need, lo] = [2, 0xa0];
    else if ((c >= 0xe1 && c <= 0xec) || c === 0xee || c === 0xef) need = 2;
    else if (c === 0xed) [need, hi] = [2, 0x9f];
    else if (c === 0xf0) [need, lo] = [3, 0x90];
    else if (c >= 0xf1 && c <= 0xf3) need = 3;
    else if (c === 0xf4) [need, hi] = [3, 0x8f];
    else return [i, i + 1];
    let j = i + 1;
    for (let k = 0; k < need; k++, j++) {
      const l = k === 0 ? lo : 0x80;
      const h = k === 0 ? hi : 0xbf;
      if (j >= n || b[j] < l || b[j] > h) return [i, j];
    }
    i = j;
  }
  return null;
}

// --- stage 3: the strict JSON reading (total §4.3) -------------------------------------

function lex(b, maxJsonDepth) {
  const n = b.length;
  let p = 0;
  const isWs = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
  const isDigit = (c) => c >= 0x30 && c <= 0x39;
  const isHex = (c) => isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
  const ws = () => {
    while (p < n && isWs(b[p])) p++;
  };
  const charLen = (q) => (b[q] < 0x80 ? 1 : b[q] < 0xe0 ? 2 : b[q] < 0xf0 ? 3 : 4);
  const charSpan = (q) => (q >= n ? [n, n] : [q, q + charLen(q)]);
  const cpAt = (q) => {
    const c = b[q];
    if (c < 0x80) return c;
    if (c < 0xe0) return ((c & 0x1f) << 6) | (b[q + 1] & 0x3f);
    if (c < 0xf0) return ((c & 0x0f) << 12) | ((b[q + 1] & 0x3f) << 6) | (b[q + 2] & 0x3f);
    return ((c & 0x07) << 18) | ((b[q + 1] & 0x3f) << 12) | ((b[q + 2] & 0x3f) << 6) | (b[q + 3] & 0x3f);
  };

  if (n >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) refuse("byte_order_mark", null, [0, 3]);
  ws();
  const root = value(null, 0);
  ws();
  if (p < n) refuse("trailing_data", null, [p, n]);
  return root;

  function value(path, k) {
    if (p >= n) refuse("invalid_json", path, [n, n]);
    const c = b[p];
    if (c === 0x7b) return object(path, k);
    if (c === 0x5b) return array(path, k);
    if (c === 0x22) {
      const s = p;
      const v = string(path);
      return { t: "str", v, s, e: p };
    }
    if (c === 0x74) return literal("true", path);
    if (c === 0x66) return literal("false", path);
    if (c === 0x6e) return literal("null", path);
    if (c === 0x2d || isDigit(c)) return number(path);
    refuse("invalid_json", path, charSpan(p));
  }

  function object(path, k) {
    if (k + 1 > maxJsonDepth) limit("json_depth", path, [p, p + 1]);
    const s = p;
    p++;
    ws();
    const members = [];
    const names = new Set();
    if (p < n && b[p] === 0x7d) {
      p++;
      return { t: "obj", members, s, e: p };
    }
    for (;;) {
      if (p >= n || b[p] !== 0x22) refuse("invalid_json", path, charSpan(p));
      const ns = p;
      const name = string(path);
      const ne = p;
      const mpath = ext(path, name);
      if (names.has(name)) refuse("duplicate_member", mpath, [ns, ne]);
      names.add(name);
      ws();
      if (p >= n || b[p] !== 0x3a) refuse("invalid_json", mpath, charSpan(p));
      p++;
      ws();
      members.push({ name, ns, ne, value: value(mpath, k + 1) });
      ws();
      if (p < n && b[p] === 0x2c) {
        p++;
        ws();
        continue;
      }
      if (p < n && b[p] === 0x7d) {
        p++;
        return { t: "obj", members, s, e: p };
      }
      refuse("invalid_json", path, charSpan(p));
    }
  }

  function array(path, k) {
    if (k + 1 > maxJsonDepth) limit("json_depth", path, [p, p + 1]);
    const s = p;
    p++;
    ws();
    const items = [];
    if (p < n && b[p] === 0x5d) {
      p++;
      return { t: "arr", items, s, e: p };
    }
    for (let i = 0; ; i++) {
      items.push(value(ext(path, i), k + 1));
      ws();
      if (p < n && b[p] === 0x2c) {
        p++;
        ws();
        continue;
      }
      if (p < n && b[p] === 0x5d) {
        p++;
        return { t: "arr", items, s, e: p };
      }
      refuse("invalid_json", path, charSpan(p));
    }
  }

  function hex4(at, path) {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      if (at + i >= n) refuse("invalid_json", path, [n, n]);
      if (!isHex(b[at + i])) refuse("invalid_json", path, charSpan(at + i));
      v = v * 16 + parseInt(String.fromCharCode(b[at + i]), 16);
    }
    return v;
  }

  function string(path) {
    p++;
    let out = "";
    for (;;) {
      if (p >= n) refuse("invalid_json", path, [n, n]);
      const c = b[p];
      if (c === 0x22) {
        p++;
        return out;
      }
      if (c < 0x20) refuse("invalid_json", path, [p, p + 1]);
      if (c === 0x5c) {
        if (p + 1 >= n) refuse("invalid_json", path, [n, n]);
        const e = b[p + 1];
        const simple = { 0x22: '"', 0x5c: "\\", 0x2f: "/", 0x62: "\b", 0x66: "\f", 0x6e: "\n", 0x72: "\r", 0x74: "\t" }[e];
        if (simple !== undefined) {
          out += simple;
          p += 2;
          continue;
        }
        if (e === 0x75) {
          const q = p;
          const cp = hex4(p + 2, path);
          if (cp >= 0xd800 && cp <= 0xdbff) {
            const pairs =
              q + 12 <= n && b[q + 6] === 0x5c && b[q + 7] === 0x75 && [8, 9, 10, 11].every((i) => isHex(b[q + i]));
            if (pairs) {
              const lo = parseInt(String.fromCharCode(...b.subarray(q + 8, q + 12)), 16);
              if (lo >= 0xdc00 && lo <= 0xdfff) {
                out += String.fromCharCode(cp, lo);
                p += 12;
                continue;
              }
            }
            refuse("invalid_unicode_escape", path, [q, q + 6]);
          }
          if (cp >= 0xdc00 && cp <= 0xdfff) refuse("invalid_unicode_escape", path, [q, q + 6]);
          out += String.fromCharCode(cp);
          p += 6;
          continue;
        }
        refuse("invalid_json", path, [p, p + 1 + charLen(p + 1)]);
      }
      out += String.fromCodePoint(cpAt(p));
      p += charLen(p);
    }
  }

  function literal(word, path) {
    const s = p;
    for (let i = 0; i < word.length; i++) {
      if (p + i >= n) refuse("invalid_json", path, [n, n]);
      if (b[p + i] !== word.charCodeAt(i)) refuse("invalid_json", path, charSpan(p + i));
    }
    p += word.length;
    return { t: "lit", v: word, s, e: p };
  }

  function number(path) {
    const s = p;
    const digits = () => {
      if (p >= n) refuse("invalid_json", path, [n, n]);
      if (!isDigit(b[p])) refuse("invalid_json", path, charSpan(p));
      while (p < n && isDigit(b[p])) p++;
    };
    if (b[p] === 0x2d) p++;
    if (p < n && b[p] === 0x30) p++;
    else digits();
    if (p < n && b[p] === 0x2e) {
      p++;
      digits();
    }
    if (p < n && (b[p] === 0x65 || b[p] === 0x45)) {
      p++;
      if (p < n && (b[p] === 0x2b || b[p] === 0x2d)) p++;
      digits();
    }
    return { t: "num", lex: String.fromCharCode(...b.subarray(s, p)), s, e: p };
  }
}

// --- limits (total §9, readable §9) --------------------------------------------------

const LIMIT_KEYS = [
  "max_text_bytes",
  "max_json_depth",
  "max_value_depth",
  "max_atom_bytes",
  "max_tuple_arity",
  "max_integer_digits",
];

/**
 * The effective limits of a case: the profile's own defaults (total §9.2, readable §9), then
 * the case's overrides. max_json_depth, unless set explicitly, is derived from the effective
 * max_value_depth: 2v + 2 for total, 3v + 4 for readable.
 */
function limitsFor(profile, overrides = {}) {
  const L = {
    max_text_bytes: Infinity,
    max_value_depth: 1024,
    max_atom_bytes: Infinity,
    max_tuple_arity: Infinity,
    max_integer_digits: profile === "total" ? Infinity : 4300,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (!LIMIT_KEYS.includes(k)) throw new Error(`unknown limit ${k}`);
    if (profile === "total" && k === "max_integer_digits") throw new Error("total has no max_integer_digits");
    if (!Number.isInteger(v) || v < 0) throw new Error(`bad limit ${k}=${v}`);
    L[k] = v;
  }
  if (L.max_json_depth === undefined) {
    const v = L.max_value_depth;
    L.max_json_depth = profile === "total" ? 2 * v + 2 : 3 * v + 4;
  }
  return L;
}

/** A node's contribution, checked in the order of readable §4.9 (total §4.4 the same). */
function checkContribution(L, depth, arity, digits, atomLens, fail) {
  if (depth > L.max_value_depth) fail("decode_depth");
  if (arity > L.max_tuple_arity) fail("tuple_arity");
  if (digits > L.max_integer_digits) fail("integer_digits");
  for (const len of atomLens()) if (len > L.max_atom_bytes) fail("atom_bytes");
}

// --- stage 4: interpretation, with origins (total §4.4, readable §4) -----------------

/** An origin tree mirrors a value: { at: [jsonPath, span], kids: [...] }. */
function uniform(v, at) {
  return { at, kids: isAtom(v) ? [] : v.t.map((c) => uniform(c, at)) };
}

const span = (x) => [x.s, x.e];

function interpTotal(x, d, path, L) {
  const at = () => [toArr(path), span(x)];
  if (x.t !== "obj" || x.members.length !== 1) refuse("invalid_total_form", path, span(x));
  const m = x.members[0];
  const nodeFail = (kind) => limit(kind, path, span(x));
  if (m.name === "atom") {
    const y = m.value;
    const yp = ext(path, "atom");
    if (y.t !== "str") refuse("invalid_total_form", yp, span(y));
    if (!/^(?:[0-9a-f]{2})*$/.test(y.v)) refuse("invalid_hex", yp, span(y));
    checkContribution(L, d, -1, -1, () => [y.v.length / 2], nodeFail);
    const v = atom(hexToBytes(y.v));
    return [v, { at: at(), kids: [] }];
  }
  if (m.name === "tuple") {
    const y = m.value;
    const yp = ext(path, "tuple");
    if (y.t !== "arr") refuse("invalid_total_form", yp, span(y));
    checkContribution(L, d, y.items.length, -1, () => [], nodeFail);
    const items = [];
    const kids = [];
    y.items.forEach((c, i) => {
      const [v, o] = interpTotal(c, d + 1, ext(yp, i), L);
      items.push(v);
      kids.push(o);
    });
    return [tuple(items), { at: at(), kids }];
  }
  refuse("invalid_total_form", path, span(x));
}

const MAX_SAFE = 9007199254740991n;
const INT_TEXT = /^(0|-?[1-9][0-9]*)$/;
const TAG_ARITY = { bytes: 2, int: 2, decimal: 3, map: 2, set: 2, compound: 3, raw: 2 };
const digitCount = (s) => s.replace("-", "").length;

function interpReadable(x, d, path, L) {
  const at = [toArr(path), span(x)];
  const nodeFail = (kind) => limit(kind, path, span(x));
  switch (x.t) {
    case "lit": {
      if (x.v === "null") {
        checkContribution(L, d + 1, 1, -1, () => [4], nodeFail);
        const v = nullVal();
        return [v, uniform(v, at)];
      }
      checkContribution(L, d + 1, 2, -1, () => [4, 1], nodeFail);
      const v = boolVal(x.v === "true");
      return [v, uniform(v, at)];
    }
    case "str": {
      const bytes = te.encode(x.v);
      checkContribution(L, d + 1, 2, -1, () => [9, bytes.length], nodeFail);
      const v = textVal(bytes);
      return [v, uniform(v, at)];
    }
    case "num": {
      if (/[.eE]/.test(x.lex)) refuse("invalid_number", path, span(x));
      const n = BigInt(x.lex);
      if (n > MAX_SAFE || n < -MAX_SAFE) refuse("unsafe_integer_literal", path, span(x));
      let v;
      checkContribution(L, d + 1, 2, digitCount(x.lex), () => {
        v = intVal(n);
        return [3, v.t[1].a.length];
      }, nodeFail);
      return [v, uniform(v, at)];
    }
    case "arr": {
      checkContribution(L, d + 1, x.items.length + 1, -1, () => [4], nodeFail);
      const label = labelAtom("list");
      const items = [label];
      const kids = [uniform(label, at)];
      x.items.forEach((c, i) => {
        const [v, o] = interpReadable(c, d + 1, ext(path, i), L);
        items.push(v);
        kids.push(o);
      });
      return [tuple(items), { at, kids }];
    }
    case "obj": {
      if (x.members.some((m) => m.name === "$ontos")) return envelope(x, d, path, L);
      const n = x.members.length;
      const keys = x.members.map((m) => te.encode(m.name));
      checkContribution(
        L,
        n ? d + 3 : d + 1,
        n ? Math.max(n + 1, 2) : 1,
        -1,
        () => [3, ...(n ? [9] : []), ...keys.map((k) => k.length)],
        nodeFail,
      );
      const entries = x.members.map((m, i) => {
        const mp = ext(path, m.name);
        const [v, vo] = interpReadable(m.value, d + 2, mp, L);
        const k = textVal(keys[i]);
        return {
          k,
          v,
          kEnc: encode(k),
          o: { at: [toArr(mp), [m.ns, m.value.e]], kids: [uniform(k, [toArr(mp), [m.ns, m.ne]]), vo] },
        };
      });
      return mapResult(entries, at);
    }
  }
  throw new Error(`unknown node ${x.t}`);
}

function mapResult(entries, at) {
  entries.sort((a, b) => bytesCmp(a.kEnc, b.kEnc));
  const label = labelAtom("map");
  return [
    tuple([label, ...entries.map((e) => tuple([e.k, e.v]))]),
    { at, kids: [uniform(label, at), ...entries.map((e) => e.o)] },
  ];
}

function b64Decode(s) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return null;
  const alphabet = B64;
  const out = [];
  for (let i = 0; i < s.length; i += 4) {
    const q = [...s.slice(i, i + 4)].map((ch) => (ch === "=" ? 0 : alphabet.indexOf(ch)));
    const n = (q[0] << 18) | (q[1] << 12) | (q[2] << 6) | q[3];
    out.push((n >> 16) & 0xff);
    if (s[i + 2] !== "=") out.push((n >> 8) & 0xff);
    if (s[i + 3] !== "=") out.push(n & 0xff);
  }
  const bytes = Uint8Array.from(out);
  return b64Encode(bytes) === s ? bytes : null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64Encode(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += i + 1 < b.length ? B64[(n >> 6) & 63] : "=";
    s += i + 2 < b.length ? B64[n & 63] : "=";
  }
  return s;
}

function envelope(x, d, path, L) {
  const at = [toArr(path), span(x)];
  const nodeFail = (kind) => limit(kind, path, span(x));
  if (x.members.length !== 1) refuse("invalid_envelope", path, span(x));
  const y = x.members[0].value;
  const yp = ext(path, "$ontos");
  if (y.t !== "arr" || y.items.length === 0) refuse("invalid_envelope", yp, span(y));
  const el = (i) => y.items[i];
  const elp = (i) => ext(yp, i);
  if (el(0).t !== "str") refuse("invalid_envelope", elp(0), span(el(0)));
  const tag = el(0).v;
  if (!Object.hasOwn(TAG_ARITY, tag)) refuse("unknown_tag", elp(0), span(el(0)));
  if (y.items.length !== TAG_ARITY[tag]) refuse("invalid_tag", yp, span(y));
  const str = (node, np) => {
    if (node.t !== "str") refuse("invalid_tag", np, span(node));
    return node.v;
  };
  switch (tag) {
    case "bytes": {
      const bytes = b64Decode(str(el(1), elp(1)));
      if (!bytes) refuse("invalid_base64", elp(1), span(el(1)));
      checkContribution(L, d, -1, -1, () => [bytes.length], nodeFail);
      const v = atom(bytes);
      return [v, uniform(v, at)];
    }
    case "int": {
      const s = str(el(1), elp(1));
      if (!INT_TEXT.test(s)) refuse("invalid_integer", elp(1), span(el(1)));
      let v;
      checkContribution(L, d + 1, 2, digitCount(s), () => {
        v = intVal(BigInt(s));
        return [3, v.t[1].a.length];
      }, nodeFail);
      return [v, uniform(v, at)];
    }
    case "decimal": {
      const comps = [1, 2].map((i) => {
        const s = str(el(i), elp(i));
        if (!INT_TEXT.test(s)) refuse("invalid_integer", elp(i), span(el(i)));
        return s;
      });
      const [m, e] = comps;
      if (m === "0" && e !== "0") refuse("noncanonical_decimal", elp(2), span(el(2)));
      if (m !== "0" && m.endsWith("0")) refuse("noncanonical_decimal", elp(1), span(el(1)));
      let v;
      checkContribution(L, d + 2, 3, Math.max(digitCount(m), digitCount(e)), () => {
        v = decimalVal(BigInt(m), BigInt(e));
        return [7, 3, v.t[1].t[1].a.length, 3, v.t[2].t[1].a.length];
      }, nodeFail);
      return [v, uniform(v, at)];
    }
    case "map": {
      const arr = el(1);
      const ap = elp(1);
      if (arr.t !== "arr") refuse("invalid_tag", ap, span(arr));
      arr.items.forEach((en, j) => {
        if (en.t !== "arr" || en.items.length !== 2) refuse("invalid_tag", ext(ap, j), span(en));
      });
      const n = arr.items.length;
      checkContribution(L, d + 1, n ? Math.max(n + 1, 2) : 1, -1, () => [3], nodeFail);
      const entries = [];
      arr.items.forEach((en, j) => {
        const ep = ext(ap, j);
        const [k, ko] = interpReadable(en.items[0], d + 2, ext(ep, 0), L);
        const kEnc = encode(k);
        if (entries.some((e) => bytesEq(e.kEnc, kEnc))) refuse("duplicate_map_key", ext(ep, 0), span(en.items[0]));
        const [v, vo] = interpReadable(en.items[1], d + 2, ext(ep, 1), L);
        entries.push({ k, v, kEnc, o: { at: [toArr(ep), span(en)], kids: [ko, vo] } });
      });
      return mapResult(entries, at);
    }
    case "set": {
      const arr = el(1);
      const ap = elp(1);
      if (arr.t !== "arr") refuse("invalid_tag", ap, span(arr));
      checkContribution(L, d + 1, arr.items.length + 1, -1, () => [3], nodeFail);
      const elems = [];
      arr.items.forEach((node, j) => {
        const [v, o] = interpReadable(node, d + 1, ext(ap, j), L);
        const enc = encode(v);
        if (elems.some((e) => bytesEq(e.enc, enc))) refuse("duplicate_set_element", ext(ap, j), span(node));
        elems.push({ v, o, enc });
      });
      elems.sort((a, b) => bytesCmp(a.enc, b.enc));
      const label = labelAtom("set");
      return [tuple([label, ...elems.map((e) => e.v)]), { at, kids: [uniform(label, at), ...elems.map((e) => e.o)] }];
    }
    case "compound": {
      const lab = el(1);
      const lp = elp(1);
      let labelBytes;
      if (lab.t === "str") labelBytes = te.encode(lab.v);
      else if (lab.t === "arr") {
        if (lab.items.length !== 2) refuse("invalid_tag", lp, span(lab));
        const [l0, l1] = lab.items;
        if (l0.t !== "str" || l0.v !== "bytes") refuse("invalid_tag", ext(lp, 0), span(l0));
        if (l1.t !== "str") refuse("invalid_tag", ext(lp, 1), span(l1));
        labelBytes = b64Decode(l1.v);
        if (!labelBytes) refuse("invalid_base64", ext(lp, 1), span(l1));
      } else refuse("invalid_tag", lp, span(lab));
      const args = el(2);
      const argp = elp(2);
      if (args.t !== "arr") refuse("invalid_tag", argp, span(args));
      checkContribution(L, d + 1, args.items.length + 1, -1, () => [labelBytes.length], nodeFail);
      const label = atom(labelBytes);
      const items = [label];
      const kids = [uniform(label, at)];
      args.items.forEach((c, i) => {
        const [v, o] = interpReadable(c, d + 1, ext(argp, i), L);
        items.push(v);
        kids.push(o);
      });
      return [tuple(items), { at, kids }];
    }
    case "raw":
      return interpTotal(el(1), d, elp(1), L);
  }
  throw new Error("unreachable");
}

function parse(profile, b, L) {
  if (b.length > L.max_text_bytes) limit("text_bytes", null, [L.max_text_bytes, b.length]);
  const fault = utf8Fault(b);
  if (fault) refuse("invalid_utf8", null, fault);
  const tree = lex(b, L.max_json_depth);
  return profile === "total" ? interpTotal(tree, 0, null, L) : interpReadable(tree, 0, null, L);
}

function flattenOrigins(v, o, vpath = [], out = []) {
  out.push([vpath, o.at[0], o.at[1]]);
  if (!isAtom(v)) v.t.forEach((c, i) => flattenOrigins(c, o.kids[i], [...vpath, i], out));
  return out;
}

// --- writers (total §5, readable §5) ----------------------------------------------------

class RenderRefusal extends Error {
  constructor(kind) {
    super(`render limit_exceeded/${kind}`);
    this.code = "limit_exceeded";
    this.kind = kind;
  }
}

class Out {
  constructor(L) {
    this.L = L;
    this.parts = [];
    this.bytes = 0;
    this.depth = 0;
  }
  emit(s) {
    this.parts.push(s);
    this.bytes += te.encode(s).length;
    if (this.bytes > this.L.max_text_bytes) throw new RenderRefusal("text_bytes");
  }
  open(ch) {
    if (this.depth + 1 > this.L.max_json_depth) throw new RenderRefusal("json_depth");
    this.depth++;
    this.emit(ch);
  }
  close(ch) {
    this.depth--;
    this.emit(ch);
  }
  check(depth, arity, digits, atomLens) {
    checkContribution(this.L, depth, arity, digits, () => atomLens, (kind) => {
      throw new RenderRefusal(kind);
    });
  }
}

function writeTotal(v, d, o) {
  if (isAtom(v)) {
    o.check(d, -1, -1, [v.a.length]);
    o.open("{");
    o.emit(`"atom":"${bytesToHex(v.a)}"`);
    o.close("}");
    return;
  }
  o.check(d, v.t.length, -1, []);
  o.open("{");
  o.emit('"tuple":');
  o.open("[");
  v.t.forEach((c, i) => {
    if (i) o.emit(",");
    writeTotal(c, d + 1, o);
  });
  o.close("]");
  o.close("}");
}

function jsonString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

const utf8Text = (bytes) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

function envelopeOpen(o, tag) {
  o.open("{");
  o.emit('"$ontos":');
  o.open("[");
  o.emit(`"${tag}",`);
}
function envelopeClose(o) {
  o.close("]");
  o.close("}");
}

function writeReadable(v, d, o) {
  if (isAtom(v)) {
    o.check(d, -1, -1, [v.a.length]);
    envelopeOpen(o, "bytes");
    o.emit(`"${b64Encode(v.a)}"`);
    envelopeClose(o);
    return;
  }
  const r = recognize(v);
  if (r) {
    switch (r.kind) {
      case "null":
        o.check(d + 1, 1, -1, [4]);
        o.emit("null");
        return;
      case "bool":
        o.check(d + 1, 2, -1, [4, 1]);
        o.emit(r.b ? "true" : "false");
        return;
      case "utf8-text":
        o.check(d + 1, 2, -1, [9, r.bytes.length]);
        o.emit(jsonString(utf8Text(r.bytes)));
        return;
      case "int": {
        const digits = (r.n < 0n ? -r.n : r.n).toString().length;
        o.check(d + 1, 2, digits, [3, v.t[1].a.length]);
        if (r.n <= MAX_SAFE && r.n >= -MAX_SAFE) o.emit(r.n.toString());
        else {
          envelopeOpen(o, "int");
          o.emit(`"${r.n}"`);
          envelopeClose(o);
        }
        return;
      }
      case "list":
        o.check(d + 1, v.t.length, -1, [4]);
        o.open("[");
        r.items.forEach((c, i) => {
          if (i) o.emit(",");
          writeReadable(c, d + 1, o);
        });
        o.close("]");
        return;
      case "map": {
        const n = r.entries.length;
        const arity = n ? Math.max(n + 1, 2) : 1;
        const texts = r.entries.map(([k]) => recognize(k));
        const plain = texts.every((t) => t && t.kind === "utf8-text" && !bytesEq(t.bytes, te.encode("$ontos")));
        if (plain) {
          o.check(n ? d + 3 : d + 1, arity, -1, [3, ...(n ? [9] : []), ...texts.map((t) => t.bytes.length)]);
          o.open("{");
          r.entries.forEach(([, val], i) => {
            if (i) o.emit(",");
            o.emit(jsonString(utf8Text(texts[i].bytes)) + ":");
            writeReadable(val, d + 2, o);
          });
          o.close("}");
        } else {
          o.check(d + 1, arity, -1, [3]);
          envelopeOpen(o, "map");
          o.open("[");
          r.entries.forEach(([k, val], i) => {
            if (i) o.emit(",");
            o.open("[");
            writeReadable(k, d + 2, o);
            o.emit(",");
            writeReadable(val, d + 2, o);
            o.close("]");
          });
          o.close("]");
          envelopeClose(o);
        }
        return;
      }
      case "set":
        o.check(d + 1, v.t.length, -1, [3]);
        envelopeOpen(o, "set");
        o.open("[");
        r.items.forEach((c, i) => {
          if (i) o.emit(",");
          writeReadable(c, d + 1, o);
        });
        o.close("]");
        envelopeClose(o);
        return;
      case "decimal": {
        const dm = (r.m < 0n ? -r.m : r.m).toString().length;
        const de = (r.e < 0n ? -r.e : r.e).toString().length;
        o.check(d + 2, 3, Math.max(dm, de), [7, 3, v.t[1].t[1].a.length, 3, v.t[2].t[1].a.length]);
        envelopeOpen(o, "decimal");
        o.emit(`"${r.m}","${r.e}"`);
        envelopeClose(o);
        return;
      }
    }
  }
  if (v.t.length >= 1 && isAtom(v.t[0])) {
    const label = v.t[0].a;
    o.check(d + 1, v.t.length, -1, [label.length]);
    envelopeOpen(o, "compound");
    if (utf8Fault(label) === null) o.emit(jsonString(utf8Text(label)));
    else {
      o.open("[");
      o.emit(`"bytes","${b64Encode(label)}"`);
      o.close("]");
    }
    o.emit(",");
    o.open("[");
    v.t.slice(1).forEach((c, i) => {
      if (i) o.emit(",");
      writeReadable(c, d + 1, o);
    });
    o.close("]");
    envelopeClose(o);
    return;
  }
  envelopeOpen(o, "raw");
  writeTotal(v, d, o);
  envelopeClose(o);
}

function render(profile, v, L) {
  const o = new Out(L);
  (profile === "total" ? writeTotal : writeReadable)(v, 0, o);
  return o.parts.join("");
}

// --- the runner -------------------------------------------------------------------------

const CODES = {
  shared: [
    "limit_exceeded",
    "invalid_utf8",
    "byte_order_mark",
    "invalid_json",
    "invalid_unicode_escape",
    "duplicate_member",
    "trailing_data",
    "invalid_total_form",
    "invalid_hex",
  ],
  readable: [
    "invalid_number",
    "unsafe_integer_literal",
    "invalid_envelope",
    "unknown_tag",
    "invalid_tag",
    "invalid_integer",
    "noncanonical_decimal",
    "invalid_base64",
    "duplicate_map_key",
    "duplicate_set_element",
  ],
};
const KINDS = {
  total: ["text_bytes", "json_depth", "decode_depth", "atom_bytes", "tuple_arity"],
  readable: ["text_bytes", "json_depth", "decode_depth", "atom_bytes", "tuple_arity", "integer_digits"],
};
const CASE_FIELDS = [
  "name",
  "group",
  "note",
  "provenance",
  "input",
  "input_hex",
  "input_parts",
  "limits",
  "value",
  "value_hex",
  "output",
  "refusal",
  "render_refusal",
  "origins",
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function checkCase(c, profile) {
  for (const k of Object.keys(c)) if (!CASE_FIELDS.includes(k)) throw new Error(`unknown field ${k}`);
  if (typeof c.group !== "string") throw new Error("missing group");
  const L = limitsFor(profile, c.limits);
  const codes = profile === "total" ? CODES.shared : [...CODES.shared, ...CODES.readable];

  const inputHex = expandRuns(c.input_hex);
  if (c.input !== undefined && bytesToHex(te.encode(expandRuns(c.input))) !== inputHex) {
    throw new Error("input_hex is not the UTF-8 of input");
  }
  // An input that is not UTF-8 has no `input`; its hand-written input_hex is checked against
  // its hand-written parts instead, text pieces as UTF-8 and hex pieces as they stand.
  if (c.input_parts !== undefined) {
    if (c.input !== undefined) throw new Error("input_parts is for an input that has no `input`");
    const joined = c.input_parts
      .map(([kind, piece]) => {
        if (kind === "text") return bytesToHex(te.encode(piece));
        if (kind === "hex") return bytesToHex(hexToBytes(piece));
        throw new Error(`bad input part ${kind}`);
      })
      .join("");
    if (joined !== inputHex) throw new Error("input_hex is not the concatenation of input_parts");
  }
  if (inputHex !== undefined && c.input === undefined && c.input_parts === undefined) {
    throw new Error("an input_hex needs `input` or `input_parts` beside it");
  }
  // Provenance (docs/conformance-vector-provenance.md): value_hex derived from a datum, or not.
  const wantProv = c.value !== undefined ? "derived-from-spec-algorithm" : "hand-authored";
  if (c.provenance !== wantProv) throw new Error(`provenance should be ${wantProv}`);
  if (c.value_hex !== undefined && c.value === undefined) throw new Error("a value_hex needs its value datum");
  const valueHex = expandRuns(c.value_hex);
  if (c.value !== undefined && bytesToHex(encode(buildDatum(c.value))) !== valueHex) {
    throw new Error(`value_hex is not the encoding of the value datum: ${bytesToHex(encode(buildDatum(c.value)))}`);
  }
  const value = valueHex !== undefined ? decode(hexToBytes(valueHex)) : undefined;
  const kinds = { accept: 0, refuse: 0, renderRefuse: 0, origins: 0 };

  if (c.refusal) {
    if (inputHex === undefined || value !== undefined || c.output !== undefined) {
      throw new Error("a refusal case has input_hex and no value_hex or output");
    }
    const want = { ...c.refusal, path: expandRuns(c.refusal.path) };
    if (!codes.includes(want.code)) throw new Error(`code ${want.code} is not in this profile's taxonomy`);
    if ((want.code === "limit_exceeded") !== (want.kind !== undefined)) throw new Error("kind goes with limit_exceeded");
    if (want.kind !== undefined && !KINDS[profile].includes(want.kind)) throw new Error(`kind ${want.kind}`);
    let got;
    try {
      parse(profile, hexToBytes(inputHex), L);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      got = e;
    }
    if (!got) throw new Error("the checker accepted an input the vector refuses");
    const gotR = { code: got.code, path: got.path, span: got.span, ...(got.kind ? { kind: got.kind } : {}) };
    const wantR = { code: want.code, path: want.path, span: want.span, ...(want.kind ? { kind: want.kind } : {}) };
    if (!same(gotR, wantR)) throw new Error(`refusal differs: checker ${JSON.stringify(gotR).slice(0, 300)}`);
    kinds.refuse++;
    return kinds;
  }

  if (value === undefined) throw new Error("a case without a refusal needs value_hex");
  if (inputHex !== undefined) {
    let got;
    try {
      got = parse(profile, hexToBytes(inputHex), L);
    } catch (e) {
      if (e instanceof Refusal) throw new Error(`the checker refused: ${e.message}`);
      throw e;
    }
    const [v, o] = got;
    if (bytesToHex(encode(v)) !== valueHex) throw new Error(`read value differs: ${bytesToHex(encode(v)).slice(0, 200)}`);
    if (c.origins !== undefined) {
      if (profile !== "readable") throw new Error("origins are a readable-profile result");
      const flat = flattenOrigins(v, o);
      if (!same(flat, c.origins)) throw new Error(`origins differ: checker ${JSON.stringify(flat)}`);
      kinds.origins++;
    }
    kinds.accept++;
  }
  if (c.render_refusal) {
    if (c.output !== undefined) throw new Error("a render refusal has no output");
    let got;
    try {
      render(profile, value, L);
    } catch (e) {
      if (!(e instanceof RenderRefusal)) throw e;
      got = e;
    }
    if (!got) throw new Error("the checker rendered a value the vector refuses to render");
    if (!same({ code: got.code, kind: got.kind }, c.render_refusal)) {
      throw new Error(`render refusal differs: checker ${got.kind}`);
    }
    kinds.renderRefuse++;
    return kinds;
  }
  const output = expandRuns(c.output);
  if (typeof output !== "string") throw new Error("missing output");
  let out;
  try {
    out = render(profile, value, L);
  } catch (e) {
    if (e instanceof RenderRefusal) throw new Error(`the checker refused to render: ${e.kind}`);
    throw e;
  }
  if (out !== output) throw new Error(`output differs: checker ${out.slice(0, 300)}`);
  // The laws (total §7): R(W(v)) = v, and W(R(j)) = j on the writer's image.
  const [back] = parse(profile, te.encode(output), L);
  if (!bytesEq(encode(back), encode(value))) throw new Error("law R(W(v)) = v fails");
  if (render(profile, back, L) !== output) throw new Error("law W(R(j)) = j fails");
  return kinds;
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = argv[0] ?? join(here, "..", "..", "projection", "json", "vectors");
  const files = [
    ["total", "total.json", "ontos-total-json/1"],
    ["readable", "readable.json", "ontos-readable-json/1"],
  ];
  let failures = 0;
  for (const [profile, file, id] of files) {
    const doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (doc.profile !== id) {
      console.error(`${file}: profile is ${doc.profile}, expected ${id}`);
      failures++;
      continue;
    }
    const names = new Set();
    const totals = { accept: 0, refuse: 0, renderRefuse: 0, origins: 0 };
    for (const c of doc.cases) {
      try {
        if (names.has(c.name)) throw new Error("duplicate case name");
        names.add(c.name);
        const k = checkCase(c, profile);
        for (const key of Object.keys(totals)) totals[key] += k[key];
      } catch (e) {
        failures++;
        console.error(`FAIL ${file} ${c.name}: ${e.message}`);
      }
    }
    console.log(
      `${file}: ${doc.cases.length} cases (${totals.accept} read and written, ${totals.refuse} read refusals, ` +
        `${totals.renderRefuse} write refusals, ${totals.origins} with origins)`,
    );
  }
  if (failures) {
    console.error(`json-projection vectors: ${failures} failure(s)`);
    return 1;
  }
  console.log("json-projection vectors: every case agrees with the independent reader and writer");
  return 0;
}

// Run last, once every declaration above is initialized.
if (isMainThread) {
  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { argv: process.argv.slice(2) },
    resourceLimits: { stackSizeMb: 256 },
  });
  worker.on("message", (code) => {
    process.exitCode = code;
  });
  worker.on("error", (e) => {
    console.error(e);
    process.exitCode = 1;
  });
} else {
  parentPort.postMessage(main(workerData.argv));
}
