import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Atom, Tuple, atom, tuple, equals } from '@bitspark/ontos-core';
import { encode } from '@bitspark/ontos-codec';
import { Node } from '@bitspark/deixis-core';
import { key } from '@bitspark/deixis-pos';
import { DEFAULT_LIMITS as limits, Payload, Value, WireValueError, admit, embed, recover, newAtom, newWire, newTuple, bytesPayload, wirePayload, tuplePayload } from '../dist/src/index.js';
import { NativeFactory, NativeTuple, NativeValueError, nativeItems, projectNative, nativeFromValue, type NativeValue } from '../dist/src/native.js';

const a = (s = '') => atom(new TextEncoder().encode(s));
const isCode = (code: string) => (e: unknown) => e instanceof WireValueError && e.code === code;

test('ground round trips preserve exact identity and codec bytes', () => {
  const values = [a(), tuple([]), a('wire'), tuple([a(), tuple([a('x')])])];
  for (const original of values) {
    const value = embed(original, limits);
    const decoded = recover(admit(value.node(), limits), limits);
    assert.ok(equals(original, decoded));
    assert.deepEqual(encode(original), encode(decoded));
  }
  assert.notEqual(embed(a(), limits).kind, embed(tuple([]), limits).kind);
});

test('admission is exact, bounded and never calls arbitrary tree interfaces', () => {
  const leaf = Node.compose(bytesPayload(a('x')), []);
  for (const node of [
    Node.compose(bytesPayload(a('x')), [[key(0n), leaf]]),
    Node.compose(wirePayload({}), [[key(0n), leaf]]),
    Node.compose(tuplePayload(), [[key(1n), leaf]]),
    Node.compose(tuplePayload(), [[new Uint8Array([0, 0, 0]), leaf]]),
  ]) assert.throws(() => admit(node, limits), isCode('invalid'));
  let called = false;
  assert.throws(() => admit({ own() { called = true; } } as never, limits), isCode('invalid'));
  assert.equal(called, false);
  assert.throws(() => newAtom(new Uint8Array(3), { ...limits, maxBytes: 2 }), isCode('exhausted'));
  assert.throws(() => newTuple([newWire({})], { ...limits, maxNodes: 1 }), isCode('exhausted'));
  assert.throws(() => newTuple([newWire({})], { ...limits, maxBytes: 1 }), isCode('exhausted'));
  assert.throws(() => embed(tuple([a()]), { ...limits, maxDepth: 0 }), isCode('exhausted'));
  assert.throws(() => embed(a(), { ...limits, maxDepth: 513 }), isCode('invalid-limits'));
  assert.throws(() => new Value(Symbol(), leaf, { nodes: 1, bytes: 1, depth: 0 }), TypeError);
  assert.throws(() => new Payload(Symbol(), 'tuple'), TypeError);
});

test('capture owns bytes and child observations, retaining opaque handle aliases', () => {
  const bytes = new Uint8Array([1, 2]), handle = { calls: 0 };
  const av = newAtom(bytes, limits), wire = newWire(handle);
  const children = [av, wire, wire], value = newTuple(children, limits);
  bytes[0] = 9; children.length = 0;
  const observed = value.at(0, limits).bytes()!; observed[0] = 8;
  assert.deepEqual(value.at(0, limits).bytes(), new Uint8Array([1, 2]));
  assert.equal(value.at(1, limits).handle(), handle);
  assert.equal(value.at(2, limits).handle(), handle);
  assert.equal(handle.calls, 0);
  assert.throws(() => recover(value, limits), isCode('not-ground'));
  assert.throws(() => recover(value, { ...limits, maxNodes: 1 }), isCode('exhausted'));
  assert.equal(newWire(undefined).kind, 'wire');
});

test('native factory owns structure; leaf policy owns qualification and projection', () => {
  const face = { send() {} }, owner = { face, close() {} };
  let captures = 0;
  const factory = new NativeFactory<typeof face>(value => {
    captures++;
    if (value === owner) return face;
    if (value === face) return face;
    throw new NativeValueError();
  });
  const other = new NativeFactory<typeof face>(() => face);
  const input = [a('data'), owner] as unknown as NativeValue<typeof face>[];
  const value = factory.tuple(input);
  input.length = 0;
  assert.equal(nativeItems(value)![1], face);
  assert.throws(() => factory.capture(other.tuple([face])), NativeValueError);
  assert.throws(() => factory.capture({ send() {} }), NativeValueError);
  assert.throws(() => new NativeTuple(Symbol(), {}, []), TypeError);
  assert.ok(factory.tuple([a()]) instanceof Tuple);
  const projected = projectNative(factory, value, limits);
  assert.equal(projected.at(1, limits).handle(), face);
  const returned = nativeFromValue(factory, projected, limits);
  assert.equal(nativeItems(returned)![1], face);
  let deep = value;
  for (let i = 0; i < 15000; i++) deep = factory.tuple([deep]);
  let shared = value;
  for (let i = 0; i < 40; i++) shared = factory.tuple([shared, shared]);
  const before = captures;
  assert.equal(factory.capture(deep), deep);
  assert.equal(factory.capture(shared), shared);
  assert.equal(captures, before);
  assert.throws(() => projectNative(factory, shared, { ...limits, maxNodes: 50 }), isCode('exhausted'));
  assert.throws(() => projectNative(factory, deep, limits), isCode('exhausted'));
});

test('explicit WireCase never silently collapses to a structural alternative', () => {
  const factory = new NativeFactory<unknown>(value => value);
  assert.throws(() => nativeFromValue(factory, newWire(a()), limits), NativeValueError);
  assert.throws(() => nativeFromValue(factory, newWire(tuple([])), limits), NativeValueError);
  assert.throws(() => new NativeFactory<Atom>(() => a()).capture({}), NativeValueError);
});
