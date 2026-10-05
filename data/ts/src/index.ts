/*
 * ontos/data (L2) — registered canonical embeddings (ontos-data-v1, frozen).
 *
 * Freeze provenance: the v1 scalars and list (int, utf8-text, bool, list) were
 * frozen 2026-05-31; the structural pair map (§5.7) and set (§5.8) were frozen
 * 2026-06-01 (see docs/spec/ontos-data.md).
 *
 *   int       = Tuple(Atom("int"),       Atom(sign-magnitude bytes))
 *   utf8-text = Tuple(Atom("utf8-text"), Atom(valid UTF-8 bytes))
 *   bool      = Tuple(Atom("bool"),      Atom(0x00 | 0x01))
 *   list      = Tuple(Atom("list"),      elem*)
 *   map       = Tuple(Atom("map"),       Tuple(key, value)*)  // entries sorted by codec key bytes
 *   set       = Tuple(Atom("set"),       elem*)                // elements sorted by codec bytes, unique
 *   decimal   = Tuple(Atom("decimal"),   int(mantissa), int(exponent))  // mantissa × 10^exponent
 *
 * An embedding is a recognized L1 labeled compound — a Tuple whose first child is
 * a registered label atom — whose payload shape is fixed by docs/spec/ontos-data.md.
 * `ontos/data` adds vocabulary and producer discipline only: it introduces NO new
 * value and NO new identity. Every L2 value IS an L0 value; identity is L0
 * structural identity, unchanged (ontos-data.md §2). Each datum has exactly ONE
 * canonical form, so encoders normalize BEFORE building the value (§4) and readers
 * recognize only the already-canonical form.
 *
 * Two directions per embedding:
 *   encode<Kind> — build the canonical L0 Value from a typed datum (producer side).
 *   read<Kind>   — recognize a well-formed canonical embedding and return the typed
 *                  datum, or throw DataError (NOT-RECOGNIZED). Recognition is
 *                  partial and opt-in (§1/§7): every non-canonical or malformed form
 *                  is rejected as not-recognized — it is never quotiented to equal
 *                  data (§2). Downward is total, upward is partial.
 *
 * `map` (§5.7) is the first embedding whose canonical form depends on `ontos/codec`
 * (its entry order is `ontos-codec-v1`'s byte order over the key), so this module
 * imports the codec's `encode` as a RUNTIME dependency, not merely for tests.
 *
 * This imports the model from "@bitspark/ontos-core". In the monorepo that name
 * resolves to core/ts via npm workspaces, so the source and the published build
 * carry the identical import (see docs/design/0006-distribution.md). The byte forms
 * are frozen and pinned by vectors/data.json (profile: ontos-data-v1).
 */

import { Atom, Tuple, atom, tuple, bytesEqual, type Value } from "@bitspark/ontos-core";
import { encode } from "@bitspark/ontos-codec";

// Registered label bytes (ontos-data.md §5). These are the only labels v1 knows.
const LABEL_INT = "int";
const LABEL_BOOL = "bool";
const LABEL_TEXT = "utf8-text";
const LABEL_LIST = "list";
const LABEL_MAP = "map";
const LABEL_SET = "set";
const LABEL_DECIMAL = "decimal";
const LABEL_NULL = "null";

/**
 * The canonical ordered list of ontos-data-v1 embedding labels, in the fixed
 * recognition order (ontos-data.md §5: int, utf8-text, bool, list, map, set, decimal,
 * null). This is the ONE source of the registered label set and its order within this
 * module — built from the LABEL_* constants above so the spelling lives in one place, and
 * pinned against the actual read<Kind> recognizers by the module's test. decimal (§5.9)
 * was appended 2026-06-06 and null (§5.10) on 2026-06-13; the order carries no meaning
 * beyond the recognition sequence, so a new label appends rather than reordering.
 *
 * The CLI keeps its own copy of this order by deliberate design (so it does not
 * depend on this being exported); a cli-side parity test pins that copy against
 * LABELS. The order is part of the CLI's `recognized` JSON contract, so drift is a
 * real, CI-caught parity bug — hence the single source here.
 */
