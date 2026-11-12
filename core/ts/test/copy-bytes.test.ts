/*
 * copyBytes and the Atom constructor read the caller's bytes once (ontos#32).
 *
 * A byte the Atom stores must be the byte that passed validation. These tests hand
 * both entry points inputs that answer differently each time they are read (index
 * getters, a Proxy, a custom iterator), views and buffers whose geometry properties
 * are redefined or forged, and views from another realm. They pin that the number[]
 * branch observes `length` once and each index once, in order, and that the binary
 * branches read a view's real range from its internal slots, never from a property
 * the caller controls.
 *
 * Auto-discovered by the ts CI glob (core/ts/test/*.test.ts). Run directly:
 *   node --test core/ts/test/copy-bytes.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { Atom, atom, copyBytes, tuple, type BytesLike, type Value } from "../src/index.ts";

const asBytes = (value: unknown): BytesLike => value as BytesLike;
const list = (bytes: Uint8Array | Atom): number[] =>
  Array.from(bytes instanceof Atom ? bytes.bytes() : bytes);

const NOT_BYTES = {
  name: "TypeError",
  message: "expected bytes as Uint8Array, ArrayBuffer, ArrayBufferView, or number[]",
};
const elementOutOfRange = (shown: string) => ({
  name: "RangeError",
  message: `byte array element out of range: ${shown}`,
});

// Both entry points the issue names: the exported copy and the Atom it backs.
const entries: ReadonlyArray<[string, (input: BytesLike) => number[]]> = [
  ["copyBytes", (input) => list(copyBytes(input))],
  ["new Atom", (input) => list(new Atom(input))],
];

/** An array whose index 0 is a getter answering `answers` in turn, counting its reads. */
function changingArray(answers: readonly unknown[]): { source: number[]; reads: () => number } {
  let reads = 0;
  const source: number[] = [0];
  Object.defineProperty(source, 0, {
    get() {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      return answer;
    },
  });
  return { source, reads: () => reads };
}

// --- number[]: one observation ------------------------------------------------

for (const [name, read] of entries) {
  test(`${name}: an index getter is read once and its first answer is the byte stored`, () => {
    // The issue's repro: the old second pass read 256 and stored it as 0.
    const { source, reads } = changingArray([17, 256]);
    assert.deepEqual(read(source), [17]);
    assert.equal(reads(), 1);
  });

  test(`${name}: an index getter whose first answer is out of range is refused on that answer`, () => {
    const { source, reads } = changingArray([256, 17]);
    assert.throws(() => read(source), elementOutOfRange("256"));
    assert.equal(reads(), 1);
  });
}

