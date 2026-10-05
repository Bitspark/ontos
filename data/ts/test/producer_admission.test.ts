/*
 * Pins the producer-admission laws (ontos-data.md §4.1) for this core's `utf8-text`
 * producer.
 *
 * A JavaScript string is a sequence of UTF-16 code units, not a sequence of Unicode
 * scalar values: it may contain an unpaired surrogate, which has no UTF-8 encoding.
 * `TextEncoder` maps each such unit to U+FFFD (`ef bf bd`) WITHOUT failing, so an
 * unchecked producer returns a well-formed `utf8-text` carrying a character the
 * caller never supplied — §4.1 law 2 (fidelity), the one failure no downstream
 * reader can detect, because the distinguishing fact is the source string and it is
 * gone by then.
 *
 * These tests are the enforcement point. The regression guard has teeth: it asserts
 * the substituted bytes are not produced, so a refactor that reintroduces the silent
 * path fails here rather than in someone's signed identity preimage.
 *
 * NOTE on the recognizer: this module has no `recognizeText` — `readText` IS the
 * recognizer for this embedding (it throws `DataError` on anything that is not a
 * well-formed `utf8-text`), so "recognizes" below means "readText does not throw".
 */

import test from "node:test";
import assert from "node:assert/strict";

import { atom, tuple, equals, type Value } from "@bitspark/ontos-core";
import { encodeText, readText, DataError } from "../src/index.ts";

const LABEL_TEXT = new TextEncoder().encode("utf8-text");
const REPLACEMENT = Uint8Array.of(0xef, 0xbf, 0xbd); // U+FFFD in UTF-8

/** The exact value an unchecked TextEncoder-based producer would have emitted. */
function substituted(): Value {
  return tuple([atom(LABEL_TEXT), atom(REPLACEMENT)]);
}

const isInvalidUtf8 = (err: unknown) => err instanceof DataError && err.code === "invalid_utf8";

test("law 2 (fidelity): a lone high surrogate is REJECTED, not substituted", () => {
  assert.throws(() => encodeText("\ud800"), isInvalidUtf8);
});

test("law 2 (fidelity): a lone low surrogate is REJECTED", () => {
  assert.throws(() => encodeText("\udc00"), isInvalidUtf8);
});

test("law 2 (fidelity): an unpaired surrogate is rejected wherever it sits", () => {
  // leading, interior, and trailing — an index-0-only check would pass two of these
  for (const s of ["\ud800abc", "abc\ud800def", "abc\ud800"]) {
    assert.throws(() => encodeText(s), isInvalidUtf8, `expected rejection for ${JSON.stringify(s)}`);
  }
});

test("law 2 (fidelity): a high surrogate followed by a NON-low unit is still unpaired", () => {
  // The next unit exists but is not a low surrogate. A naive "is there a next unit?"
  // check would wrongly accept this.
  assert.throws(() => encodeText("\ud800A"), isInvalidUtf8);
  // Two highs in a row: the first is unpaired even though a surrogate follows it.
  assert.throws(() => encodeText("\ud800\ud800"), isInvalidUtf8);
  // A low followed by a high is two unpaired units, not a pair (wrong order).
  assert.throws(() => encodeText("\udc00\ud800"), isInvalidUtf8);
});

test("REGRESSION GUARD: the U+FFFD substitution is never produced", () => {
  // The precise failure this module had: encodeText("\ud800") returned
  // Tuple(Atom("utf8-text"), Atom(ef bf bd)) — well-formed, readable, wrong datum.
  let produced: Value | undefined;
  try {
    produced = encodeText("\ud800");
  } catch {
    produced = undefined; // rejected, as required
  }
  assert.equal(produced, undefined, "encodeText must not return a value for a lone surrogate");

  // Positive controls: the substituted value IS constructible and IS recognized, and
  // it reads back as a different string. Without these, the assertion above would
  // also pass if the value were unbuildable or the recognizer broken — i.e. they
  // prove this test exercises the PRODUCER.
  assert.doesNotThrow(() => readText(substituted()), "control: the substituted value is well-formed utf8-text");
  assert.equal(readText(substituted()), "\ufffd", "control: it reads back as U+FFFD — a DIFFERENT datum");
});

test("law 1 (soundness): every successful encodeText round-trips through readText", () => {
  const admissible = [
    "",
    "hi",
    "ünïcødé",
    "\u{1f600}", // astral: a correctly PAIRED surrogate pair, must be accepted
    "a\u{10ffff}z", // max scalar value
    "\u0000", // NUL is a scalar value and is admissible
    "e\u0301", // e + COMBINING ACUTE — NOT normalized to U+00E9 (§5.2), survives verbatim
  ];
  for (const s of admissible) {
    const v = encodeText(s);
    assert.doesNotThrow(() => readText(v), `readText must accept the producer's own output for ${JSON.stringify(s)}`);
    assert.equal(readText(v), s, `round-trip must be exact for ${JSON.stringify(s)}`);
  }
});

test("§5.2: the producer does not normalize — combining and precomposed stay distinct", () => {
  // Guards against a "fix" that reaches for String.prototype.normalize().
  const combining = encodeText("e\u0301");   // U+0065 U+0301
  const precomposed = encodeText("\u00e9");   // U+00E9
  assert.ok(!equals(combining, precomposed), "canonically-equivalent spellings must remain DISTINCT values");
});

test("law 1 (soundness): a paired surrogate is admissible and not confused with an unpaired one", () => {
  // The pair scan must consume both units and accept, or the guard would reject all
  // astral text — the obvious way to get this wrong.
  const v = encodeText("😀");
  assert.equal(readText(v), "\u{1f600}");
  assert.ok(equals(v, encodeText("\u{1f600}")), "both spellings denote the same value");
});
