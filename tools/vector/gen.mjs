#!/usr/bin/env node
/*
 * ontos-vector — the maintainer generator for the Class B (derived) conformance
 * vectors (the map/set cases). See docs/conformance-vector-provenance.md.
 *
 * WHAT THIS IS. The map/set byte forms are NOT hand-authored: their canonical
 * entry/element ORDER is ontos-codec-v1 byte order (ontos-codec.md §6 /
 * ontos-data.md §5.7–§5.8), which is impractical to hand-compute. So authorship is
 * SPLIT from derivation. The human-authored oracle is vectors/data.source.json: it
 * states each map/set's MEMBERSHIP in a deliberately NON-CANONICAL (reverse) order
 * plus an order_explanation. This tool DERIVES the sorted value+hex from that source
 * by the specified rule and writes the reviewed artifact vectors/data.generated.json.
 *
 * THE DERIVATION RULE (boring and spec-shaped, no fancy deps):
 *   1. Parse the source authoring notation ({atom:hex} | {tuple:[…]}) into a
 *      @bitspark/ontos-core Value (parseAuthoring, below).
 *   2. Build the canonical Value with @bitspark/ontos-data's encodeMap/encodeSet,
 *      passing the NON-CANONICAL entries/elements — the encoder is what SORTS by the
 *      ontos-codec-v1 byte order over the key/element (and rejects duplicates).
 *   3. Encode that Value with @bitspark/ontos-codec's encode → the canonical hex.
 *   4. Emit { name, value:<authoring-json>, hex } (value via the core's own toJSON,
 *      which is exactly the {atom}|{tuple} authoring notation).
 *
 * THE CROSS-CHECK (why a generated artifact is still oracle-grade). After deriving,
 * this tool ASSERTS that every generated {value,hex} REPRODUCES the corresponding
 * map/set case already pinned in vectors/data.json, byte-for-byte; it exits
 * non-zero on ANY mismatch. data.json is itself differentially pinned to all four
 * encoders (go/rs/ts/py) by the codec vector-runner, so reproducing it here is a
 * cross-check against all four — not the encoder grading its own homework.
 * If a case fails to reproduce, FIX the source/generator; never edit data.json.
 *
 * Run: node tools/vector/gen.mjs   (from the repo root, after building core+codec+data)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { atom, tuple, toHex } from "@bitspark/ontos-core";
import { encode } from "@bitspark/ontos-codec";
import { encodeMap, encodeSet } from "@bitspark/ontos-data";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = join(HERE, "..", "..", "vectors");
const SOURCE_PATH = join(VECTORS_DIR, "data.source.json");
const GENERATED_PATH = join(VECTORS_DIR, "data.generated.json");
const PINNED_PATH = join(VECTORS_DIR, "data.json");

// --- authoring notation <-> core Value ---------------------------------------
// The notation (vectors/README.md): a value is exactly one of
//   { "atom":  "<lowercase-hex>" }   // even-length hex; "" is the empty atom
//   { "tuple": [ <value>, … ] }      // [] is the empty tuple
// This mirrors Value = Atom | Tuple, so the mapping is a tiny recursion.

/** Parse the authoring JSON for one value into an ontos-core Value. */
function parseAuthoring(node, where) {
  if (node === null || typeof node !== "object") {
    throw new Error(`${where}: value must be an object, got ${JSON.stringify(node)}`);
  }
  const hasAtom = Object.prototype.hasOwnProperty.call(node, "atom");
  const hasTuple = Object.prototype.hasOwnProperty.call(node, "tuple");
  if (hasAtom === hasTuple) {
    throw new Error(`${where}: value must have exactly one of "atom" or "tuple"`);
  }
  if (hasAtom) {
    return atom(hexToBytes(node.atom, where));
  }
  if (!Array.isArray(node.tuple)) {
    throw new Error(`${where}: "tuple" must be an array`);
  }
  return tuple(node.tuple.map((child, i) => parseAuthoring(child, `${where}.tuple[${i}]`)));
}

