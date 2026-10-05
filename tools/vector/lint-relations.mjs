#!/usr/bin/env node
// A case NAME that asserts a RELATION must belong to a case KIND that carries the fields
// that relation needs (ontos-internal#288).
//
// WHY A NAME. A vector corpus can advertise coverage it does not have, and a name is the
// cheapest way to do it — free text, costing nothing to write, and it is what a reviewer's
// grep returns. Ranked by cost to create (deixis docs/design/0008 §5.5):
//
//     a half-case   a real case testing one direction   half the law, honestly
//     a `note`      one sentence of prose               the whole law, unbacked
//     a NAME        nothing at all                      the whole law, unbacked, AND it is
//                                                       what answers a coverage grep
//
// The founding instance is ontos-internal#286: `pair_swapped_is_a_different_value` sat in a section
// whose cases carry ONE value, so the comparison it asserts had no field to live in. Law 4
// was therefore tested only by a bespoke pairwise loop in the Rust harness, and the Go face
// — written from the spec alone — never wrote that loop. Every vector replayed green.
//
// FAILURE DIRECTION IS THE SAFE ONE. A false positive is a case that must be renamed or given
// a partner; there is no outcome where this lint hides something. That asymmetry is what makes
// a curated pattern list acceptable here.
//
// WHY CONSTRUCTIONS, NOT WORDS. A bare relation vocabulary (`equal`, `order`, `distinct`, …)
// was measured across all 8 corpora first: 12 hits, ~2 of them real. Words like "order" and
// "distinct" overwhelmingly describe a case's OWN subject (`map_unsorted`) or appear in
// ordinary English prose. A COMPARATIVE CONSTRUCTION is what asserts something about a SECOND
// subject. Re-measured with the list below: 8 hits, 7 in pair-carrying sections, 1 real defect,
// ZERO false positives.
//
// SCOPE, stated so it is not mistaken for more: this reads case NAMES only. The same defect can
// live in a case `note` or in a corpus-level `note` — ontos-internal#286's corpus claimed law 5 in its
// file-level note — and judging prose is not mechanical. Those remain a reader's job.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// A relation asserted in a name needs a second subject to compare against.
const CONSTRUCTIONS = [
  "is_a_different", "is_not_", "_is_distinct", "_are_distinct", "_are_equal",
  "_is_equal", "is_ignored", "_vs_", "_versus_", "_same_as_", "_differs",
  "_collapse", "_is_identical", "_twice_", "_swapped_",
];

// What a comparative construction needs the case to carry.
const REQUIRED = ["left", "right"];

function corpora() {
  const out = [];
  if (existsSync("vectors")) {
    for (const f of readdirSync("vectors")) if (f.endsWith(".json")) out.push(join("vectors", f));
  }
  if (existsSync("projection")) {
    for (const p of readdirSync("projection")) {
      const d = join("projection", p, "vectors");
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) if (f.endsWith(".json")) out.push(join(d, f));
    }
  }
  return out.sort();
}

let scanned = 0, cases = 0;
const findings = [];

for (const file of corpora()) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) continue;
  scanned++;
  for (const [section, value] of Object.entries(doc)) {
    if (!Array.isArray(value)) continue;
    for (const c of value) {
      if (typeof c !== "object" || c === null || typeof c.name !== "string") continue;
      cases++;
      const name = c.name.toLowerCase();
      const hit = CONSTRUCTIONS.find((p) => name.includes(p));
      if (!hit) continue;
      const missing = REQUIRED.filter((f) => !(f in c));
      if (missing.length === 0) continue;
      findings.push({ file, section, name: c.name, hit, missing });
    }
  }
}

// CONTROL: a zero-case run must fail loudly rather than pass vacuously.
if (scanned === 0 || cases === 0) {
  console.error(`lint-relations: scanned ${scanned} files / ${cases} cases — a DEAD READ, not a clean sweep`);
  process.exit(2);
}

for (const f of findings) {
  console.error(
    `${f.file}::${f.section}  "${f.name}"\n` +
    `    the name asserts a RELATION ("${f.hit}") and this case has no second subject:\n` +
    `    missing ${f.missing.map((m) => `\`${m}\``).join(" and ")}.\n` +
    `    Either rename it to describe THIS case's own subject, or move the claim to a\n` +
    `    pair-carrying section (see vectors/identity.json's {name, left, right, equal}).`
  );
}

console.log(`lint-relations: ${cases} cases across ${scanned} corpora, ${findings.length} finding(s)`);
process.exit(findings.length === 0 ? 0 : 1);
