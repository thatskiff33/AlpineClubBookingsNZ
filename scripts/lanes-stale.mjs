#!/usr/bin/env node
/** Read-only reservation report. No GitHub writes or automatic release. */

import { isMainModule } from "./lib/is-main-module.mjs";
import { STALE_HOURS, collectReservations, staleReservations } from "./lib/lane-reservations.mjs";

// The parsing, stale rule and GitHub reads live in `lib/lane-reservations.mjs`,
// shared with the status board (#4464); re-exported for this tool's own suite.
export { collectReservations, staleReservations };

async function main() {
  const repo = process.argv[2] ?? "thatskiff33/AlpineClubBookingsNZ";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || process.argv.length > 3) {
    throw new Error("Usage: pnpm run lanes:stale [owner/repo]");
  }
  const stale = staleReservations(await collectReservations(repo), Date.now());
  console.log(`Stale reservations (>${STALE_HOURS} hours). Report only; check the thread, then post a RELEASE: on each (#4452).`);
  for (const row of stale) {
    console.log(`\n${row.kind} #${row.number} ${row.url}\nHolder: ${row.holder}\nLast activity: ${row.lastActivity}${row.pushWarning ? `\n${row.pushWarning}` : ""}\nAction: ${row.action}`);
  }
  if (!stale.length) console.log("No stale reservations.");
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
