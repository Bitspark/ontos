/** Compact native realization of ontos/wire. Runtime policy is supplied explicitly. */
import { Atom, Tuple as GroundTuple, tuple as groundTuple, type Value as GroundValue } from '@bitspark/ontos-core';
import { key } from '@bitspark/deixis-pos';
import { Value, newAtom, newTuple, newWire, checkLimits, WireValueError, type Limits, type Payload } from './index.js';
import type { Node } from '@bitspark/deixis-core';

export type NativeValue<C> = GroundValue | NativeTuple<C> | C;
const CONSTRUCT = Symbol('native tuple');
const owners = new WeakMap<object, object>();
export class NativeTuple<C> {
  readonly kind = 'tuple' as const;
  readonly #items: readonly NativeValue<C>[];
  constructor(token: symbol, owner: object, items: readonly NativeValue<C>[]) {
    if (token !== CONSTRUCT) throw new TypeError('Use a NativeFactory');
    this.#items = Object.freeze([...items]);
    owners.set(this, owner);
    Object.freeze(this);
  }
  get length(): number { return this.#items.length; }
  items(): readonly NativeValue<C>[] { return this.#items; }
  at(index: number): NativeValue<C> | undefined { return this.#items.at(index); }
}
export class NativeValueError extends TypeError {
  constructor() { super('ontos/wire: unqualified native value'); }
}
/**
 * The callback recognizes a leaf and, when needed, projects its owner's send-only
 * face. It must not send, export or test liveness. Structure belongs to Ontos;
 * recognition belongs to the caller. Tuples qualified by another factory fail.
 */
export class NativeFactory<C> {
  readonly #identity = Object.freeze({});
  readonly #capture: (value: unknown) => C;
  constructor(capture: (value: unknown) => C) { this.#capture = capture; Object.freeze(this); }
  capture(value: unknown): NativeValue<C> {
    if (value instanceof Atom || value instanceof GroundTuple) return value;
    if (value instanceof NativeTuple) {
      if (owners.get(value) !== this.#identity) throw new NativeValueError();
      return value as NativeTuple<C>;
    }
    const handle = this.#capture(value);
    if (handle instanceof Atom || handle instanceof GroundTuple || handle instanceof NativeTuple) throw new NativeValueError();
    return handle;
  }
  /** Shallow immutable capture, preserving shared descendants and ground identity. */
  tuple(items: readonly NativeValue<C>[]): NativeValue<C> {
    const captured = items.map(item => this.capture(item));
    return captured.every(item => item instanceof Atom || item instanceof GroundTuple)
      ? groundTuple(captured as GroundValue[])
      : new NativeTuple(CONSTRUCT, this.#identity, captured);
  }
}
/** Observation is structural; it establishes no runtime qualification. */
export function nativeItems<C>(value: NativeValue<C>): readonly NativeValue<C>[] | undefined {
  return value instanceof GroundTuple || value instanceof NativeTuple ? value.items() : undefined;
}
/** Explicit structural projection; these limits never become native send limits. */
export function projectNative<C>(factory: NativeFactory<C>, value: NativeValue<C>, limits: Limits): Value<C> {
  // Validate before consulting the caller's leaf policy.
  checkLimits(newWire(undefined), limits);
  const captured = factory.capture(value);
  let nodes = 0, bytes = 0;
  const visit = (v: NativeValue<C>, depth: number, path: readonly number[]): Value<C> => {
    const count = v instanceof GroundTuple || v instanceof NativeTuple ? v.length : 0;
    if (depth > limits.maxDepth || (count > 0 && depth >= limits.maxDepth) || nodes >= limits.maxNodes || count > limits.maxNodes - nodes - 1) throw new WireValueError('exhausted', path, 'node or depth budget exceeded');
    nodes++;
    if (v instanceof Atom) {
      if (v.length > limits.maxBytes - bytes) throw new WireValueError('exhausted', path, 'atom byte budget exceeded');
      bytes += v.length;
      return newAtom(v.bytes(), limits);
    }
    if (v instanceof GroundTuple || v instanceof NativeTuple) {
      for (let i = 0; i < count; i++) {
        const n = key(BigInt(i)).length;
        if (n > limits.maxBytes - bytes) throw new WireValueError('exhausted', path, 'key byte budget exceeded');
        bytes += n;
      }
      const children: Value<C>[] = [];
      for (let i = 0; i < count; i++) children.push(visit(v.at(i)!, depth + 1, [...path, i]));
      return newTuple(children, limits);
    }
    return newWire(v as C);
  };
  return visit(captured, 0, []);
}
/** Qualifies explicit WireCase leaves under the receiving factory's own policy. */
export function nativeFromValue<C>(factory: NativeFactory<C>, value: Value<C>, limits: Limits): NativeValue<C> {
  checkLimits(value, limits);
  const visit = (node: Node<Payload<C>>): NativeValue<C> => {
    const payload = node.own();
    if (payload.kind === 'atom') return payload.atom()!;
    if (payload.kind === 'wire') {
      const h = payload.handle();
      if (h instanceof Atom || h instanceof GroundTuple || h instanceof NativeTuple) throw new NativeValueError();
      return factory.capture(h);
    }
    const children: NativeValue<C>[] = [];
    for (let i = 0; i < node.length; i++) children.push(visit(node.get(key(BigInt(i)))!));
    return factory.tuple(children);
  };
  return visit(value.node());
}
