#!/usr/bin/env -S npx tsx
/**
 * `noUncheckedIndexedAccess` migration ratchet (#2799, programme #2694).
 *
 * `npm run typecheck:nuia`                 fail on new debt, and on stale baseline lines
 * `npm run typecheck:nuia -- --record`     rewrite the baseline from the current tree
 * `npm run typecheck:nuia -- --report`     print the remaining debt by area and by file,
 *                                          then still check — so it can exit 1
 *
 * (PowerShell drops npm's `--` separator; there, run
 * `npx tsx scripts/ci/check-nuia-ratchet.ts --record` directly.)
 *
 * The rule, in one sentence: the diagnostics `noUncheckedIndexedAccess` would
 * raise over `tsconfig.json` are recorded in
 * `scripts/ci/noUncheckedIndexedAccess.baseline.txt`, and that list may shrink
 * but never grow. Why the file is a multiset keyed without positions, and why a
 * STALE line fails the run too, is in `scripts/lib/nuia-ratchet.ts`.
 *
 * This runs the real compiler over the real project — the same `tsc` the
 * `Typecheck` step runs, with one flag added — so it attributes every
 * diagnostic to the flag only because that step is already green. It relies on
 * nothing else: no build, no database, no network. Run `next typegen` first
 * (the `typecheck:nuia` script does) so the project lists the same generated
 * route types CI's does; the diagnostic set is otherwise not comparable.
 *
 * TEMPORARY BY DESIGN. Stage #2802 turns the flag on in `tsconfig.json` itself
 * and deletes this script, the baseline and the `verify` step together; a
 * ratchet whose baseline is empty is a compiler option with extra steps.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BASELINE_PATH,
  compareWithBaseline,
  diagnosticKey,
  inventory,
  parseBaseline,
  parseTscOutput,
  renderBaseline,
  type NormalisedDiagnostic,
} from "../lib/nuia-ratchet";

const CHECK_COMMAND = "npm run typecheck:nuia";

/**
 * tsc's heap crossed Node's default on this project (#2679); the `Typecheck`
 * step raises it to 8 GB, and the same run needs the same ceiling here. Set on
 * the child rather than read from `NODE_OPTIONS`, so the gate does not depend
 * on the caller remembering.
 */
const TSC_HEAP_MB = 8192;

export type TscRun =
  | { ok: true; diagnostics: NormalisedDiagnostic[] }
  | { ok: false; reason: string };

/**
 * Typecheck `tsconfig.json` with the flag forced on and parse the result.
 * `--incremental false` keeps the run from writing a flag-on `.tsbuildinfo`
 * that the plain `Typecheck` would then read (#2693 records how build info has
 * false-passed a config change here before).
 */
