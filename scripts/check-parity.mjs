#!/usr/bin/env node
/**
 * check-parity — assert scripts/check.sh and scripts/check.ps1 are the SAME TOOL.
 *
 * The two scripts are hand-written twins: one shell, one PowerShell, offering the same
 * targets so a contributor on either platform runs the same checks. Nothing enforced that.
 * Twice now an edit landed in one and not the other, and the divergence shipped:
 *
 *   ontos-internal#304  the nested-go-module sweep — landed in both, but only because the class was
 *         found by hand; nothing would have caught a one-sided fix
 *   ontos-internal#306  `producer` — a real target in check.sh, ABSENT from check.ps1's dispatch and
 *         from BOTH usage blocks, so a Windows contributor had no local coverage of
 *         ontos-data.md §4.1 and no way to discover the target was missing
 *
 * ontos-internal#306 is the instructive one, and it is why this guard checks DOCUMENTATION and not only
 * code. The two usage texts AGREED with each other perfectly — both omitted `producer`,
 * both described `all` identically — so diffing them by eye showed no defect while the
 * dispatch bodies had already diverged. Agreeing documentation hid a real asymmetry. A
 * guard comparing only the dispatch would have caught ontos-internal#306's code half and left the doc
 * half to rot until the next reader trusted it.
 *
 * So: five properties, each one a way the twins have drifted or could.
 *
 *   1. the two dispatch target lists are equal, in order
 *   2. within a script, dispatch == the usage `{a|b|c}` list == the usage description lines
 *   3. the two `all` compositions are equal, in order
 *   4. within a script, the usage `all` line NAMES exactly what `all` runs, in order
 *   5. every dispatched handler is actually defined in its own script
 *
 * What it deliberately does NOT compare is prose. The `fuzz` description legitimately
 * differs between the two (the PowerShell here-string spells the env var differently), and
 * the `all` line's trailing parenthetical is free text. Only TARGET NAMES are compared, so
 * the guard pins the contract and leaves the wording to the author.
 *
 * Run: `node scripts/check-parity.mjs`. Also run by `scripts/check.{sh,ps1} lint`, and by
 * the `check-script parity` job in .github/workflows/lint.yml — which is what makes the
 * divergence class unrepresentable rather than merely fixed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const problems = [];
const fail = (msg) => problems.push(msg);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const show = (xs) => (xs.length ? xs.join(', ') : '(none)');

/** `do_lint` and `Invoke-Lint` both normalise to `lint`, so the twins are comparable. */
const norm = (h) => h.replace(/^do_/, '').replace(/^Invoke-/, '').toLowerCase();

/** Every handler named in one dispatch arm's body, in call order. */
const handlersIn = (body) => (body.match(/\b(?:do_[a-z_]+|Invoke-[A-Za-z]+)\b/g) ?? []).map(norm);

/**
 * The usage block: its `{a|b|c}` target list and its per-target description lines.
 * Both scripts emit it from a here-doc, terminated by `EOF` (sh) or `"@` (ps1).
 */
function parseUsage(src, file) {
  const m = src.match(/^usage: scripts\/check\.(?:sh|ps1) \{([^}]*)\}\n([\s\S]*?)\n(?:EOF|"@)$/m);
  if (!m) {
    fail(`${file}: no usage block found — expected a line \`usage: scripts/check.* {a|b|c}\` `
       + `inside a here-doc. If the usage block was restructured, teach this parser about the `
       + `new shape rather than deleting the guard.`);
    return null;
  }
  const braced = m[1].split('|').map((s) => s.trim()).filter(Boolean);
  const described = [];
  let allLine = null;
  for (const line of m[2].split('\n')) {
    const d = line.match(/^ {2}([a-z][a-z0-9-]*) {2,}(.+)$/);
    if (!d) continue;
    described.push(d[1]);
    if (d[1] === 'all') allLine = d[2];
  }
  return { braced, described, allLine };
}

/** The dispatch arms: `case`/`esac` in sh, `switch`/`}` in ps1. */
function parseDispatch(src, file, kind) {
  const block = kind === 'sh'
    ? src.match(/^case [\s\S]*?^esac$/m)
    : src.match(/^switch [\s\S]*?^\}$/m);
  if (!block) {
    fail(`${file}: no ${kind === 'sh' ? '`case`/`esac`' : '`switch`'} dispatch block found.`);
    return null;
  }
  const arms = new Map();
  let sawDefault = false;
  for (const line of block[0].split('\n')) {
    const m = kind === 'sh'
      ? line.match(/^\s*([a-z][a-z0-9-]*|\*)\)\s+(.*?)\s*;;\s*$/)
      : line.match(/^\s*(?:"([a-z][a-z0-9-]*)"|(default))\s*\{\s*(.*?)\s*\}\s*$/);
    if (!m) continue;
    const target = kind === 'sh' ? m[1] : (m[1] ?? m[2]);
    if (target === '*' || target === 'default') { sawDefault = true; continue; }
    arms.set(target, handlersIn(kind === 'sh' ? m[2] : m[3]));
  }
  if (!sawDefault) {
    fail(`${file}: dispatch has no default arm — an unknown target would silently do nothing `
       + `instead of printing usage.`);
  }
  return arms;
}