export const LABELS = [LABEL_INT, LABEL_TEXT, LABEL_BOOL, LABEL_LIST, LABEL_MAP, LABEL_SET, LABEL_DECIMAL, LABEL_NULL] as const;

const SIGN_NONNEG = 0x00;
const SIGN_NEG = 0x01;

const utf8Encoder = new TextEncoder();
// `fatal: true` makes decode throw on any byte sequence that is not valid UTF-8,
// which is exactly the readText rejection condition (ontos-data.md §5.2).
// `ignoreBOM: true` keeps a leading U+FEFF: the WHATWG default consumes it as a byte-order
// mark, which made readText drop a scalar value the payload carries (ontos-internal#338). §5.2's payload is
// the UTF-8 bytes verbatim, so U+FEFF is content wherever it appears.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Rejection categories for the recognizers. The `code` is a LANGUAGE-LOCAL
 * diagnostic, NOT a cross-language contract: the three data cores expose codes on
 * different axes (this module returns a failure-reason set; Go returns the rejected
 * embedding *kind*; Rust returns a *different* failure-reason set), and unlike the
 * codec's DecodeError codes it is NOT pinned in the conformance vectors (recognition
 * is partial/opt-in — ontos-data.md §1/§7). Use it for local diagnostics only; do
 * not rely on it across cores or as a stable wire contract.
 */
export type DataErrorCode =
  | "not_a_tuple"
  | "wrong_arity"
  | "wrong_label"
  | "malformed_payload"
  | "invalid_utf8"
  | "malformed_entry"
  | "unsorted_entries"
  | "duplicate_key"
  | "unsorted_elements"
  | "duplicate_element";

export class DataError extends Error {
  readonly code: DataErrorCode;
  constructor(code: DataErrorCode, message: string) {
    super(message);
    this.name = "DataError";
    this.code = code;
  }
}

// --- int (ontos-data.md §5.1) -------------------------------------------------

/**
 * Builds the canonical `int` embedding for an exact, unbounded integer.
 * Payload = one sign byte (0x00 non-negative, 0x01 negative) followed by the
 * big-endian, minimal-length magnitude of |n| (no leading 0x00). Zero is exactly
 * the single byte 0x00 (sign 0x00, empty magnitude); there is no negative zero.
 */
export function encodeInt(n: bigint): Value {
  const sign = n < 0n ? SIGN_NEG : SIGN_NONNEG;
  const magnitude = magnitudeBytes(n < 0n ? -n : n);
  const payload = new Uint8Array(1 + magnitude.length);
  payload[0] = sign;
  payload.set(magnitude, 1);
  return tuple([atom(utf8Encoder.encode(LABEL_INT)), atom(payload)]);
}

/**
 * Validates the canonical `int` structure and returns `{ sign, magnitude }` if `v` is
 * a well-formed canonical `int` — for ANY magnitude, including one beyond a fixed host
 * integer width. The recognition gate shared by `recognizeInt` and `readInt`: it runs
 * every canonical-form check (shape, arity, label, sign byte, minimal magnitude, no
 * negative zero) but does NOT materialize the magnitude into a bigint, so it cannot
 * drift from `readInt` on what counts as canonical.
 */
function intPayload(v: Value): { sign: number; magnitude: Uint8Array } {
  const payload = payloadAtomBytes(v, LABEL_INT);
  if (payload.length < 1) {
    throw new DataError("malformed_payload", "int payload must have at least a sign byte");
  }
  const sign = payload[0]!;
  if (sign !== SIGN_NONNEG && sign !== SIGN_NEG) {
    throw new DataError("malformed_payload", `int sign byte must be 0x00 or 0x01, got 0x${hexByte(sign)}`);
  }
  const magnitude = payload.subarray(1);
  if (magnitude.length >= 1 && magnitude[0] === 0x00) {
    throw new DataError("malformed_payload", "int magnitude has a non-canonical leading 0x00 byte");
  }
  if (magnitude.length === 0 && sign === SIGN_NEG) {
    throw new DataError("malformed_payload", "int has a forbidden negative-zero payload");
  }
  return { sign, magnitude };
}

