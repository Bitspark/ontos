/*
 * ontos/core (L0) — the frozen value model.
 *
 *   Bytes = finite octet strings
 *   Value = Atom(Bytes) | Tuple(Value*)
 *
 * A value is finite, immutable, well-founded (a finite tree, never cyclic),
 * uninterpreted, and compared by structural identity. This module defines what a
 * value is and when two values are the same — nothing else. There is no byte
 * encoding here (that is @bitspark/ontos-codec) and no interpretation of atoms or
 * shapes. See docs/spec/ontos-core.md.
 *
 * Common Value API (all three cores)
 * ----------------------------------
 * The Go, Rust, and TypeScript cores expose the same conceptual surface so a
 * developer who learns one can predict the others. Every core provides, by its
 * own naming convention:
 *   - Construct — atom(bytes) / tuple(items) (Go NewAtom/NewTuple, Rust
 *     Value::atom/tuple).
 *   - Atom bytes + length — Atom#bytes() and Atom#length.
 *   - Tuple children + arity + indexed access — Tuple#items(), Tuple#length, and
 *     Tuple#at (matching Go Tuple.At / Rust Tuple::at).
 *   - Structural equality — Atom#equals / Tuple#equals and the exported equals
 *     (Go Equal, Rust PartialEq).
 *   - Diagnostic string — toString (Go String, Rust Display); not a canonical
 *     encoding.
 *
 * Intentional per-language extras
 * -------------------------------
 * Some members exist in only one core because they are idiomatic to that
 * language and have no natural cross-core analogue; they are intentional, not
 * accidental gaps:
 *   - TypeScript — the `kind` discriminant ("atom" | "tuple") and
 *     toJSON()/toHex(). JavaScript lacks Rust enums and Go interfaces, so the
 *     discriminant restores exhaustive narrowing without instanceof, and toJSON
 *     gives JSON/structured-clone consumers a stable shape. Go and Rust have no
 *     runtime JSON contract to honor and so omit them.
 *   - Rust — is_atom/is_tuple/as_atom/as_tuple, which classify/borrow its closed
 *     `enum` Value. TS reaches the same end with `instanceof` plus the `kind`
 *     discriminant, and Go with a type switch, so neither needs parallel methods.
 */

export type BytesLike =
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | readonly number[];

export type Value = Atom | Tuple;

/** An opaque byte atom. The bytes have no built-in interpretation. */
export class Atom {
  public readonly kind = "atom" as const;
  #bytes: Uint8Array;

  constructor(bytes: BytesLike = new Uint8Array()) {
    this.#bytes = copyBytes(bytes);
    Object.freeze(this);
  }

  get length(): number {
    return this.#bytes.length;
  }

  /** Returns a defensive copy. Mutating the result does not mutate this Atom. */
  bytes(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }

