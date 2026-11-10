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

import { Atom, atom, copyBytes, type BytesLike } from "../src/index.ts";

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
  // A huge sparse array is refused at its first hole, without its length mattering.
  const sparse: number[] = [];
  sparse.length = 2 ** 32 - 1;
  assert.throws(() => copyBytes(sparse), elementOutOfRange("undefined"));
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
  ];
  for (const input of inputs) {
    const copy = copyBytes(input);
    assert.equal(copy.byteOffset, 0);
    assert.equal(copy.buffer.byteLength, copy.length);
    assert.ok(!(copy.buffer instanceof SharedArrayBuffer));
    assert.notEqual(copy.buffer, backing.buffer);
  }
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