/**
 * Recognizes a canonical `int` embedding WITHOUT materializing it into a host integer
 * type. Returns normally for every canonical `int` — including a magnitude beyond what
 * a bounded host integer could hold — and throws DataError for any non-canonical form.
 *
 * Recognition is STRUCTURAL ("does `v` have the frozen canonical `int` form?"),
 * distinct from materialization ("can a binding's host integer type hold it?"). This
 * binding's host type is `bigint` (arbitrary precision), so it can always materialize
 * what it recognizes; the distinction is load-bearing for a binding with a bounded
 * host integer (e.g. Rust's i128), and ontos's tri-core CLIs use this surface for
 * `read --kind int` so they agree on recognition regardless of host width
 * (ontos-data.md §5.1). Throws only DataError.
 */
export function recognizeInt(v: Value): void {
  intPayload(v);
}

/**
 * Recognizes a canonical `int` embedding and returns the integer, else throws — the
 * same canonical-form validation as `recognizeInt` (see `intPayload`). This binding is
 * unbounded (`bigint`), so it never reports a host-width resource limit. Rejects:
 * non-tuple, arity != 2, wrong label, non-atom or empty payload, a sign byte outside
 * {0x00, 0x01}, a magnitude with a leading 0x00, and negative zero.
 */
export function readInt(v: Value): bigint {
  const { sign, magnitude } = intPayload(v);
  const value = magnitudeFromBytes(magnitude);
  return sign === SIGN_NEG ? -value : value;
}

// --- bool (ontos-data.md §5.3) ------------------------------------------------

/** Builds the canonical `bool` embedding: payload single byte 0x00 / 0x01. */
export function encodeBool(b: boolean): Value {
  return tuple([atom(utf8Encoder.encode(LABEL_BOOL)), atom(Uint8Array.of(b ? 0x01 : 0x00))]);
}

/**
 * Recognizes a canonical `bool` embedding and returns the boolean, else throws.
 * Rejects: non-tuple, arity != 2, wrong label, and any payload that is not a
 * single byte in {0x00, 0x01}.
 */
export function readBool(v: Value): boolean {
  const payload = payloadAtomBytes(v, LABEL_BOOL);
  if (payload.length !== 1) {
    throw new DataError("malformed_payload", `bool payload must be exactly one byte, got ${payload.length}`);
  }
  const marker = payload[0];
  if (marker === 0x00) return false;
  if (marker === 0x01) return true;
  throw new DataError("malformed_payload", `bool payload byte must be 0x00 or 0x01, got 0x${hexByte(marker)}`);
}

// --- utf8-text (ontos-data.md §5.2) -------------------------------------------

/**
 * Returns the index of the first unpaired surrogate code unit in `s`, or -1 if
 * every surrogate is correctly paired.
 *
 * A JavaScript string is a sequence of UTF-16 code units and is NOT guaranteed to
 * be well-formed: a lone high surrogate (D800–DBFF not followed by a low one) or a
 * lone low surrogate (DC00–DFFF) has no Unicode scalar value and therefore no UTF-8
 * encoding. `TextEncoder` silently maps each such unit to U+FFFD, so this scan is
 * what stands between that substitution and the encoder.
 */
function findUnpairedSurrogate(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // well-formed pair — consume both units
        continue;
      }
      return i; // high surrogate not followed by a low one
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return i; // low surrogate with no preceding high one
    }
  }
  return -1;
}

