/*
 * producer-conformance adapter — TypeScript. See ../../PROTOCOL.md.
 *
 *   adapter.ts <kind> <arg>   ->  one JSON line on stdout
 *
 * Builds the host value NATIVELY from the recipe, runs the blessed producer, and
 * reports canonical bytes or a classified rejection.
 *
 * A JS string is UTF-16 code units, so `utf16` is directly constructible here:
 * String.fromCharCode(0xd800) yields a lone surrogate. That is why this language
 * needed the fidelity repair, and why the recipe carries CODE UNITS — no string
 * literal could transport an unpaired surrogate through an intermediate parser.
 */

import { encode } from "@bitspark/ontos-codec";
import type { Value } from "@bitspark/ontos-core";
import { encodeBool, encodeInt, encodeText, DataError } from "@bitspark/ontos-data";

/** The host value is unconstructible in this language — not a failure. */
class Unsupported extends Error {}

function nums(arg: string): number[] {
  return arg
    .split(",")
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
}

function buildAndEncode(kind: string, arg: string): Value {
  switch (kind) {
    case "int":
      return encodeInt(BigInt(arg)); // bigint is exact and unbounded
    case "bool":
      if (arg === "true") return encodeBool(true);
      if (arg === "false") return encodeBool(false);
      throw new Unsupported(`bad bool ${JSON.stringify(arg)}`);
    case "text":
      // Scalar values -> well-formed UTF-16 (astral scalars become a surrogate PAIR).
      return encodeText(String.fromCodePoint(...nums(arg)));
    case "utf16":
      // Raw code units — this is how a lone surrogate is constructed.
      return encodeText(String.fromCharCode(...nums(arg)));
    case "bytes":
      throw new Unsupported("a JS string is UTF-16 code units, not arbitrary bytes");
  }
  throw new Unsupported(`unknown kind ${JSON.stringify(kind)}`);
}

function emit(obj: Record<string, string>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function main(argv: string[]): number {
  if (argv.length !== 4) {
    emit({ status: "error", code: "adapter_usage" });
    return 2;
  }
  let value: Value;
  try {
    value = buildAndEncode(argv[2]!, argv[3]!);
  } catch (err) {
    if (err instanceof Unsupported) {
      emit({ status: "unsupported", reason: err.message });
      return 0;
    }
    if (err instanceof DataError) {
      emit({ status: "error", code: err.code });
      return 0;
    }
    // A producer throwing a non-DataError is a §4.1 law-3 violation. Report it
    // verbatim so the harness SEES the leak instead of normalizing it away.
    emit({ status: "error", code: `UNCLASSIFIED:${(err as Error)?.constructor?.name ?? "unknown"}` });
    return 0;
  }
  emit({ status: "ok", hex: Buffer.from(encode(value)).toString("hex") });
  return 0;
}

process.exitCode = main(process.argv);
