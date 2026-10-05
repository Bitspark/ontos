/*
 * Package-local replay of the shared L0 structural-identity vectors
 * (../../vectors/identity.json) against @bitspark/ontos-core — the package that
 * *defines* the floor. The same vectors are also replayed inside the codec suite
 * (codec/ts/test/vectors.test.ts), but pinning them here makes the published
 * ontos-core package independently testable: identity is asserted at the layer that
 * owns it, using only the public atom/tuple/equals API, imported straight from this
 * package's own source.
 *
 * The {atom:hex}|{tuple:[...]} JSON is the vector authoring notation, NOT ontos's
 * canonical encoding. A dependency-free JSON→Value builder mirrors the one in
 * codec/ts/test/vectors.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { atom, tuple, equals, type Value } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "..", "..", "..", "vectors");

function readVectors(name: string): any {
  return JSON.parse(readFileSync(join(vectorsDir, name), "utf8"));
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function valueFromJson(j: any): Value {
  if (typeof j.atom === "string") return atom(hexToBytes(j.atom));
  if (Array.isArray(j.tuple)) return tuple(j.tuple.map(valueFromJson));
  throw new Error(`value must be {atom} or {tuple}: ${JSON.stringify(j)}`);
}

test("core identity vectors", () => {
  const doc = readVectors("identity.json");
  assert.ok(doc.cases.length > 0, "no identity cases");
  for (const c of doc.cases) {
    const left = valueFromJson(c.left);
    const right = valueFromJson(c.right);
    assert.equal(equals(left, right), c.equal, `identity case ${c.name}`);
  }
});