/**
 * Builds the canonical `utf8-text` embedding: the string's valid UTF-8 bytes
 * verbatim, with NO Unicode normalization. The empty string yields an empty-atom
 * payload.
 *
 * FALLIBLE (ontos-data.md §4.1). The admissible domain is the strings that denote a
 * sequence of Unicode scalar values; a string containing an unpaired surrogate is
 * outside it and is REJECTED with `invalid_utf8`.
 *
 * It is rejected rather than encoded because `TextEncoder` maps an unpaired
 * surrogate to U+FFFD (`ef bf bd`), which does not fail — it yields a *well-formed*
 * `utf8-text` that `readText` accepts and that carries a character the caller never
 * supplied. That is §4.1 law 2 (fidelity): succeeding with a different datum. It is
 * the most dangerous of the three failures precisely because every downstream check
 * passes, and once the source string is gone an intentional U+FFFD and a substituted
 * one are indistinguishable — so no reader, at any strength, can catch it later.
 */
export function encodeText(s: string): Value {
  const at = findUnpairedSurrogate(s);
  if (at >= 0) {
    throw new DataError(
      "invalid_utf8",
      `utf8-text producer: unpaired surrogate 0x${s.charCodeAt(at).toString(16)} at index ${at} — ` +
        `the string has no UTF-8 encoding and would otherwise be substituted with U+FFFD`,
    );
  }
  return tuple([atom(utf8Encoder.encode(LABEL_TEXT)), atom(utf8Encoder.encode(s))]);
}

/**
 * Recognizes a canonical `utf8-text` embedding and returns the string, else throws.
 * Rejects: non-tuple, arity != 2, wrong label, and any payload that is not valid
 * UTF-8. The empty string is accepted (empty payload decodes to "").
 */
export function readText(v: Value): string {
  const payload = payloadAtomBytes(v, LABEL_TEXT);
  try {
    return utf8Decoder.decode(payload);
  } catch {
    throw new DataError("invalid_utf8", "utf8-text payload is not valid UTF-8");
  }
}

// --- list (ontos-data.md §5.5) ------------------------------------------------

/**
 * Builds the canonical `list` embedding: the `list` label followed by the elements
 * in order (arity n + 1). Elements are arbitrary L0 values, each expected to be
 * already in its own canonical form (the value-not-position rule, §2.1). Order and
 * multiplicity are identity; the list is never sorted or deduplicated. The empty
 * list is Tuple(Atom("list")).
 */
export function encodeList(elements: readonly Value[]): Value {
  return tuple([atom(utf8Encoder.encode(LABEL_LIST)), ...elements]);
}

/**
 * Recognizes a canonical `list` embedding and returns its elements (possibly
 * empty), else throws. Rejects: non-tuple, arity 0 (no label), and wrong label —
 * in particular the bare unlabeled Tuple(elem*) form is NOT a list (§5.5). No
 * per-element validation is performed; elements are returned verbatim.
 */
export function readList(v: Value): Value[] {
  if (!(v instanceof Tuple)) {
    throw new DataError("not_a_tuple", "list must be a tuple");
  }
  const items = v.items();
  if (items.length < 1) {
    throw new DataError("wrong_arity", "list must have at least the label child");
  }
  expectLabel(items[0], LABEL_LIST);
  return Array.from(items.slice(1));
}

// --- map (ontos-data.md §5.7) -------------------------------------------------

/**
 * Builds the canonical `map` embedding: the `map` label followed by one
 * arity-2 `Tuple(key, value)` per entry, entries **strictly ascending by the
 * ontos-codec-v1 byte encoding of the key** (the codec total order, ontos-codec
 * §6) — sort by key alone, no value tiebreak. Keys and values are arbitrary L0
 * values, each expected to be already in its own canonical form (value-not-
 * position rule, §2.1); `encodeMap` does NOT recurse into them. The empty map is
 * Tuple(Atom("map")).
 *
 * This encoder is FALLIBLE: duplicate keys are forbidden (§5.7), and resolving a
 * surface multimap's duplicate intent is the producer's job — so if two entries
 * have EQUAL key encodings, `encodeMap` throws `DataError("duplicate_key")`
 * rather than silently picking a winner.
 */