/** The handlers the script actually defines. */
const parseDefs = (src, kind) =>
  [...src.matchAll(kind === 'sh' ? /^(do_[a-z_]+)\(\)/gm : /^function (Invoke-[A-Za-z]+)/gm)]
    .map((m) => norm(m[1]));

// ---------------------------------------------------------------------------

const faces = ['sh', 'ps1'].map((kind) => {
  const file = `scripts/check.${kind}`;
  const src = readFileSync(join(here, `check.${kind}`), 'utf8');
  return {
    file,
    usage: parseUsage(src, file),
    dispatch: parseDispatch(src, file, kind),
    defs: parseDefs(src, kind),
  };
});

if (faces.some((f) => !f.usage || !f.dispatch)) {
  for (const p of problems) console.error(`  x ${p}`);
  console.error('\ncheck-parity: could not parse one of the scripts — refusing to report parity.');
  process.exit(1);
}

for (const f of faces) {
  const targets = [...f.dispatch.keys()];

  // (2) the script documents exactly the targets it dispatches — the ontos-internal#306 doc half.
  if (!eq(targets, f.usage.braced)) {
    fail(`${f.file}: the usage \`{...}\` list disagrees with the dispatch.\n`
       + `      dispatch: ${show(targets)}\n      usage {}: ${show(f.usage.braced)}`);
  }
  if (!eq(targets, f.usage.described)) {
    fail(`${f.file}: the usage description lines disagree with the dispatch.\n`
       + `      dispatch:  ${show(targets)}\n      described: ${show(f.usage.described)}`);
  }

  // (4) the `all` description names exactly what `all` runs — the other ontos-internal#306 doc half.
  const allRuns = f.dispatch.get('all') ?? [];
  if (f.usage.allLine == null) {
    fail(`${f.file}: the usage block has no \`all\` description line.`);
  } else {
    const named = f.usage.allLine
      .split('(')[0].split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!eq(allRuns, named)) {
      fail(`${f.file}: the usage \`all\` line does not name what \`all\` runs.\n`
         + `      all runs:   ${show(allRuns)}\n      all claims: ${show(named)}`);
    }
  }

  // (5) nothing dispatches to a handler that does not exist.
  for (const [target, handlers] of f.dispatch) {
    for (const h of handlers) {
      if (!f.defs.includes(h)) {
        fail(`${f.file}: target \`${target}\` calls an undefined handler \`${h}\`.`);
      }
    }
  }
}

const [sh, ps] = faces;
const shTargets = [...sh.dispatch.keys()];
const psTargets = [...ps.dispatch.keys()];

// (1) the twins offer the same targets — the ontos-internal#306 code half.
if (!eq(shTargets, psTargets)) {
  const only = (a, b) => a.filter((t) => !b.includes(t));
  fail('the two scripts dispatch different targets.\n'
     + `      check.sh:  ${show(shTargets)}\n      check.ps1: ${show(psTargets)}\n`
     + `      only in check.sh:  ${show(only(shTargets, psTargets))}\n`
     + `      only in check.ps1: ${show(only(psTargets, shTargets))}`);
}

// (3) and `all` composes the same way on both platforms.
const shAll = sh.dispatch.get('all') ?? [];
const psAll = ps.dispatch.get('all') ?? [];
if (!eq(shAll, psAll)) {
  fail('`all` runs a different sequence on each platform.\n'
     + `      check.sh:  ${show(shAll)}\n      check.ps1: ${show(psAll)}`);
}

if (problems.length) {
  console.error('check-parity: scripts/check.sh and scripts/check.ps1 have DIVERGED.\n');
  for (const p of problems) console.error(`  x ${p}`);
  console.error(`\n${problems.length} problem(s). These scripts are twins by contract: a contributor`);
  console.error('on either platform must be able to run the same checks, and must be able to');
  console.error('DISCOVER them from the usage text. Fix both scripts, not just the one you run.');
  process.exit(1);
}

console.log(`check-parity: check.sh = check.ps1 — ${shTargets.length} targets (${show(shTargets)})`);
console.log(`              all = ${show(shAll)}; both usage blocks document exactly these.`);