export function runTscWithFlag(root: string): TscRun {
  const require = createRequire(import.meta.url);
  const tsc = require.resolve("typescript/lib/tsc.js");
  const result = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${TSC_HEAP_MB}`,
      tsc,
      "--noEmit",
      "-p",
      "tsconfig.json",
      "--noUncheckedIndexedAccess",
      "--incremental",
      "false",
      "--pretty",
      "false",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) return { ok: false, reason: `tsc could not be started: ${result.error.message}` };
  const diagnostics = parseTscOutput(result.stdout);
  // tsc exits 0 with no diagnostics, 1 or 2 with some. Any other status, or a
  // non-zero status that printed nothing parseable, is the compiler failing —
  // an OOM kill, a crash — and a gate that cannot read its evidence must not
  // report a pass it has not earned.
  const status = result.status ?? -1;
  if (status !== 0 && (diagnostics.length === 0 || status > 2)) {
    return {
      ok: false,
      reason:
        `tsc exited ${result.signal ?? status} without a readable diagnostic list.\n` +
        `${result.stderr}${result.stdout}`.trim(),
    };
  }
  return { ok: true, diagnostics };
}

export function renderReport(diagnostics: readonly NormalisedDiagnostic[]): string {
  const inv = inventory(diagnostics);
  const lines = [`${inv.total} noUncheckedIndexedAccess diagnostic(s) remain in tsconfig.json.`, "", "By area:"];
  for (const { area, count } of inv.byArea) lines.push(`  ${String(count).padStart(5)}  ${area}`);
  lines.push("", "By file:");
  for (const { file, count } of inv.byFile) lines.push(`  ${String(count).padStart(5)}  ${file}`);
  return `${lines.join("\n")}\n`;
}

export function run(root: string, argv: readonly string[]): number {
  const record = argv.includes("--record");
  const report = argv.includes("--report");
  const unknown = argv.filter((a) => a !== "--record" && a !== "--report");
  if (unknown.length > 0) {
    process.stderr.write(`Unrecognised argument(s): ${unknown.join(" ")}. Use --record or --report.\n`);
    return 2;
  }

  const tsc = runTscWithFlag(root);
  if (!tsc.ok) {
    process.stderr.write(`noUncheckedIndexedAccess ratchet: UNUSABLE — ${tsc.reason}\n`);
    return 1;
  }
  const keys = tsc.diagnostics.map(diagnosticKey);
  const baselineFile = path.join(root, BASELINE_PATH);

  if (report) process.stdout.write(renderReport(tsc.diagnostics));

  if (record) {
    writeFileSync(baselineFile, renderBaseline(keys));
    process.stdout.write(
      `noUncheckedIndexedAccess ratchet: recorded ${keys.length} diagnostic(s) to ${BASELINE_PATH}.\n`,
    );
    return 0;
  }

  if (!existsSync(baselineFile)) {
    process.stderr.write(
      `noUncheckedIndexedAccess ratchet: UNUSABLE — ${BASELINE_PATH} is missing. ` +
        `Run \`${CHECK_COMMAND} -- --record\` on a tree whose plain typecheck is green.\n`,
    );
    return 1;
  }
  const baseline = parseBaseline(readFileSync(baselineFile, "utf8"));
  const { added, stale } = compareWithBaseline(keys, baseline);

  if (added.length === 0 && stale.length === 0) {
    process.stdout.write(
      `noUncheckedIndexedAccess ratchet: OK — ${keys.length} diagnostic(s), all recorded in ${BASELINE_PATH}; ` +
        `none new, none stale.\n`,
    );
    return 0;
  }

  const out: string[] = [
    `noUncheckedIndexedAccess ratchet: FAILED — ${added.length} new, ${stale.length} stale ` +
      `against ${BASELINE_PATH} (${keys.length} diagnostic(s) now, ${baseline.length} recorded).`,
  ];
  if (added.length > 0) {
    out.push("", "NEW — an indexed lookup this change added or changed is no longer proven present:");
    for (const { key, extra } of added) out.push(`  ${extra > 1 ? `${extra}x ` : ""}${key}`);
    out.push(
      "",
      "  Handle the absent case rather than assert it away: narrow with a guard and act on",
      "  the missing branch the way the domain says, or restructure so the type proves the",
      "  lookup cannot miss (a tuple where the length is fixed, a Record over a closed key",
      "  space). `!`, a cast or `any` is not a fix here (#2694).",
    );
  }
  if (stale.length > 0) {
    out.push("", "STALE — recorded, but the compiler no longer reports it:");
    for (const { key, missing } of stale) out.push(`  ${missing > 1 ? `${missing}x ` : ""}${key}`);
    out.push(
      "",
      "  Good: debt was paid. Re-record so the baseline says what is true —",
      `  \`${CHECK_COMMAND} -- --record\` — and commit the smaller file.`,
    );
  }
  out.push("", 'The rule and the key format: docs/TESTING.md -> "The noUncheckedIndexedAccess ratchet".', "");
  process.stderr.write(out.join("\n"));
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = run(process.cwd(), process.argv.slice(2));
}