export function encodeMap(entries: ReadonlyArray<readonly [Value, Value]>): Value {
  // Encode each key once, then sort entries by the key's codec bytes. A stable
  // sort is not required for correctness (distinct keys impose a total order);
  // duplicates are detected explicitly below.
  const keyed = entries.map(([key, value]) => ({ key, value, bytes: encode(key) }));
  keyed.sort((a, b) => compareBytes(a.bytes, b.bytes));
  for (let i = 1; i < keyed.length; i += 1) {
    if (compareBytes(keyed[i - 1]!.bytes, keyed[i]!.bytes) === 0) {
      throw new DataError("duplicate_key", "map has two entries with equal key encodings");
    }
  }
  const children: Value[] = [atom(utf8Encoder.encode(LABEL_MAP))];
  for (const { key, value } of keyed) {
    children.push(tuple([key, value]));
  }
  return tuple(children);
}

/**
 * Recognizes a canonical `map` embedding and returns its (key, value) entries in
 * order, else throws. One left-to-right pass (§5.7 canonical form): (1) `v` is a
 * Tuple of arity >= 1 whose child0 is Atom("map"); else not-recognized. (2) arity
 * 1 => the empty map, return no entries. (3) every later child is a Tuple of arity
 * EXACTLY 2; else not-recognized. (4) for each entry after the first, require
 * encode(prevKey) < encode(key) STRICTLY — equal => duplicate, greater =>
 * unsorted. No recursion into whether a key/value is itself a canonical
 * sub-embedding (mirrors readList). Never panics; every rejection is a DataError.
 */
export function readMap(v: Value): Array<[Value, Value]> {
  if (!(v instanceof Tuple)) {
    throw new DataError("not_a_tuple", "map must be a tuple");
  }
  const items = v.items();
  if (items.length < 1) {
    throw new DataError("wrong_arity", "map must have at least the label child");
  }
  expectLabel(items[0], LABEL_MAP);

  const entries: Array<[Value, Value]> = [];
  let prevKeyBytes: Uint8Array | undefined;
  for (let i = 1; i < items.length; i += 1) {
    const entry = items[i]!;
    if (!(entry instanceof Tuple) || entry.length !== 2) {
      throw new DataError("malformed_entry", `map entry ${i - 1} must be a tuple of arity 2`);
    }
    const key = entry.at(0)!;
    const value = entry.at(1)!;
    const keyBytes = encode(key);
    if (prevKeyBytes !== undefined) {
      const cmp = compareBytes(prevKeyBytes, keyBytes);
      if (cmp === 0) {
        throw new DataError("duplicate_key", `map entry ${i - 1} repeats the previous key`);
      }
      if (cmp > 0) {
        throw new DataError("unsorted_entries", `map entry ${i - 1} key is out of ascending order`);
      }
    }
    entries.push([key, value]);
    prevKeyBytes = keyBytes;
  }
  return entries;
}

// --- set (ontos-data.md §5.8) -------------------------------------------------

/**
 * Builds the canonical `set` embedding: the `set` label followed by the elements
 * **strictly ascending by the ontos-codec-v1 byte encoding of the whole element**
 * (the codec total order, ontos-codec §6). This is `map`'s key discipline with no
 * values — elements are SINGLE arbitrary L0 values (not arity-2 entries), each
 * expected to be already in its own canonical form (value-not-position rule, §2.1);
 * `encodeSet` does NOT recurse into them. The empty set is Tuple(Atom("set")).
 *
 * This encoder is FALLIBLE: duplicate elements are forbidden (§5.8), and resolving
 * a surface multiset's duplicate intent is the producer's job — so if two elements
 * have EQUAL encodings, `encodeSet` throws `DataError("duplicate_element")` rather
 * than silently dropping one.
 */
