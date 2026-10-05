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

export function copyBytes(input: BytesLike): Uint8Array {
  if (input instanceof Uint8Array) {
    return new Uint8Array(input);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input.slice(0));
  }
  if (ArrayBuffer.isView(input)) {
    const start = input.byteOffset;
    const end = input.byteOffset + input.byteLength;
    return new Uint8Array(input.buffer.slice(start, end));
  }
  if (Array.isArray(input)) {
    for (const byte of input) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new RangeError(`byte array element out of range: ${byte}`);
      }
    }
    return Uint8Array.from(input);
  }
  throw new TypeError("expected bytes as Uint8Array, ArrayBuffer, ArrayBufferView, or number[]");
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