function hexToBytes(hex, where) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) {
    throw new Error(`${where}: "atom" must be even-length lowercase hex, got ${JSON.stringify(hex)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Render an ontos-core Value back to authoring JSON. The core's own toJSON already
 * yields exactly the {atom:hex}|{tuple:[…]} notation, so a JSON round-trip is the
 * canonical, dependency-free way to get a plain object — no hand-rolled inverse to
 * drift from the model.
 */
function valueToAuthoring(value) {
  return JSON.parse(JSON.stringify(value));
}

// --- canonical JSON (stable key order) for the reproduce comparison ----------
// data.json writes value objects with keys "atom"/"tuple" only, but we normalize
// defensively so the comparison is about structure, not whitespace or key order.
function canonicalJson(node) {
  if (Array.isArray(node)) return `[${node.map(canonicalJson).join(",")}]`;
  if (node !== null && typeof node === "object") {
    const keys = Object.keys(node).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(node[k])}`).join(",")}}`;
  }
  return JSON.stringify(node);
}

// --- derive one source case to { name, value, hex } --------------------------
function deriveCase(c) {
  const where = `case ${JSON.stringify(c.name)}`;
  if (c.provenance !== "derived-from-spec-algorithm") {
    throw new Error(`${where}: provenance must be "derived-from-spec-algorithm", got ${JSON.stringify(c.provenance)}`);
  }
  let value;
  if (c.kind === "map") {
    if (!Array.isArray(c.entries)) throw new Error(`${where}: map case needs an "entries" array`);
    const entries = c.entries.map((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error(`${where}: entries[${i}] must be a [key, value] pair`);
      }
      return [
        parseAuthoring(pair[0], `${where}.entries[${i}].key`),
        parseAuthoring(pair[1], `${where}.entries[${i}].value`),
      ];
    });
    // encodeMap SORTS entries by the codec byte order of the key and rejects
    // duplicate key encodings — this is the derivation step.
    value = encodeMap(entries);
  } else if (c.kind === "set") {
    if (!Array.isArray(c.elements)) throw new Error(`${where}: set case needs an "elements" array`);
    const elements = c.elements.map((el, i) => parseAuthoring(el, `${where}.elements[${i}]`));
    // encodeSet SORTS elements by codec byte order and rejects duplicates.
    value = encodeSet(elements);
  } else {
    throw new Error(`${where}: kind must be "map" or "set", got ${JSON.stringify(c.kind)}`);
  }
  return { name: c.name, value: valueToAuthoring(value), hex: toHex(encode(value)) };
}

// --- main --------------------------------------------------------------------
function main() {
  const source = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
  if (!Array.isArray(source.cases)) throw new Error("data.source.json: missing top-level \"cases\" array");

  const derived = source.cases.map(deriveCase);

  // Write the reviewed artifact. Clearly marked as generated; do not hand-edit.
  const generated = {
    note:
      "GENERATED ARTIFACT — do NOT hand-edit. Produced by tools/vector/gen.mjs from " +
      "vectors/data.source.json (the human-authored Class B oracle: map/set membership in " +
      "deliberately non-canonical order + an order_explanation). Each entry below is the " +
      "derived canonical {value, hex}: encodeMap/encodeSet (@bitspark/ontos-data) SORT the " +
      "source entries/elements by ontos-codec-v1 byte order (ontos-codec.md §6), then " +
      "@bitspark/ontos-codec encode produces the hex. gen.mjs asserts each {value, hex} here " +
      "reproduces the corresponding map_*/set_* case in vectors/data.json byte-for-byte (which " +
      "is differentially pinned to all four encoders), so this is a reviewed cross-check, not " +
      "the oracle itself. Regenerate with: node tools/vector/gen.mjs. " +
      "Policy: docs/conformance-vector-provenance.md.",
    profile: "ontos-data-v1",
    codec: "ontos-codec-v1",
    provenance: "derived-from-spec-algorithm",
    source: "vectors/data.source.json",
    generator: "tools/vector/gen.mjs",
    cases: derived,
  };
  writeFileSync(GENERATED_PATH, JSON.stringify(generated, null, 2) + "\n");

  // Reproduce-check against the pinned canonical vectors/data.json. This IS the
  // cross-check: data.json is already pinned byte-for-byte to go/rs/ts/py.
  const pinned = JSON.parse(readFileSync(PINNED_PATH, "utf8"));
  const pinnedByName = new Map(pinned.encode.map((c) => [c.name, c]));

  const mismatches = [];
  for (const g of derived) {
    const p = pinnedByName.get(g.name);
    if (!p) {
      mismatches.push(`  ${g.name}: no matching case in vectors/data.json`);
      continue;
    }
    if (g.hex !== p.hex) {
      mismatches.push(`  ${g.name}: hex mismatch\n    derived: ${g.hex}\n    pinned:  ${p.hex}`);
    }
    if (canonicalJson(g.value) !== canonicalJson(p.value)) {
      mismatches.push(
        `  ${g.name}: value mismatch\n    derived: ${canonicalJson(g.value)}\n    pinned:  ${canonicalJson(p.value)}`,
      );
    }
  }

  // Sanity: every map_*/set_* case pinned in data.json must have a source here, so
  // the source can never silently fall behind data.json.
  const derivedNames = new Set(derived.map((g) => g.name));
  for (const p of pinned.encode) {
    if ((p.name.startsWith("map_") || p.name.startsWith("set_")) && !derivedNames.has(p.name)) {
      mismatches.push(`  ${p.name}: pinned in data.json but absent from data.source.json`);
    }
  }

  console.log(`ontos-vector: wrote ${GENERATED_PATH.replace(/\\/g, "/")}`);
  console.log(`ontos-vector: derived ${derived.length} Class B (map/set) cases from data.source.json`);

  if (mismatches.length > 0) {
    console.error(
      `ontos-vector: FAIL — ${mismatches.length} reproduce mismatch(es) vs vectors/data.json:\n${mismatches.join("\n")}`,
    );
    console.error("Fix data.source.json or the generator until it reproduces data.json — never edit data.json.");
    process.exit(1);
  }

  console.log(
    `ontos-vector: OK — all ${derived.length} cases reproduce vectors/data.json byte-for-byte ` +
      `(cross-checked against the go/rs/ts/py-pinned canonical).`,
  );
}

main();