export function encodeSet(elements: ReadonlyArray<Value>): Value {
  // Encode each element once, then sort by its codec bytes. A stable sort is not
  // required for correctness (distinct elements impose a total order); duplicates
  // are detected explicitly below.
  const keyed = elements.map((element) => ({ element, bytes: encode(element) }));
  keyed.sort((a, b) => compareBytes(a.bytes, b.bytes));
  for (let i = 1; i < keyed.length; i += 1) {
    if (compareBytes(keyed[i - 1]!.bytes, keyed[i]!.bytes) === 0) {
      throw new DataError("duplicate_element", "set has two elements with equal encodings");
    }
  }
  const children: Value[] = [atom(utf8Encoder.encode(LABEL_SET))];
  for (const { element } of keyed) {
    children.push(element);
  }
  return tuple(children);
}

/**
 * Recognizes a canonical `set` embedding and returns its elements in order, else
 * throws. One left-to-right pass (§5.8 canonical form): (1) `v` is a Tuple of arity
 * >= 1 whose child0 is Atom("set"); else not-recognized. (2) arity 1 => the empty
 * set, return no elements. (3) for each element after the first, require
 * encode(prev) < encode(elem) STRICTLY — equal => duplicate, greater => unsorted.
 * Unlike `map`, elements are single values, so there is NO entry-arity check. No
 * recursion into whether an element that claims an embedding label is itself
 * canonical (mirrors readList/readMap). Never panics; every rejection is a DataError.
 */
export function readSet(v: Value): Value[] {
  if (!(v instanceof Tuple)) {
    throw new DataError("not_a_tuple", "set must be a tuple");
  }
  const items = v.items();
  if (items.length < 1) {
    throw new DataError("wrong_arity", "set must have at least the label child");
  }
  expectLabel(items[0], LABEL_SET);

  const elements: Value[] = [];
  let prevBytes: Uint8Array | undefined;
  for (let i = 1; i < items.length; i += 1) {
    const element = items[i]!;
    const elementBytes = encode(element);
    if (prevBytes !== undefined) {
      const cmp = compareBytes(prevBytes, elementBytes);
      if (cmp === 0) {
        throw new DataError("duplicate_element", `set element ${i - 1} repeats the previous element`);
      }
      if (cmp > 0) {
        throw new DataError("unsorted_elements", `set element ${i - 1} is out of ascending order`);
      }
    }
    elements.push(element);
    prevBytes = elementBytes;
  }
  return elements;
}

// --- decimal (ontos-data.md §5.9) ---------------------------------------------

/**
 * Validates the canonical `decimal` structure and returns its `int` mantissa and
 * exponent child values, or throws DataError. The recognition gate shared by
 * `recognizeDecimal` and `readDecimal`: shape (arity-3 tuple, `decimal` label) + both
 * children canonical `int`s (`intPayload`, structural so a beyond-host child is still
 * accepted) + the canonical-decimal rule — zero is `decimal(int 0, int 0)`, and a
 * non-zero mantissa is not divisible by 10 (decided on the magnitude bytes via
 * `magnitudeMod10`).
 *
 * Unlike `list`/`map`/`set`, `decimal` RECURSES into its children: it is a scalar
 * (identity = the number it denotes), so one-spelling-per-value requires canonical-`int`
 * children — the scalar discipline, not the container discipline (§5.9). Never panics.
 */
function decimalParts(v: Value): { mantissa: Value; exponent: Value } {
  if (!(v instanceof Tuple)) {
    throw new DataError("not_a_tuple", "decimal must be a tuple");
  }
  const items = v.items();
  if (items.length !== 3) {
    throw new DataError("wrong_arity", `decimal must have arity 3, got ${items.length}`);
  }
  expectLabel(items[0], LABEL_DECIMAL);
  const mantissa = items[1]!;
  const exponent = items[2]!;
  let mantissaMag: Uint8Array;
  let exponentMag: Uint8Array;
  try {
    mantissaMag = intPayload(mantissa).magnitude;
    exponentMag = intPayload(exponent).magnitude;
  } catch {
    throw new DataError("malformed_payload", "decimal mantissa and exponent must each be a canonical int");
  }
  if (mantissaMag.length === 0) {
    // mantissa === 0 ⇒ the exponent must be canonical zero (empty magnitude).
    if (exponentMag.length !== 0) {
      throw new DataError("malformed_payload", "decimal zero mantissa requires a zero exponent");
    }
  } else if (magnitudeMod10(mantissaMag) === 0) {
    throw new DataError("malformed_payload", "decimal non-zero mantissa is divisible by 10 (trailing base-10 zero)");
  }
  return { mantissa, exponent };
}