test("a Proxy over a number[] sees `length` once, then each index once, in order", () => {
  const seen: string[] = [];
  const source = new Proxy([1, 2, 3], {
    get(target, key, receiver) {
      seen.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(list(atom(asBytes(source))), [1, 2, 3]);
  assert.deepEqual(seen, ["length", "0", "1", "2"]);
});

test("a Proxy whose length changes per read is held to its first answer", () => {
  let lengthReads = 0;
  const source = new Proxy([4, 5, 6], {
    get(target, key, receiver) {
      if (key === "length") return ++lengthReads === 1 ? 2 : 3;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(list(copyBytes(asBytes(source))), [4, 5]);
  assert.equal(lengthReads, 1);
});

test("a Proxy whose length is not an array length is refused", () => {
  for (const length of [-1, 1.5, "2", 2 ** 32, Number.NaN]) {
    const source = new Proxy([], {
      get: (target, key, receiver) => (key === "length" ? length : Reflect.get(target, key, receiver)),
    });
    assert.throws(() => copyBytes(asBytes(source)), {
      name: "RangeError",
      message: `byte array length out of range: ${String(length)}`,
    });
  }
});

test("elements appended while the array is read are not taken: its length was read first", () => {
  const source: number[] = [1, 2];
  Object.defineProperty(source, 0, {
    get() {
      source.push(3);
      return 1;
    },
  });
  assert.deepEqual(list(copyBytes(source)), [1, 2]);
});

test("an overridden Symbol.iterator is never consulted: the bytes are read by index", () => {
  let iterated = 0;
  const source = [3, 4];
  Object.defineProperty(source, Symbol.iterator, {
    value: function* () {
      iterated += 1;
      yield 17;
      yield 256;
    },
  });
  for (const [, read] of entries) {
    assert.deepEqual(read(source), [3, 4]);
  }
  assert.equal(iterated, 0);
});

test("a hole is refused exactly like an undefined element", () => {
  const holey = [1, , 2];
  assert.throws(() => copyBytes(asBytes(holey)), elementOutOfRange("undefined"));
  assert.throws(() => copyBytes(asBytes([1, undefined, 2])), elementOutOfRange("undefined"));
  assert.throws(() => atom(asBytes(new Array(3))), elementOutOfRange("undefined"));
});

// --- number[]: a claimed length is not an allocation ------------------------------
//
// A sparse array or a Proxy can claim length 2^32 - 1 while holding nothing. v0.17.0
// allocated the whole claim (4 GiB) before reading index 0, so these were refused only
// where the allocation happened to succeed: under `ulimit -v 2000000` they threw
// "Array buffer allocation failed" instead. The copy may size an allocation from the
// claim only up to 64 KiB.
//
// Each case below reads Node's ArrayBuffer memory at the moment the copy reads the
// element it refuses, when an allocation sized by the claim would be live. Two checks:
// - the total stays below HELD_LIMIT, which a live 4 GiB allocation cannot, whatever
//   the GC has collected;
// - the growth since the copy began stays below ALLOWED_BYTES. A collection during the
//   copy can only shrink this figure, so it confirms the bound but cannot replace the
//   first check.

const CLAIMED = 2 ** 32 - 1;
/** Far below the 4 GiB a claim-sized allocation holds, far above all else this file holds. */
const HELD_LIMIT = 2 ** 29;
/** Far above the 64 KiB the copy may take from a claim. */
const ALLOWED_BYTES = 2 ** 20;
const arrayBufferBytes = (): number => process.memoryUsage().arrayBuffers;

/** Asserts what the copy held when it read the element it refused (see above). */
function assertHeld(total: number, grown: number, allowed: number, at: string): void {
  assert.ok(total < HELD_LIMIT, `${total} bytes of ArrayBuffer held when ${at} was read`);
  assert.ok(grown < allowed, `${grown} more bytes of ArrayBuffer held when ${at} was read`);
}

for (const [name, read] of entries) {
  test(`${name}: a sparse array claiming length 2^32 - 1 is refused at index 0, with nothing sized by its length`, () => {
    const sparse: number[] = [];
    sparse.length = CLAIMED;
    assert.throws(() => read(sparse), elementOutOfRange("undefined"));

    let total = Number.NaN;
    const watched: number[] = [];
    watched.length = CLAIMED;
    Object.defineProperty(watched, 0, {
      get() {
        total = arrayBufferBytes();
        return undefined;
      },
    });
    const before = arrayBufferBytes();
    assert.throws(() => read(watched), elementOutOfRange("undefined"));
    assertHeld(total, total - before, ALLOWED_BYTES, "index 0");
  });

  test(`${name}: a Proxy claiming length 2^32 - 1 is refused at index 0, having read nothing more`, () => {
    const seen: string[] = [];
    let total = Number.NaN;
    const source = new Proxy([], {
      get(_target, key) {
        seen.push(String(key));
        if (key === "length") return CLAIMED;
        // Fails fast, rather than reading 2^32 - 1 elements, if 256 were ever taken.
        if (key !== "0") throw new Error(`index ${String(key)} read past the refused element`);
        total = arrayBufferBytes();
        return 256;
      },
    });
    const before = arrayBufferBytes();
    assert.throws(() => read(asBytes(source)), elementOutOfRange("256"));
    assert.deepEqual(seen, ["length", "0"]);
    assertHeld(total, total - before, ALLOWED_BYTES, "index 0");
  });
}

test("a Proxy claiming length 2^32 - 1 and refused deep in is held to memory in proportion to what it read", () => {
  // Past two growths of the result (64 KiB -> 512 KiB -> 4 MiB).
  const refusedAt = 600_000;
  let reads = 0;
  let total = Number.NaN;
  const source = new Proxy([], {
    get(_target, key) {
      if (key === "length") return CLAIMED;
      assert.equal(key, String(reads), "each index once, in order");
      reads += 1;
      if (reads <= refusedAt) return reads & 0xff;
      if (reads > refusedAt + 1) throw new Error(`index ${String(key)} read past the refused element`);
      total = arrayBufferBytes();
      return -1;
    },
  });
  const before = arrayBufferBytes();
  assert.throws(() => copyBytes(asBytes(source)), elementOutOfRange("-1"));
  assert.equal(reads, refusedAt + 1);
  // The live result is at most 8 bytes per byte read, and the results it outgrew (at most
  // one more per byte read) may not be collected yet; plus the bound.
  assertHeld(total, total - before, 9 * refusedAt + ALLOWED_BYTES, `index ${refusedAt}`);
});

test("a number[] longer than 64 KiB is copied exactly, each index read once, into a buffer of its exact length", () => {
  for (const length of [0xffff, 0x10000, 0x10001, 0x80000, 0x80001, 600_001]) {
    const bytes = Array.from({ length }, (_, i) => (i * 7 + 3) & 0xff);
    let reads = 0;
    const counted = new Proxy(bytes, {
      get(target, key, receiver) {
        if (key !== "length") reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const copy = copyBytes(asBytes(counted));
    assert.equal(reads, length);
    assert.equal(copy.length, length);
    assert.equal(copy.byteOffset, 0);
    assert.equal(copy.buffer.byteLength, length);
    assert.ok(copy.every((byte, i) => byte === bytes[i]), `length ${length}`);
    assert.ok(atom(bytes).equals(new Atom(copy)), `length ${length}`);
  }
});

test("numbers outside 0..255, non-integers and non-numbers are still refused", () => {
  const refused: ReadonlyArray<[unknown, string]> = [
    [256, "256"],
    [-1, "-1"],
    [1.5, "1.5"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    ["1", "1"],
    [1n, "1"],
    [null, "null"],
    [Symbol("s"), "Symbol(s)"],
  ];
  for (const [element, shown] of refused) {
    for (const [, read] of entries) {
      assert.throws(() => read(asBytes([0, element])), elementOutOfRange(shown));
    }
  }
  assert.deepEqual(list(copyBytes([0, 255, -0])), [0, 255, 0]);
});

test("a refused object element is named without running its conversions", () => {
  let converted = 0;
  const element = {
    toString() {
      converted += 1;
      return "1";
    },
    [Symbol.toPrimitive]() {
      converted += 1;
      return 1;
    },
  };
  assert.throws(() => copyBytes(asBytes([element])), elementOutOfRange("object"));
  assert.throws(() => copyBytes(asBytes([() => 1])), elementOutOfRange("function"));
  assert.equal(converted, 0);
});

// --- binary inputs: the real range, from internal slots --------------------------

/** Redefines `keys` on `target` as getters that count their reads and lie. */
function lyingGetters(target: object, keys: readonly string[]): () => number {
  let reads = 0;
  for (const key of keys) {
    Object.defineProperty(target, key, {
      get() {
        reads += 1;
        return key === "buffer" ? { slice: () => [300] } : 1;
      },
    });
  }
  return () => reads;
}

// A genuine Uint8Array takes the fast path (`new Uint8Array(view)`); these pin that it
// still consults nothing the caller controls, including what a copy constructor of an
// older spec looked up: the buffer's `constructor` and the species.
test("a Uint8Array subclass overriding its geometry and iterator is copied as its real bytes", () => {
  let overrides = 0;
  class Lying extends Uint8Array {
    static get [Symbol.species](): Uint8ArrayConstructor {
      overrides += 1;
      return Uint8Array;
    }
    override get length(): number {
      overrides += 1;
      return 9;
    }
    override get byteOffset(): number {
      overrides += 1;
      return 1;
    }
    override get byteLength(): number {
      overrides += 1;
      return 9;
    }
    override get buffer(): ArrayBuffer {
      overrides += 1;
      return new ArrayBuffer(9);
    }
    override *[Symbol.iterator](): ArrayIterator<number> {
      overrides += 1;
      yield 300;
    }
  }
  const backing = new Uint8Array([0, 1, 2, 3, 4]).buffer;
  const source = new Lying(backing, 1, 3);
  const reads = lyingGetters(source, ["constructor"]);
  const bufferReads = lyingGetters(backing, ["constructor"]);
  for (const [, read] of entries) {
    assert.deepEqual(read(source), [1, 2, 3]);
  }
  assert.equal(overrides + reads() + bufferReads(), 0);
});

test("views whose buffer and range getters are redefined are copied as their real range", () => {
  const backing = new Uint8Array([10, 11, 12, 13, 14, 15]);
  const views: ArrayBufferView[] = [
    new Uint8Array(backing.buffer, 1, 4),
    new Uint16Array(backing.buffer, 2, 2),
    new DataView(backing.buffer, 1, 4),
  ];
  const expected = [
    [11, 12, 13, 14],
    [12, 13, 14, 15],
    [11, 12, 13, 14],
  ];
  views.forEach((view, i) => {
    const reads = lyingGetters(view, ["buffer", "byteOffset", "byteLength", "length"]);
    for (const [, read] of entries) {
      assert.deepEqual(read(view), expected[i]);
    }
    assert.equal(reads(), 0);
  });
});

test("an ArrayBuffer with its own slice is copied as its real bytes", () => {
  const buffer = new Uint8Array([7, 8]).buffer;
  let sliced = 0;
  Object.defineProperty(buffer, "slice", {
    value: () => {
      sliced += 1;
      return [300];
    },
  });
  const reads = lyingGetters(buffer, ["byteLength"]);
  for (const [, read] of entries) {
    assert.deepEqual(read(buffer), [7, 8]);
  }
  assert.equal(sliced + reads(), 0);
});

test("an object that only borrows a binary prototype is not bytes", () => {
  let consulted = 0;
  const forged = (prototype: object) =>
    Object.setPrototypeOf(
      {
        length: 1,
        0: 300,
        *[Symbol.iterator]() {
          consulted += 1;
          yield 300;
        },
        slice() {
          consulted += 1;
          return [300];
        },
      },
      prototype,
    );
  for (const prototype of [Uint8Array.prototype, Uint16Array.prototype, DataView.prototype, ArrayBuffer.prototype]) {
    for (const [, read] of entries) {
      assert.throws(() => read(asBytes(forged(prototype))), NOT_BYTES);
    }
  }
  assert.equal(consulted, 0);
});

test("binary inputs are copied: the result owns a fresh, unshared buffer", () => {
  const backing = new Uint8Array([1, 2, 3, 4]);
  const inputs: BytesLike[] = [
    backing,
    backing.subarray(1, 3),
    backing.buffer,
    new DataView(backing.buffer, 1, 2),
    new Uint8Array(new SharedArrayBuffer(4)),
    new Uint16Array(new SharedArrayBuffer(4), 2, 1),
    new DataView(new SharedArrayBuffer(4), 1, 2),
    new Uint16Array(new SharedArrayBuffer(2, { maxByteLength: 8 })),
    Array.from({ length: 0x10001 }, (_, i) => i & 0xff),
  ];
  for (const input of inputs) {
    const copy = copyBytes(input);
    assert.equal(copy.byteOffset, 0);
    assert.equal(copy.buffer.byteLength, copy.length);
    assert.ok(!(copy.buffer instanceof SharedArrayBuffer));
    assert.ok(!copy.buffer.resizable);
    assert.notEqual(copy.buffer, backing.buffer);
  }
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  shared.set([5, 6, 7, 8]);
  assert.deepEqual(list(copyBytes(new DataView(shared.buffer, 1, 2))), [6, 7]);
  assert.deepEqual(list(copyBytes(new Uint16Array(shared.buffer, 2, 1))), [7, 8]);
  const held = atom(backing.subarray(1, 3));
  backing.fill(0);
  assert.deepEqual(list(held), [2, 3]);
});

test("a typed array over a resizable buffer is copied at its length when copied", () => {
  const buffer = new ArrayBuffer(2, { maxByteLength: 8 });
  const tracking = new Uint8Array(buffer);
  buffer.resize(3);
  new Uint8Array(buffer).set([1, 2, 3]);
  assert.deepEqual(list(copyBytes(tracking)), [1, 2, 3]);
  // A length-tracking view of wider elements covers only its whole elements.
  assert.deepEqual(list(copyBytes(new Uint16Array(buffer))), [1, 2]);
  assert.deepEqual(list(copyBytes(new DataView(buffer, 1))), [2, 3]);
});

test("a view over a detached or shrunk buffer is refused with a TypeError", () => {
  const detach = (buffer: ArrayBuffer) => structuredClone(buffer, { transfer: [buffer] });
  const detached = (make: (buffer: ArrayBuffer) => BytesLike) => {
    const buffer = new ArrayBuffer(4);
    const input = make(buffer);
    detach(buffer);
    return input;
  };
  const inputs: BytesLike[] = [
    detached((buffer) => buffer),
    detached((buffer) => new Uint8Array(buffer)),
    detached((buffer) => new Uint16Array(buffer)),
    detached((buffer) => new DataView(buffer)),
  ];
  const shrunk: ReadonlyArray<(buffer: ArrayBuffer) => ArrayBufferView> = [
    (buffer) => new Uint8Array(buffer, 2, 2),
    (buffer) => new Uint16Array(buffer, 2, 1),
    (buffer) => new DataView(buffer, 2, 2),
    // Length-tracking views are out of bounds once the buffer ends before their offset.
    (buffer) => new Uint8Array(buffer, 2),
    (buffer) => new Uint16Array(buffer, 2),
    (buffer) => new DataView(buffer, 2),
  ];
  for (const make of shrunk) {
    const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
    const view = make(buffer);
    buffer.resize(1);
    inputs.push(view);
  }
  for (const input of inputs) {
    for (const [, read] of entries) {
      assert.throws(() => read(input), TypeError);
    }
  }
});

// --- other realms (node:vm) -----------------------------------------------------

test("views, buffers and arrays from another realm are accepted with their range", () => {
  const realm = vm.createContext({});
  const foreign = (source: string): BytesLike => asBytes(vm.runInContext(source, realm));
  const cases: ReadonlyArray<[string, number[]]> = [
    ["new Uint8Array([1, 2, 3, 4]).subarray(1, 3)", [2, 3]],
    ["new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2)", [2, 3]],
    ["new Uint16Array(new Uint8Array([1, 2, 3, 4, 5, 6]).buffer, 2, 2)", [3, 4, 5, 6]],
    ["new Uint8Array([5, 6]).buffer", [5, 6]],
    ["[7, 8]", [7, 8]],
  ];
  for (const [source, expected] of cases) {
    const input = foreign(source);
    assert.ok(!(input instanceof Uint8Array) && !(input instanceof DataView) && !(input instanceof ArrayBuffer));
    for (const [, read] of entries) {
      assert.deepEqual(read(input), expected, source);
    }
  }
  assert.throws(() => copyBytes(foreign("[256]")), elementOutOfRange("256"));
});

test("a view from another realm with redefined getters is still copied as its real range", () => {
  const realm = vm.createContext({});
  for (const source of [
    "new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2)",
    "new Uint8Array([1, 2, 3, 4]).subarray(1, 3)",
  ]) {
    const view = vm.runInContext(source, realm) as ArrayBufferView;
    const reads = lyingGetters(view, ["buffer", "byteOffset", "byteLength", "length", "constructor"]);
    for (const [, read] of entries) {
      assert.deepEqual(read(view), [2, 3], source);
    }
    assert.equal(reads(), 0, source);
  }
});

test("a detached or shrunk Uint8Array from another realm is refused with a TypeError", () => {
  const realm = vm.createContext({});
  const views = vm.runInContext(
    `const detached = new ArrayBuffer(4);
     const shrinking = new ArrayBuffer(4, { maxByteLength: 8 });
     const views = [new Uint8Array(detached), new Uint8Array(shrinking, 2, 2)];
     detached.transfer();
     shrinking.resize(1);
     views`,
    realm,
  ) as Uint8Array[];
  for (const view of views) {
    for (const [, read] of entries) {
      assert.throws(() => read(view), TypeError);
    }
  }
});

// --- built-ins redefined after load ----------------------------------------------
//
// On v0.17.0 the copy and an Atom's methods looked some built-ins up at call time.
// - A redefined Uint8Array.prototype.set stored [99, 2] for the DataView, Uint16Array and
//   ArrayBuffer [1, 2], and a redefined Reflect.apply ran on every copy.
// - Atom#length, bytes(), toString()/toJSON() and equals() handed the Atom's private bytes
//   to the %TypedArray% length getter, the global Uint8Array and Array.from, so redefining
//   any of these could rewrite an existing Atom.
// Every built-in they call is now taken when the module loads. The first test replaces
// each global and built-in property the copy and the Atom use, or that an older engine's
// copy constructor consulted, with an accessor that counts its reads. It then runs every
// kind of input and refusal through the three entry points and every Atom method, and
// puts everything back before asserting anything. The second test runs the reproducers.

test("built-ins redefined after ontos-core loaded are never read by the copy or by an Atom", () => {
  const { apply, defineProperty, deleteProperty, getOwnPropertyDescriptor } = Reflect;
  const typedArray: object = Object.getPrototypeOf(Uint8Array);
  const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
  const replaced: ReadonlyArray<[object, PropertyKey]> = [
    ...(["Uint8Array", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Array", "Number", "Object", "String",
      "Symbol", "Math", "Reflect", "Function", "Error", "RangeError", "TypeError"] as const)
      .map((key): [object, PropertyKey] => [globalThis, key]),
    [ArrayBuffer, "isView"],
    [ArrayBuffer, Symbol.species],
    [Array, "isArray"],
    [Number, "isInteger"],
    [Object, "freeze"],
    [Reflect, "apply"],
    [Reflect, "construct"],
    [Reflect, "get"],
    [Function.prototype, "call"],
    [Function.prototype, "apply"],
    [Function.prototype, "bind"],
    [typedArray, Symbol.species],
    ...(["set", "at", "keys", "subarray", "slice", "buffer", "byteOffset", "byteLength", "length",
      Symbol.toStringTag, Symbol.iterator] as const).map((key): [object, PropertyKey] => [typedArrayPrototype, key]),
    [Uint8Array.prototype, "set"],
    [Uint8Array.prototype, "constructor"],
    [DataView.prototype, "buffer"],
    [DataView.prototype, "byteOffset"],
    [DataView.prototype, "byteLength"],
    [ArrayBuffer.prototype, "byteLength"],
    [ArrayBuffer.prototype, "slice"],
    [ArrayBuffer.prototype, "constructor"],
    [SharedArrayBuffer.prototype, "slice"],
    [SharedArrayBuffer.prototype, "constructor"],
    [Array.prototype, Symbol.iterator],
    [Array, "from"],
    [Array.prototype, "join"],
    [Array.prototype, "map"],
    [Number.prototype, "toString"],
    [String.prototype, "padStart"],
    [Object.prototype, "isPrototypeOf"],
    [globalThis, "JSON"],
  ];

  // Every input is built, and every entry point bound, before anything is replaced.
  const detach = (buffer: ArrayBuffer) => structuredClone(buffer, { transfer: [buffer] });
  const detachedUint16 = new Uint16Array(new ArrayBuffer(4));
  detach(detachedUint16.buffer as ArrayBuffer);
  const detachedView = new DataView(new ArrayBuffer(4));
  detach(detachedView.buffer as ArrayBuffer);
  const shrinking = new ArrayBuffer(4, { maxByteLength: 8 });
  const outOfBounds = new Uint16Array(shrinking, 2, 1);
  shrinking.resize(1);
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  shared.set([14, 15, 16, 17]);
  const inputs: unknown[] = [
    new Uint8Array([1, 2, 3, 4]).subarray(1, 3),
    new Uint16Array(new Uint8Array([5, 6, 7, 8]).buffer, 2, 1),
    new DataView(new Uint8Array([9, 10, 11]).buffer, 1, 2),
    new Uint8Array([12, 13]).buffer,
    shared,
    new DataView(shared.buffer, 1, 2),
    [18, 19],
    Array.from({ length: 0x10000 + 3 }, (_, i) => i & 0xff),
    [0, 256],
    [0, Symbol("s")],
    [0, {}],
    new Proxy([], { get: (_target, key) => (key === "length" ? "2" : undefined) }),
    new Set([1]),
    detachedUint16,
    detachedView,
    outOfBounds,
  ];
  const runs: Array<() => unknown> = [() => new Atom(), () => atom()];
  for (const input of inputs) {
    const bytes = asBytes(input);
    runs.push(() => copyBytes(bytes), () => new Atom(bytes), () => atom(bytes));
  }
  // An Atom made before the replacement, read through every method after it.
  const held = atom([1, 2, 3]);
  const peers: Value[] = [atom([1, 2, 3]), atom([1, 2, 4]), atom([1, 2, 3, 4]), tuple([held])];
  runs.push(() => held.length, () => held.bytes(), () => held.toJSON(), () => held.toString(), () => held.kind);
  for (const peer of peers) {
    runs.push(() => held.equals(peer));
  }
  type Outcome = { value: unknown } | { error: unknown };
  const runAll = (): Outcome[] => {
    const outcomes: Outcome[] = [];
    for (let i = 0; i < runs.length; i += 1) {
      try {
        outcomes[i] = { value: runs[i]!() };
      } catch (error) {
        outcomes[i] = { error };
      }
    }
    return outcomes;
  };

  // What to put back (the own property, if any) and the built-in each replacement serves.
  // Between replacing and restoring, the test itself touches only these locals, index
  // loops and the captured Reflect functions, so every counted read is the copy's.
  const plan = replaced.map(([owner, key]) => {
    const own = getOwnPropertyDescriptor(owner, key);
    const builtin = own ?? getOwnPropertyDescriptor(Object.getPrototypeOf(owner), key);
    assert.ok(builtin !== undefined, `${String(key)} is a built-in`);
    return { owner, key, own, builtin };
  });
  let reads = 0;
  let refused = 0;
  let replacedCount = 0;
  let patched: Outcome[] = [];
  try {
    for (; replacedCount < plan.length; replacedCount += 1) {
      const { owner, key, builtin } = plan[replacedCount]!;
      const { get, value } = builtin;
      const ok = defineProperty(owner, key, {
        configurable: true,
        get() {
          reads += 1;
          return get === undefined ? value : apply(get, this, []);
        },
      });
      if (!ok) refused += 1;
    }
    patched = runAll();
  } finally {
    while (replacedCount > 0) {
      replacedCount -= 1;
      const { owner, key, own } = plan[replacedCount]!;
      const ok = own === undefined ? deleteProperty(owner, key) : defineProperty(owner, key, own);
      if (!ok) refused += 1;
    }
  }

  assert.equal(refused, 0, "every built-in was replaced and put back");
  assert.equal(reads, 0, "a built-in replaced after load was read");
  const shown = (outcome: Outcome) => {
    if ("error" in outcome) {
      return { error: (outcome.error as Error).constructor, message: (outcome.error as Error).message };
    }
    const { value } = outcome;
    return value instanceof Atom || value instanceof Uint8Array ? { bytes: list(value) } : { value };
  };
  assert.deepEqual(patched.map(shown), runAll().map(shown));
  assert.equal(patched.filter((outcome) => "error" in outcome).length, 3 * 8);
  assert.deepEqual(patched.slice(-9).map(shown), [
    { value: 3 },
    { bytes: [1, 2, 3] },
    { value: { atom: "010203" } },
    { value: "Atom(0x010203)" },
    { value: "atom" },
    { value: true },
    { value: false },
    { value: false },
    { value: false },
  ]);
  assert.deepEqual(list(held), [1, 2, 3]);
});

test("built-ins redefined after load to write into what they are given change no stored byte", () => {
  const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
  const OriginalUint8Array = Uint8Array;
  const { apply } = Reflect;
  const { from } = Array;
  const { set } = OriginalUint8Array.prototype;
  const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")!.get!;
  const sources = (): BytesLike[] => [
    new DataView(new Uint8Array([1, 2]).buffer),
    new Uint16Array(new Uint8Array([1, 2]).buffer),
    new Uint8Array([1, 2]).buffer,
  ];
  const inputs = sources();
  const held = atom([1, 2, 3]);
  const same = atom([1, 2, 3]);

  // The reproducers. Each stand-in does its built-in's job, and first writes 99 into what
  // it was handed.
  const standIns: ReadonlyArray<[object, PropertyKey, PropertyDescriptor]> = [
    // copyRange called bytes.set(view), found through the prototype.
    [OriginalUint8Array.prototype, "set", {
      value(this: Uint8Array, source: ArrayLike<number>) {
        apply(set, this, [source]);
        this[0] = 99;
      },
    }],
    // Atom#length (and equals) read the private bytes' length through the prototype.
    [typedArrayPrototype, "length", {
      get(this: Uint8Array) {
        this[0] = 99;
        return apply(lengthGetter, this, []);
      },
    }],
    // Atom#bytes() called the global Uint8Array with the private bytes.
    [globalThis, "Uint8Array", {
      value: function (source: Uint8Array) {
        source[0] = 99;
        return new OriginalUint8Array(source);
      },
    }],
    // Atom#toString() and toJSON() called Array.from with the private bytes.
    [Array, "from", {
      value(source: Uint8Array, map: (byte: number) => string) {
        source[0] = 99;
        return apply(from, Array, [source, map]);
      },
    }],
  ];
  const originals = standIns.map(([owner, key]) => Object.getOwnPropertyDescriptor(owner, key));
  let copies: Uint8Array[] = [];
  let read: unknown[] = [];
  try {
    for (const [owner, key, standIn] of standIns) {
      Object.defineProperty(owner, key, { ...standIn, configurable: true });
    }
    copies = inputs.map((input) => copyBytes(input));
    read = [held.length, held.bytes(), held.toString(), held.toJSON(), held.equals(same)];
  } finally {
    standIns.forEach(([owner, key], i) => {
      const original = originals[i];
      if (original === undefined) Reflect.deleteProperty(owner, key);
      else Object.defineProperty(owner, key, original);
    });
  }

  assert.deepEqual(copies.map(list), [[1, 2], [1, 2], [1, 2]]);
  assert.deepEqual(read, [3, new Uint8Array([1, 2, 3]), "Atom(0x010203)", { atom: "010203" }, true]);
  assert.deepEqual(list(held), [1, 2, 3]);
  assert.deepEqual(list(same), [1, 2, 3]);
});

// --- kinds that are not bytes stay refused --------------------------------------

// A Proxy over a typed array or an ArrayBuffer has none of their internal slots, so it
// is not bytes; it was refused before too, with whatever TypeError V8 raised first.
test("inputs that are none of the four kinds are refused with the bytes TypeError", () => {
  const refused: unknown[] = [
    new Set([1]),
    { length: 1, 0: 1 },
    "ab",
    1,
    null,
    new SharedArrayBuffer(1),
    new Proxy(new Uint8Array(1), {}),
    new Proxy(new ArrayBuffer(1), {}),
  ];
  for (const input of refused) {
    for (const [, read] of entries) {
      assert.throws(() => read(asBytes(input)), NOT_BYTES);
    }
  }
});
