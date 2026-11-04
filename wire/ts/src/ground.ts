// Private storage observations, captured before any consumer callback. Prototype
// resemblance and shadowed public methods do not establish native membership.
import { Atom, Tuple } from '@bitspark/ontos-core';

const atomLengthGetter = Object.getOwnPropertyDescriptor(Atom.prototype, 'length')!.get!;
const tupleLengthGetter = Object.getOwnPropertyDescriptor(Tuple.prototype, 'length')!.get!;
const bytesLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!;
const bytesMethod = Atom.prototype.bytes;
const atMethod = Tuple.prototype.at;
export const atomLength = (value: Atom): number => atomLengthGetter.call(value) as number;
export const tupleLength = (value: Tuple): number => tupleLengthGetter.call(value) as number;
export const byteLength = (value: Uint8Array): number => bytesLengthGetter.call(value) as number;
export const atomBytes = (value: Atom): Uint8Array => bytesMethod.call(value);
export const tupleAt = (value: Tuple, index: number) => atMethod.call(value, index);