/**
 * Builds the canonical `decimal` embedding for `mantissa × 10^exponent`:
 * `Tuple(Atom("decimal"), int(mantissa), int(exponent))` (§5.9). The producer
 * normalizes first (`normalizeDecimal`): a non-zero mantissa is stripped of trailing
 * base-10 zeros into the exponent, and zero is `decimal(int 0, int 0)`. The children are
 * the full canonical `int` embedding (§5.1), per the value-not-position rule (§2.1).
 */
export function encodeDecimal(mantissa: bigint, exponent: bigint): Value {
  const norm = normalizeDecimal(mantissa, exponent);
  return tuple([
    atom(utf8Encoder.encode(LABEL_DECIMAL)),
    encodeInt(norm.mantissa),
    encodeInt(norm.exponent),
  ]);
}

/**
 * Recognizes a canonical `decimal` embedding WITHOUT materializing its mantissa/exponent
 * into a host integer type — returns normally for every canonical `decimal` (including a
 * mantissa or exponent beyond a bounded host width) and throws DataError otherwise.
 * Structural, like `recognizeInt`; this binding's `bigint` is arbitrary precision so it
 * can always materialize what it recognizes, but ontos's tri-core CLIs use this surface
 * for `read --kind decimal` so they agree regardless of host width (§5.9). Throws only DataError.
 */
export function recognizeDecimal(v: Value): void {
  decimalParts(v);
}

/**
 * Recognizes a canonical `decimal` embedding and returns `{ mantissa, exponent }` as
 * bigints (the value is `mantissa × 10^exponent`), else throws — the same canonical-form
 * validation as `recognizeDecimal`. This binding is unbounded (`bigint`), so it never
 * reports a host-width resource limit.
 */
export function readDecimal(v: Value): { mantissa: bigint; exponent: bigint } {
  const { mantissa, exponent } = decimalParts(v);
  return { mantissa: readInt(mantissa), exponent: readInt(exponent) };
}

// --- null (ontos-data.md §5.10) -----------------------------------------------

/**
 * Builds the canonical `null` embedding: Tuple(Atom("null")) — the `null` label with NO
 * payload children (tuple arity exactly 1). `null` is the single canonical spelling of
 * present-but-no-value and its only inhabitant (there is no value to vary), so `encodeNull`
 * takes no argument and always returns the same value. Its byte form is fixed by structure
 * alone, so — like `list` and `bool` — it is codec-independent and not codec-version-relative.
 */
export function encodeNull(): Value {
  return tuple([atom(utf8Encoder.encode(LABEL_NULL))]);
}

/**
 * Recognizes the canonical `null` embedding, returning void for the single inhabitant
 * Tuple(Atom("null")) and throwing DataError otherwise. Recognition is structural: arity
 * EXACTLY 1 and the label exactly "null". Any payload (arity > 1) is NOT a well-formed null
 * — it remains a valid L0 value, merely unrecognized; the bare unlabeled arity-0 tuple and a
 * bare Atom("null") are likewise not a null. `null` carries no payload to materialize, so
 * this is also the read surface (`readNull` is its alias). Throws only DataError.
 */
