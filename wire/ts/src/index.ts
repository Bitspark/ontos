/** Optional ontos/wire: immutable data structure with opaque caller-owned leaves. */
import { Node } from '@bitspark/deixis-core';
import { key, PROFILE as POSITION_SPELLING } from '@bitspark/deixis-pos';
import { Atom, Tuple, atom, tuple, type Value as GroundValue } from '@bitspark/ontos-core';

export { POSITION_SPELLING };
export const PROFILE = 'ontos/wire';
export const REVISION = 1;
export type Kind = 'atom' | 'tuple' | 'wire';
export interface Limits { readonly maxDepth: number; readonly maxNodes: number; readonly maxBytes: number }
export const DEFAULT_LIMITS: Limits = Object.freeze({ maxDepth: 256, maxNodes: 100000, maxBytes: 16 << 20 });
export type Code = 'invalid' | 'invalid-limits' | 'exhausted' | 'not-ground';
export class WireValueError extends Error {
  readonly path: readonly number[];
  constructor(readonly code: Code, path: readonly number[], message: string) {
    super(`ontos/wire ${code} at ${JSON.stringify(path)}: ${message}`);
    this.path = Object.freeze([...path]);
  }
}
const fail = (code: Code, path: readonly number[], message: string): never => { throw new WireValueError(code, path, message); };
const CONSTRUCT = Symbol('ontos/wire construction');

