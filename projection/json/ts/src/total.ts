/*
 * ontos-total-json/1 — the total JSON form of ground values (docs/spec/ontos-total-json.md).
 *
 *   Atom(b)            →  {"atom":"<b as lowercase hex>"}
 *   Tuple(v₀, …, vₙ₋₁) →  {"tuple":[<v₀>,…,<vₙ₋₁>]}
 *
 * parseUtf8 reads source bytes through the four stages of §4.1 (size, UTF-8, the strict
 * JSON reading, interpretation) and either returns the value or throws the one refusal the
 * spec selects. renderUtf8 writes the preferred spelling, checking the limits as the
 * reader's mirror (§9.3). Neither recurses on the host stack.
 *
 * A presentation, not the form of record: identity, hashing and signing use the codec bytes
 * of the recovered value, never this text.
 */

import { copyBytes, type Value } from "@bitspark/ontos-core";

import { generalizedUtf8, interpretTotal, writeTotal } from "./form.js";
import { readJson } from "./lexer.js";
import { Output, TOTAL_PROFILE, resolveLimits, type Limits, type ResolvedLimits } from "./shared.js";

export { ProjectionError } from "./shared.js";
export type { Limits, LimitKind, PathSegment, Profile, ProjectionErrorCode, Span } from "./shared.js";

/** The profile id. */
export const PROFILE = TOTAL_PROFILE;

/**
 * This profile's shipped defaults (§9.2): value depth 1024, JSON depth derived
 * (`2 · maxValueDepth + 2`, so 2050), everything else unbounded. `maxIntegerDigits` is
 * never checked here.
 */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxTextBytes: Infinity,
  maxValueDepth: 1024,
  maxAtomBytes: Infinity,
  maxTupleArity: Infinity,
  maxIntegerDigits: Infinity,
});

/** The derived JSON depth bound for a value depth bound `v`: an empty tuple at depth `v`. */
function deriveJsonDepth(maxValueDepth: number): number {
  return 2 * maxValueDepth + 2;
}

function limitsOf(limits: Partial<Limits> | undefined): ResolvedLimits {
  return resolveLimits(DEFAULT_LIMITS, limits, deriveJsonDepth);
}

/**
 * Reads `input`, the exact bytes of an ontos-total-json/1 text, under `limits` (this
 * profile's DEFAULT_LIMITS overridden by the fields given). Returns the value, or throws
 * a ProjectionError.
 */
export function parseUtf8(input: Uint8Array, limits?: Partial<Limits>): Value {
  const resolved = limitsOf(limits);
  const bytes = copyBytes(input);
  const root = readJson(bytes, resolved, TOTAL_PROFILE);
  return interpretTotal(root, 0, null, resolved, TOTAL_PROFILE, null).value;
}

/**
 * Reads a host string as parseUtf8 reads the string's generalized UTF-8 encoding, in which
 * a lone surrogate becomes three bytes `ED A0–BF 80–BF` (§10). A lone surrogate is
 * therefore refused with `invalid_utf8`, unless an earlier stage refuses first. The byte
 * reader is the normative one: a string reader cannot know whether the string was decoded
 * lossily before it arrived.
 */
export function parseString(input: string, limits?: Partial<Limits>): Value {
  return parseUtf8(generalizedUtf8(input), limits);
}

/** Writes the preferred spelling of `value` as UTF-8 bytes (§5), under `limits`. */
export function renderUtf8(value: Value, limits?: Partial<Limits>): Uint8Array {
  const resolved = limitsOf(limits);
  const out = new Output(resolved, TOTAL_PROFILE);
  writeTotal(out, value, 0, null, resolved);
  return out.result();
}

/** The UTF-8 decoding of renderUtf8 (every byte of it is ASCII). */
export function renderString(value: Value, limits?: Partial<Limits>): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(renderUtf8(value, limits));
}