export function recognizeNull(v: Value): void {
  if (!(v instanceof Tuple)) {
    throw new DataError("not_a_tuple", "null must be a tuple");
  }
  const items = v.items();
  if (items.length !== 1) {
    throw new DataError("wrong_arity", `null must have arity exactly 1, got ${items.length}`);
  }
  expectLabel(items[0], LABEL_NULL);
}

/**
 * Recognizes the canonical `null` embedding, returning void for the single inhabitant and
 * throwing DataError otherwise — identical validation to `recognizeNull` (null is
 * present-but-no-value, so recognize and read coincide, as for the empty containers).
 */
export function readNull(v: Value): void {
  recognizeNull(v);
}

// --- internal helpers ---------------------------------------------------------

/**
 * Shared shape check for the three scalar embeddings: `v` is a Tuple of arity 2
 * whose first child is the expected label atom; returns the payload atom's bytes.
 */
function payloadAtomBytes(v: Value, label: string): Uint8Array {
  if (!(v instanceof Tuple)) {
    throw new DataError("not_a_tuple", `${label} must be a tuple`);
  }
  const items = v.items();
  if (items.length !== 2) {
    throw new DataError("wrong_arity", `${label} must have arity 2, got ${items.length}`);
  }
  expectLabel(items[0], label);
  const payload = items[1];
  if (!(payload instanceof Atom)) {
    throw new DataError("malformed_payload", `${label} payload must be an atom`);
  }
  return payload.bytes();
}

/** Asserts that `child` is an Atom carrying exactly the expected label bytes. */
function expectLabel(child: Value | undefined, label: string): void {
  if (!(child instanceof Atom)) {
    throw new DataError("wrong_label", `${label} label child must be an atom`);
  }
  const want = utf8Encoder.encode(label);
  const got = child.bytes();
  if (!bytesEqual(got, want)) {
    throw new DataError("wrong_label", `expected label "${label}"`);
  }
}

/**
 * Unsigned, bytewise-lexicographic comparison of two byte strings — the
 * ontos-codec-v1 total order over values applied to their encodings (ontos-codec
 * §6). Returns < 0 if `left` sorts before `right`, > 0 if after, 0 if equal. A
 * proper prefix sorts before its extension (shorter is smaller when all shared
 * bytes match), which is what makes the empty encoding the minimum.
 */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const min = Math.min(left.length, right.length);
  for (let i = 0; i < min; i += 1) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** Big-endian, minimal-length magnitude of a non-negative bigint; 0n -> empty. */
function magnitudeBytes(value: bigint): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v > 0n) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  out.reverse();
  return Uint8Array.from(out);
}

/** Inverse of magnitudeBytes: big-endian bytes -> non-negative bigint. */
function magnitudeFromBytes(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const byte of bytes) {
    v = (v << 8n) | BigInt(byte);
  }
  return v;
}

/**
 * |n| mod 10 for a big-endian magnitude byte string (empty magnitude = 0), computed on
 * the bytes so it is independent of any host integer width (§5.9). Each step folds one
 * base-256 digit: rem = (rem*256 + b) mod 10.
 */
function magnitudeMod10(magnitude: Uint8Array): number {
  let rem = 0;
  for (const b of magnitude) {
    rem = (rem * 256 + b) % 10;
  }
  return rem;
}

/**
 * Normalizes (mantissa, exponent) to the canonical decimal pair (§5.9): a non-zero
 * mantissa is stripped of trailing base-10 zeros (each carried into the exponent), and
 * zero is (0n, 0n). The producer-side normalization (§4); `encodeDecimal` applies it.
 */
function normalizeDecimal(mantissa: bigint, exponent: bigint): { mantissa: bigint; exponent: bigint } {
  if (mantissa === 0n) return { mantissa: 0n, exponent: 0n };
  let m = mantissa;
  let e = exponent;
  while (m % 10n === 0n) {
    m /= 10n;
    e += 1n;
  }
  return { mantissa: m, exponent: e };
}

function hexByte(byte: number | undefined): string {
  return (byte ?? 0).toString(16).padStart(2, "0");
}
