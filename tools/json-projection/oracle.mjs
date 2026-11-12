/*
 * oracle.mjs — the expected outcome of a JSON projection case, as check.mjs computes it.
 *
 * The oracle of the differential fuzz (README here) is tools/json-projection/check.mjs: the
 * independent reader and writer that check every committed vector, written from
 * docs/spec/ontos-total-json.md and docs/spec/ontos-readable-json.md and importing nothing.
 * This module adds no judgement of its own. It runs check.mjs's reader and writer under a
 * case's limits and puts what they give into the fields of a vector case (the format of
 * projection/json/vectors/README.md):
 *
 *   reading   the refusal (code, path, span, and kind for a limit), or the value's codec bytes
 *             and, for the readable profile, its origins;
 *   writing   the preferred output, or the write refusal (code, kind).
 *
 * It checks the oracle as it goes, on every output it computes, with the laws of total §7 and
 * the operational round trip of total §9.3: reading the output under the same limits gives the
 * value again, and writing that value gives the output again. A failure there is a defect of
 * the oracle, never of a face, and it stops the generator (OracleDefect).
 *
 * It imports check.mjs only, and like check.mjs it imports no face. A caller that reads deep
 * inputs runs it in a thread with a large stack (fuzz.mjs does).
 */

import { Refusal, RenderRefusal, bytesToHex, encode, flattenOrigins, isAtom, limitsFor, parse, recognize, render } from "./check.mjs";

const te = new TextEncoder();

/** A disagreement inside the oracle: its writer's output does not read back as the laws say. */
export class OracleDefect extends Error {}

/**
 * Reads `bytes` under the profile's defaults overridden by `overrides` (spec names, as a
 * case's `limits`). Returns { refusal } or { value, valueHex, origins }, where origins() gives
 * the readable profile's origins rows ([value path, JSON path, span], pre-order), built only
 * when asked, since a deep value has long paths.
 */
export function expectRead(profile, bytes, overrides = {}) {
  const L = limitsFor(profile, overrides);
  let got;
  try {
    got = parse(profile, bytes, L);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    return { refusal: { code: e.code, path: e.path, span: e.span, ...(e.kind ? { kind: e.kind } : {}) } };
  }
  const [value, tree] = got;
  return {
    value,
    valueHex: bytesToHex(encode(value)),
    origins: profile === "readable" ? () => flattenOrigins(value, tree) : undefined,
  };
}

/**
 * Writes `value` under the profile's defaults overridden by `overrides`. Returns { output }
 * (a string) or { renderRefusal: { code, kind } }. Every output is checked against the laws
 * before it is returned.
 */
export function expectWrite(profile, value, overrides = {}) {
  const L = limitsFor(profile, overrides);
  let output;
  try {
    output = render(profile, value, L);
  } catch (e) {
    if (!(e instanceof RenderRefusal)) throw e;
    return { renderRefusal: { code: e.code, kind: e.kind } };
  }
  let back;
  try {
    [back] = parse(profile, te.encode(output), L);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    throw new OracleDefect(`the oracle refuses its own output under the same limits: ${e.message}`);
  }
  if (bytesToHex(encode(back)) !== bytesToHex(encode(value))) throw new OracleDefect("law R(W(v)) = v fails in the oracle");
  if (render(profile, back, L) !== output) throw new OracleDefect("law W(R(j)) = j fails in the oracle");
  return { output };
}

/**
 * The value-side needs of a value: its depth (root 0), longest atom, widest tuple, and the
 * most decimal digits of an integer the readable writer would spell in decimal (ints and
 * decimal components it recognizes). The generator sets limits around these.
 */
export function measureValue(value) {
  const m = { depth: 0, atom: 0, arity: 0, digits: 0 };
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (d > m.depth) m.depth = d;
    if (isAtom(v)) {
      if (v.a.length > m.atom) m.atom = v.a.length;
      continue;
    }
    if (v.t.length > m.arity) m.arity = v.t.length;
    const r = recognize(v);
    if (r && r.kind === "int") m.digits = Math.max(m.digits, digitsOf(r.n));
    if (r && r.kind === "decimal") m.digits = Math.max(m.digits, digitsOf(r.m), digitsOf(r.e));
    for (const c of v.t) stack.push([c, d + 1]);
  }
  return m;
}

const digitsOf = (n) => (n < 0n ? -n : n).toString().length;

/** The JSON depth of a text: the most arrays and objects open at once, outside strings. */
export function jsonDepthOf(bytes) {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) max = Math.max(max, ++depth);
    else if (c === 0x5d || c === 0x7d) depth--;
  }
  return max;
}
