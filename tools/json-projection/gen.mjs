#!/usr/bin/env node
/*
 * gen.mjs — fills the derived fields of the JSON projection vectors.
 *
 * projection/json/vectors/{total,readable}.json are hand-authored (README there). A
 * case's author writes the input as text (`input`), the value it denotes in the datum
 * notation (`value`), the preferred output and the refusal. Two fields follow mechanically
 * from those, and this tool writes them, with a third that labels the case:
 *
 *   input_hex   the UTF-8 bytes of `input`, as hex. An input that is not UTF-8 has no
 *               `input`: its author writes input_hex by hand, beside `input_parts`, and
 *               check.mjs checks the two against each other.
 *   value_hex   the ontos-codec-v1 bytes of `value`, computed by the encoder below. It is
 *               this tool's own, written from ontos-codec.md §2 and ontos-data.md §5, and it
 *               builds encodings directly as bytes. It imports no face's package
 *               (docs/conformance-vector-provenance.md: an oracle is never an implementation's
 *               output), and it shares no code with check.mjs, which builds value trees with
 *               its own encoders and so cross-checks every value_hex.
 *   provenance  "derived-from-spec-algorithm" when value_hex is derived from `value`, else
 *               "hand-authored" (a refusal case: every field written by hand).
 *
 * It also writes each case's fields in one fixed order, so the files diff cleanly.
 * scripts/check.sh vectors runs this tool, fails if the files change, then runs check.mjs.
 *
 * Run: node tools/json-projection/gen.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "..", "projection", "json", "vectors");
const FILES = ["total.json", "readable.json"];
const FIELD_ORDER = [
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
const utf8 = (s) => [...new TextEncoder().encode(s)];

// --- an encoder that builds bytes directly (ontos-codec.md §2, §3) -----------------------
// An encoding is a plain array of byte numbers. atomEnc and tupleEnc are the two equations.

function lengthBytes(n) {
  const out = [];
  do {
    let b = n % 128;
    n = (n - b) / 128;
    if (n > 0) b += 128;
    out.push(b);
  } while (n > 0);
  return out;
}
const atomEnc = (bytes) => [0x00, ...lengthBytes(bytes.length), ...bytes];
const tupleEnc = (children) => [0x01, ...lengthBytes(children.length), ...children.flat()];

function hexBytes(h) {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) throw new Error(`not lowercase hex: ${h.slice(0, 20)}`);
  const out = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}
const toHexString = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

function lexLess(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** int payload (ontos-data.md §5.1) from canonical decimal text, by long division in base 256. */
function intPayloadFromText(text) {
  if (!/^(0|-?[1-9][0-9]*)$/.test(text)) throw new Error(`int datum is not canonical text: ${text}`);
  const negative = text.startsWith("-");
  let digits = (negative ? text.slice(1) : text).split("").map(Number);
  const magnitude = [];
  while (digits.length > 1 || digits[0] !== 0) {
    let rem = 0;
    const next = [];
    for (const d of digits) {
      const cur = rem * 10 + d;
      const q = Math.floor(cur / 256);
      rem = cur % 256;
      if (next.length || q) next.push(q);
    }
    magnitude.unshift(rem);
    digits = next.length ? next : [0];
  }
  return [negative ? 0x01 : 0x00, ...magnitude];
}

const label = (s) => atomEnc(utf8(s));
const intEnc = (text) => tupleEnc([label("int"), atomEnc(intPayloadFromText(text))]);

function sortedDistinct(encodings, what) {
  const sorted = [...encodings].sort((x, y) => lexLess(x.key, y.key));
  for (let i = 1; i < sorted.length; i++) {
    if (lexLess(sorted[i - 1].key, sorted[i].key) === 0) throw new Error(`duplicate ${what} in a datum`);
  }
  return sorted;
}