/** A closed, immutable payload sum; handles remain opaque and retain identity. */
export class Payload<C> {
  readonly #atom: Atom | undefined;
  readonly #handle: C | undefined;
  constructor(token: symbol, readonly kind: Kind, value?: Atom, handle?: C) {
    if (token !== CONSTRUCT) throw new TypeError('Use the payload constructors');
    this.#atom = value;
    this.#handle = handle;
    Object.freeze(this);
  }
  bytes(): Uint8Array | undefined { return this.#atom?.bytes(); }
  atom(): Atom | undefined { return this.#atom; }
  handle(): C {
    if (this.kind !== 'wire') throw new TypeError('Not a WireCase');
    return this.#handle as C;
  }
}
export const bytesPayload = <C>(value: Atom): Payload<C> => {
  if (!(value instanceof Atom)) return fail('invalid', [], 'expected a ground atom');
  return new Payload<C>(CONSTRUCT, 'atom', value);
};
export const tuplePayload = <C>(): Payload<C> => new Payload<C>(CONSTRUCT, 'tuple');
export const wirePayload = <C>(handle: C): Payload<C> => new Payload<C>(CONSTRUCT, 'wire', undefined, handle);

interface Measures { readonly nodes: number; readonly bytes: number; readonly depth: number }
/** An admitted Deixis representation. No equality, codec, hydration or send method. */
export class Value<C> {
  readonly #node: Node<Payload<C>>;
  readonly #measures: Measures;
  constructor(token: symbol, node: Node<Payload<C>>, measures: Measures) {
    if (token !== CONSTRUCT) throw new TypeError('Use the value constructors or admit');
    this.#node = node;
    this.#measures = Object.freeze({ ...measures });
    Object.freeze(this);
  }
  get kind(): Kind { return this.#node.own().kind; }
  get length(): number { return this.#node.length; }
  bytes(): Uint8Array | undefined { return this.#node.own().bytes(); }
  handle(): C { return this.#node.own().handle(); }
  node(): Node<Payload<C>> { return this.#node; }
  measures(): Measures { return this.#measures; }
  at(index: number, limits: Limits): Value<C> {
    if (this.kind !== 'tuple' || !Number.isSafeInteger(index) || index < 0 || index >= this.length) return fail('invalid', [], 'expected an existing tuple position');
    return admit(this.#node.get(key(BigInt(index)))!, limits);
  }
}
function validate(limits: Limits): void {
  if (!limits || !Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0 || limits.maxDepth > 512 ||
      !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1 || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0) {
    fail('invalid-limits', [], 'invalid depth, node or byte budget');
  }
}
export function checkLimits<C>(value: Value<C>, limits: Limits): void {
  validate(limits);
  if (!(value instanceof Value)) fail('invalid', [], 'expected an admitted value');
  const m = value.measures();
  if (m.nodes > limits.maxNodes || m.bytes > limits.maxBytes || m.depth > limits.maxDepth) fail('exhausted', [], 'conversion budget exceeded');
}
export function newAtom<C>(bytes: Uint8Array, limits: Limits): Value<C> {
  validate(limits);
  if (!(bytes instanceof Uint8Array)) return fail('invalid', [], 'expected bytes');
  if (bytes.length > limits.maxBytes) return fail('exhausted', [], 'atom byte budget exceeded');
  return new Value(CONSTRUCT, Node.compose(bytesPayload<C>(atom(bytes)), []), { nodes: 1, bytes: bytes.length, depth: 0 });
}
/** Constant structural work; even undefined is an opaque C, never authority. */
export function newWire<C>(handle: C): Value<C> {
  return new Value(CONSTRUCT, Node.compose(wirePayload(handle), []), { nodes: 1, bytes: 0, depth: 0 });
}
export function newTuple<C>(items: readonly Value<C>[], limits: Limits): Value<C> {
  validate(limits);
  if (items.length > limits.maxNodes - 1) return fail('exhausted', [], 'tuple node budget exceeded');
  let nodes = 1, bytes = 0, depth = 0;
  for (let i = 0; i < items.length; i++) {
    const child = items[i];
    if (!(child instanceof Value)) return fail('invalid', [i], 'invalid tuple child');
    const m = child.measures(), k = key(BigInt(i)).length;
    if (m.depth >= limits.maxDepth || m.nodes > limits.maxNodes - nodes || k > limits.maxBytes - bytes || m.bytes > limits.maxBytes - bytes - k) return fail('exhausted', [i], 'tuple depth, node or byte budget exceeded');
    nodes += m.nodes; bytes += k + m.bytes; depth = Math.max(depth, m.depth + 1);
  }
  return new Value(CONSTRUCT, Node.compose(tuplePayload<C>(), items.map((v, i) => [key(BigInt(i)), v.node()] as const)), { nodes, bytes, depth });
}

class Budget {
  nodes = 0;
  bytes = 0;
  constructor(readonly limits: Limits) { validate(limits); }
  node(depth: number, children: number, path: readonly number[]): void {
    if (depth > this.limits.maxDepth || (children > 0 && depth >= this.limits.maxDepth) || this.nodes >= this.limits.maxNodes || children > this.limits.maxNodes - this.nodes - 1) fail('exhausted', path, 'node or depth budget exceeded');
    this.nodes++;
  }
  take(bytes: number, path: readonly number[]): void {
    if (bytes > this.limits.maxBytes - this.bytes) fail('exhausted', path, 'atom/key byte budget exceeded');
    this.bytes += bytes;
  }
}
const nodeLength = Object.getOwnPropertyDescriptor(Node.prototype, 'length')!.get!;
/** Exact admission copies structure and never calls a foreign tree interface. */
export function admit<C>(node: Node<Payload<C>>, limits: Limits): Value<C> {
  const budget = new Budget(limits);
  const visit = (n: Node<Payload<C>>, depth: number, path: readonly number[]): Value<C> => {
    if (!(n instanceof Node)) return fail('invalid', path, 'expected a native deixis node');
    let count: number, payload: Payload<C>;
    try { count = nodeLength.call(n) as number; payload = Node.prototype.own.call(n) as Payload<C>; }
    catch { return fail('invalid', path, 'expected a native deixis node'); }
    budget.node(depth, count, path);
    if (!(payload instanceof Payload)) return fail('invalid', path, 'expected a closed profile payload');
    if (payload.kind !== 'tuple') {
      if (count !== 0) return fail('invalid', path, 'payload leaf has children');
      if (payload.kind === 'wire') return newWire(payload.handle());
      const a = payload.atom()!;
      budget.take(a.length, path);
      return newAtom(a.bytes(), limits);
    }
    // Charge all immediate keys before allocating a child collection.
    for (let i = 0; i < count; i++) budget.take(key(BigInt(i)).length, path);
    const children: Value<C>[] = [];
    for (let i = 0; i < count; i++) {
      const child = Node.prototype.get.call(n, key(BigInt(i))) as Node<Payload<C>> | undefined;
      if (child === undefined) return fail('invalid', [...path, i], 'child keys are not exactly dense canonical positions');
      children.push(visit(child, depth + 1, [...path, i]));
    }
    return newTuple(children, limits);
  };
  return visit(node, 0, []);
}
/** Ground embedding preserves exact bytes, positions and empty alternatives. */
export function embed<C>(value: GroundValue, limits: Limits): Value<C> {
  const budget = new Budget(limits);
  const visit = (v: GroundValue, depth: number, path: readonly number[]): Value<C> => {
    if (v instanceof Atom) {
      budget.node(depth, 0, path); budget.take(v.length, path);
      return newAtom(v.bytes(), limits);
    }
    if (!(v instanceof Tuple)) return fail('invalid', path, 'expected a ground Atom or Tuple');
    budget.node(depth, v.length, path);
    for (let i = 0; i < v.length; i++) budget.take(key(BigInt(i)).length, path);
    const children: Value<C>[] = [];
    for (let i = 0; i < v.length; i++) children.push(visit(v.at(i)!, depth + 1, [...path, i]));
    return newTuple(children, limits);
  };
  return visit(value, 0, []);
}
/** Recovery is exact for wire-free values; it does not replace handles by references. */
export function recover<C>(value: Value<C>, limits: Limits): GroundValue {
  checkLimits(value, limits);
  const visit = (node: Node<Payload<C>>, path: readonly number[]): GroundValue => {
    const p = node.own();
    if (p.kind === 'atom') return p.atom()!;
    if (p.kind === 'wire') return fail('not-ground', path, 'live capability has no pure ground recovery');
    const children: GroundValue[] = [];
    for (let i = 0; i < node.length; i++) children.push(visit(node.get(key(BigInt(i)))!, [...path, i]));
    return tuple(children);
  };
  return visit(value.node(), []);
}
