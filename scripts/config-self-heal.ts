#!/usr/bin/env npx tsx
/**
 * Out-of-band config self-heal (epic #1943, child C2).
 *
 * Runs the SAME routine the app runs on boot
 * (`src/lib/config-self-heal.ts` → `runConfigSelfHeal`): for each registered
 * setting, copy its current EFFECTIVE value into its DB row IFF that row is
 * still absent. Create-if-absent, idempotent, and blue/green safe — it never
 * overwrites an admin's configured value.
 *
 * "Current effective value" is no longer always a `config/club.json` value.
 * Most steps do read that file (club identity, Facebook URL, age tiers, lodge
 * capacity) and are gated on it being a valid primary config. Since CT-1
 * (#2989) one step — `club-time-zone` — copies the deployment's current
 * effective timezone from the ENVIRONMENT (`TZ` / `NEXT_PUBLIC_TZ`) instead, so
 * it runs whatever state `config/club.json` is in. That is why a skipped run
 * below still prints results.
 *
 * The default path is automatic (the app self-heals on every boot). Use this
 * script for a deliberate two-phase deploy, to verify a cold DB, or to heal
 * out-of-band without a restart. Requires DATABASE_URL.
 *
 *   npm run config:self-heal
 */
import "dotenv/config";
import process from "node:process";
import { runConfigSelfHeal } from "../src/lib/config-self-heal";
import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("Running config self-heal (create-if-absent boot backfill)...");

  const summary = await runConfigSelfHeal({ db: prisma });

  // Always report the steps that actually ran, skipped run or not. On a skipped
  // run the config/club.json-derived steps contribute nothing here, but a step
  // sourced from the environment (`club-time-zone`) does — and printing the skip
  // notice alone would have told the operator "nothing happened" while a row was
  // in fact written, which is exactly the kind of lie a deploy log must not tell.
  for (const result of summary.results) {
    const detail = result.error ? ` — ${result.error}` : "";
    console.log(`  ${result.name}: ${result.outcome}${detail}`);
  }

  // Fallback guard: the routine refuses to persist a non-primary config. An
  // operator running this out-of-band expects healing, so make the skip loud
  // and exit non-zero — a silent exit-0 no-op would defeat the purpose.
  if (summary.skipped) {
    console.error(
      `Config self-heal SKIPPED the config/club.json-derived steps — effective ` +
        `config provenance is "${summary.provenance}", not a valid primary ` +
        `config/club.json. No value from that file was written to the database. ` +
        `Any step listed above ran because its value comes from the environment, ` +
        `not from config/club.json. Fix config/club.json, then rerun ` +
        `\`npm run config:self-heal\` (the app also self-heals automatically on ` +
        `the next boot once a valid primary config is present).`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Config self-heal complete — healed=${summary.healed}, ` +
      `already-present=${summary.alreadyPresent}, failed=${summary.failed}`,
  );

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    // Collapse a multiline driver error (e.g. Prisma) to a single line so the
    // operator sees a concise cause, not a full stack/panic dump.
    if (error instanceof Error) {
      console.error(`${error.name}: ${error.message.split("\n")[0]}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
