#!/usr/bin/env node
/*
 * gen.mjs — fills the derived fields of the JSON projection vectors.
 *
 * projection/json/vectors/{total,readable}.json are hand-authored (README there). A
 * case's author writes the input as text (`input`), the value it denotes in the datum
 * notation (`value`), the preferred output and the refusal. Two fields follow mechanically
 * from those, and this tool writes them:
 *
 *   input_hex  the UTF-8 bytes of `input`, as hex. A case whose input is not UTF-8 has
 *              no `input`, and its author writes input_hex directly.
 *   value_hex  the ontos-codec-v1 bytes of `value`, built with the frozen
 *              @bitspark/ontos-data encoders (encodeInt, encodeText, encodeMap, …) and
 *              @bitspark/ontos-codec's encode. Those packages are pinned to all four faces
 *              by vectors/data.json, and they share no code with the projection.
 *
 * It also writes each case's fields in one fixed order, so the files diff cleanly.
 * tools/json-projection/check.mjs then checks every case with its own reader, writer and
 * ontos/data encoders, which cross-checks value_hex as well. scripts/check.sh vectors runs
 * this tool, fails if the files change, then runs the checker.
 *
 * Run: node tools/json-projection/gen.mjs   (from the repo root, after the ts build)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { atom, tuple, toHex } from "@bitspark/ontos-core";
import { encode, encodeTupleHeader } from "@bitspark/ontos-codec";
import {
  encodeBool,
  encodeDecimal,
  encodeInt,
  encodeList,
  encodeMap,
  encodeNull,
  encodeSet,
  encodeText,
  readDecimal,
} from "@bitspark/ontos-data";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "..", "projection", "json", "vectors");
const FILES = ["total.json", "readable.json"];
const FIELD_ORDER = [
  "name",
  "group",
  "note",
  "input",
  "input_hex",
  "limits",
  "value",
  "value_hex",
  "output",
  "refusal",
  "render_refusal",
  "origins",
];
const te = new TextEncoder();

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(2 * i, 2), 16);
  return out;
}

/** The datum notation of the README, built with the frozen ontos/data encoders. */
function build(d) {
  const [op, ...a] = d;
  switch (op) {
    case "atom":
      return atom(hexToBytes(a[0]));
    case "utf8":
      return atom(te.encode(a[0]));
    case "tuple":
      return tuple(a[0].map(build));
    case "compound":
      return tuple([atom(te.encode(a[0])), ...a[1].map(build)]);
    case "int":
      return encodeInt(BigInt(a[0]));
    case "text":
      return encodeText(a[0]);
    case "bool":
      return encodeBool(a[0]);
    case "null":
      return encodeNull();
    case "list":
      return encodeList(a[0].map(build));
    case "map":
      return encodeMap(a[0].map(([k, v]) => [build(k), build(v)]));
    case "set":
      return encodeSet(a[0].map(build));
    case "decimal": {
      const v = encodeDecimal(BigInt(a[0]), BigInt(a[1]));
      const { mantissa, exponent } = readDecimal(v);
      if (mantissa !== BigInt(a[0]) || exponent !== BigInt(a[1])) {
        throw new Error(`decimal datum ${a[0]}, ${a[1]} is not canonical`);
      }
      return v;
    }
    case "deep":
      throw new Error("a deep datum is allowed only at the top of `value`");
  }
  throw new Error(`unknown datum op ${op}`);
}

/** value_hex for a datum: a plain hex string, or runs for a top-level deep datum. */
function valueHex(d) {
  if (d[0] !== "deep") return toHex(encode(build(d)));
  const [, n, kind, inner] = d;
  // A wrapper is a one-child tuple, a one-element list, or a one-argument compound.
  const label = kind === "tuple" ? null : kind === "list" ? "list" : kind[1];
  const header =
    label === null
      ? toHex(encodeTupleHeader(1))
      : toHex(encodeTupleHeader(2)) + toHex(encode(atom(te.encode(label))));
  const wrap = (x) =>
    kind === "tuple" ? tuple([x]) : kind === "list" ? encodeList([x]) : tuple([atom(te.encode(label)), x]);
  // Cross-check the runs against the whole value encoded at once.
  let whole = build(inner);
  for (let i = 0; i < n; i++) whole = wrap(whole);
  const runs = { runs: [[header, n], [toHex(encode(build(inner))), 1]] };
  if (header.repeat(n) + toHex(encode(build(inner))) !== toHex(encode(whole))) {
    throw new Error("deep datum: runs do not reproduce the whole encoding");
  }
  return runs;
}

function inputHex(input) {
  if (typeof input === "string") return toHex(te.encode(input));
  return { runs: input.runs.map(([text, count]) => [toHex(te.encode(text)), count]) };
}

function serialize(doc) {
  const lines = ["{"];
  const top = Object.keys(doc).filter((k) => k !== "cases");
  for (const k of top) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(doc[k])},`);
  lines.push('  "cases": [');
  doc.cases.forEach((c, i) => {
    const keys = FIELD_ORDER.filter((k) => c[k] !== undefined);
    const extra = Object.keys(c).filter((k) => !FIELD_ORDER.includes(k));
    if (extra.length) throw new Error(`${c.name}: unknown field(s) ${extra.join(", ")}`);
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
    } catch (e) {
      throw new Error(`${file} ${c.name}: ${e.message}`);
    }
    filled++;
  }
  writeFileSync(path, serialize(doc));
}
console.log(`json-projection vectors: derived fields written for ${filled} cases`);