  equals(other: Value): boolean {
    return other instanceof Atom && bytesEqual(this.#bytes, other.#bytes);
  }

  toJSON(): { readonly atom: string } {
    return { atom: toHex(this.#bytes) };
  }

  toString(): string {
    return `Atom(0x${toHex(this.#bytes)})`;
  }
}

/** A finite ordered tuple of values. Arity, order, and multiplicity are semantic. */
export class Tuple {
  public readonly kind = "tuple" as const;
  #items: readonly Value[];

  constructor(items: readonly Value[] = []) {
    const copied = Array.from(items);
    for (const item of copied) {
      assertValue(item);
    }
    this.#items = Object.freeze(copied);
    Object.freeze(this);
  }

  get length(): number {
    return this.#items.length;
  }

  /** Returns a frozen array of immutable values. */
  items(): readonly Value[] {
    return this.#items;
  }

  at(index: number): Value | undefined {
    return this.#items[index];
  }

  equals(other: Value): boolean {
    if (!(other instanceof Tuple)) return false;
    if (this.#items.length !== other.#items.length) return false;
    for (let i = 0; i < this.#items.length; i += 1) {
      const left = this.#items[i];
      const right = other.#items[i];
      if (left === undefined || right === undefined || !left.equals(right)) {
        return false;
      }
    }
    return true;
  }

  toJSON(): { readonly tuple: readonly Value[] } {
    return { tuple: this.#items };
  }

  toString(): string {
    return `Tuple(${this.#items.map((item) => item.toString()).join(", ")})`;
  }
}

export function atom(bytes: BytesLike = new Uint8Array()): Atom {
  return new Atom(bytes);
}

export function tuple(items: readonly Value[] = []): Tuple {
  return new Tuple(items);
}

export function isValue(value: unknown): value is Value {
  return value instanceof Atom || value instanceof Tuple;
}

export function equals(left: Value, right: Value): boolean {
  return left.equals(right);
}

export function assertValue(value: unknown): asserts value is Value {
  if (!isValue(value)) {
    throw new TypeError("expected an ontos Value");
  }
}

/**
 * Copies `input` into a fresh Uint8Array that nothing else references.
 *
 * - An ArrayBuffer is copied whole; any ArrayBufferView (a Uint8Array or another
 *   typed array, or a DataView) is copied as its byteOffset..byteOffset+byteLength
 *   range of its buffer. Objects from another realm are accepted alike.
 * - A number[] is read exactly once: its `length` once, then each index once, in
 *   order. Every element must be an integer 0..255, and the byte stored is the very
 *   element that passed that check. A hole reads as `undefined` and is refused.
 *
 * Nothing the caller can redefine is consulted (ontos#32). An array's elements are read
 * by index, never through its iterator, so a getter that answers differently on a second
 * read never gets one. A buffer's or view's geometry is read from its internal slots
 * through the built-in accessors, never through properties that an own getter, a
 * subclass or a borrowed prototype could override.
 */
export function copyBytes(input: BytesLike): Uint8Array {
  const value: unknown = input;
  if (ArrayBuffer.isView(value)) {
    return copyView(value);
  }
  if (Array.isArray(value)) {
    return copyByteArray(value);
  }
  // Last of the three: its brand check throws and catches on every input that fails it.
  const bufferLength = arrayBufferByteLength(value);
  if (bufferLength !== undefined) {
    return copyRange(value as ArrayBuffer, 0, bufferLength);
  }
  throw new TypeError("expected bytes as Uint8Array, ArrayBuffer, ArrayBufferView, or number[]");
}

// Built-in accessors, taken once when the module loads. Each reads an internal slot,
// so it answers the same from any realm and runs no caller code.
type Accessor = (target: unknown) => unknown;

function builtinGetter(prototype: object, key: PropertyKey): Accessor {
  const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
  if (getter === undefined) {
    throw new Error(`ontos-core: built-in accessor ${String(key)} is missing`);
  }
  return (target) => Reflect.apply(getter, target, []);
}

function builtinMethod(prototype: object, key: PropertyKey): Accessor {
  const method: unknown = Reflect.get(prototype, key);
  if (typeof method !== "function") {
    throw new Error(`ontos-core: built-in method ${String(key)} is missing`);
  }
  return (target) => Reflect.apply(method, target, []);
}

const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
// The element type's name for a typed array; undefined for anything else, never a throw.
const typedArrayName = builtinGetter(typedArrayPrototype, Symbol.toStringTag);
// Throws a TypeError when a typed array's buffer is detached or has shrunk below it.
const assertTypedArrayInBounds = builtinMethod(typedArrayPrototype, "keys");
const typedArrayBuffer = builtinGetter(typedArrayPrototype, "buffer");
const typedArrayByteOffset = builtinGetter(typedArrayPrototype, "byteOffset");
const typedArrayByteLength = builtinGetter(typedArrayPrototype, "byteLength");
// The DataView accessors throw on a detached or out-of-bounds view themselves.
const dataViewBuffer = builtinGetter(DataView.prototype, "buffer");
const dataViewByteOffset = builtinGetter(DataView.prototype, "byteOffset");
const dataViewByteLength = builtinGetter(DataView.prototype, "byteLength");
const arrayBufferByteLengthGetter = builtinGetter(ArrayBuffer.prototype, "byteLength");

/** Its byte length if `value` is an ArrayBuffer (not shared) from any realm, else undefined. */
function arrayBufferByteLength(value: unknown): number | undefined {
  try {
    return arrayBufferByteLengthGetter(value) as number;
  } catch {
    return undefined;
  }
}

function copyView(view: ArrayBufferView): Uint8Array {
  const name = typedArrayName(view);
  if (name === "Uint8Array") {
    // The fast path, for an atom cut from a byte buffer (e.g. the codec's per-atom
    // subarray). The brand says it is a genuine Uint8Array, from any realm, possibly a
    // subclass. Copying it with the constructor reads its internal slots only, runs no
    // caller code (no getter, no `constructor`, no species), throws a TypeError if its
    // buffer is detached or shrank below it, and never shares memory, even when the
    // source is backed by a SharedArrayBuffer.
    return new Uint8Array(view as Uint8Array);
  }
  if (name !== undefined) {
    assertTypedArrayInBounds(view);
    return copyRange(
      typedArrayBuffer(view) as ArrayBufferLike,
      typedArrayByteOffset(view) as number,
      typedArrayByteLength(view) as number,
    );
  }
  // Every ArrayBufferView that is not a typed array is a DataView.
  return copyRange(
    dataViewBuffer(view) as ArrayBufferLike,
    dataViewByteOffset(view) as number,
    dataViewByteLength(view) as number,
  );
}

/** A fresh, unshared copy of `buffer`'s bytes byteOffset..byteOffset+byteLength. */
function copyRange(buffer: ArrayBufferLike, byteOffset: number, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes.set(new Uint8Array(buffer, byteOffset, byteLength));
  return bytes;
}

// The range of an array's `length`. Only a Proxy can report anything else.
const MAX_ARRAY_LENGTH = 2 ** 32 - 1;

function copyByteArray(source: readonly unknown[]): Uint8Array {
  const length: unknown = source.length;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
    throw new RangeError(`byte array length out of range: ${describe(length)}`);
  }
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const byte: unknown = source[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new RangeError(`byte array element out of range: ${describe(byte)}`);
    }
    bytes[index] = byte;
  }
  return bytes;
}

/**
 * Names a refused value for an error message without running caller code: a
 * primitive (a symbol included) as String renders it, an object or function only by
 * its typeof, since converting it would call its toString or Symbol.toPrimitive.
 */
function describe(value: unknown): string {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof value
    : String(value);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