/** The README's datum notation, encoded. */
function enc(d) {
  const [op, ...a] = d;
  switch (op) {
    case "atom":
      return atomEnc(hexBytes(a[0]));
    case "utf8":
      return atomEnc(utf8(a[0]));
    case "tuple":
      return tupleEnc(a[0].map(enc));
    case "compound":
      return tupleEnc([atomEnc(utf8(a[0])), ...a[1].map(enc)]);
    case "int":
      return intEnc(a[0]);
    case "text":
      return tupleEnc([label("utf8-text"), atomEnc(utf8(a[0]))]);
    case "bool":
      return tupleEnc([label("bool"), atomEnc([a[0] ? 1 : 0])]);
    case "null":
      return tupleEnc([label("null")]);
    case "list":
      return tupleEnc([label("list"), ...a[0].map(enc)]);
    case "map": {
      const entries = a[0].map(([k, v]) => ({ key: enc(k), whole: tupleEnc([enc(k), enc(v)]) }));
      return tupleEnc([label("map"), ...sortedDistinct(entries, "map key").map((e) => e.whole)]);
    }
    case "set": {
      const elems = a[0].map((e) => ({ key: enc(e), whole: enc(e) }));
      return tupleEnc([label("set"), ...sortedDistinct(elems, "set element").map((e) => e.whole)]);
    }
    case "decimal": {
      const [m, e] = a;
      const canonical = m === "0" ? e === "0" : !m.endsWith("0");
      if (!canonical) throw new Error(`decimal datum ${m}, ${e} is not canonical`);
      return tupleEnc([label("decimal"), intEnc(m), intEnc(e)]);
    }
    case "deep":
      throw new Error("a deep datum is allowed only at the top of `value`");
  }
  throw new Error(`unknown datum op ${op}`);
}

/** value_hex for a datum: a hex string, or runs for a top-level deep datum. */
function valueHex(d) {
  if (d[0] !== "deep") return toHexString(enc(d));
  const [, n, wrapper, inner] = d;
  // A wrapper is a one-child tuple, a one-element list or a one-argument compound, so its
  // header is the tuple tag and arity, then any label atom, then the single child.
  const header =
    wrapper === "tuple"
      ? [0x01, ...lengthBytes(1)]
      : [0x01, ...lengthBytes(2), ...label(wrapper === "list" ? "list" : wrapper[1])];
  const innerBytes = enc(inner);
  // Cross-check the runs against the whole value built the long way.
  let whole = innerBytes;
  for (let i = 0; i < n; i++) whole = [...header, ...whole];
  const runs = { runs: [[toHexString(header), n], [toHexString(innerBytes), 1]] };
  if (toHexString(header).repeat(n) + toHexString(innerBytes) !== toHexString(whole)) {
    throw new Error("deep datum: runs do not reproduce the whole encoding");
  }
  return runs;
}

function inputHex(input) {
  if (typeof input === "string") return toHexString(utf8(input));
  return { runs: input.runs.map(([text, count]) => [toHexString(utf8(text)), count]) };
}

function serialize(doc) {
  const lines = ["{"];
  for (const k of Object.keys(doc).filter((key) => key !== "cases")) {
    lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(doc[k])},`);
  }
  lines.push('  "cases": [');
  doc.cases.forEach((c, i) => {
    const extra = Object.keys(c).filter((k) => !FIELD_ORDER.includes(k));
    if (extra.length) throw new Error(`${c.name}: unknown field(s) ${extra.join(", ")}`);
    const keys = FIELD_ORDER.filter((k) => c[k] !== undefined);
    lines.push("    {");
    keys.forEach((k, j) => {
      lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(c[k])}${j < keys.length - 1 ? "," : ""}`);
    });
    lines.push(`    }${i < doc.cases.length - 1 ? "," : ""}`);
  });
  lines.push("  ]", "}");
  return lines.join("\n") + "\n";
}

let filled = 0;
for (const file of FILES) {
  const path = join(DIR, file);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  for (const c of doc.cases) {
    try {
      if (c.input !== undefined) c.input_hex = inputHex(c.input);
      if (c.value !== undefined) c.value_hex = valueHex(c.value);
      c.provenance = c.value !== undefined ? "derived-from-spec-algorithm" : "hand-authored";
    } catch (e) {
      throw new Error(`${file} ${c.name}: ${e.message}`);
    }
    filled++;
  }
  writeFileSync(path, serialize(doc));
}
console.log(`json-projection vectors: derived fields written for ${filled} cases`);
