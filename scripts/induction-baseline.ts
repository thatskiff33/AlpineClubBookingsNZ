/**
 * Dry-run-first trusted legacy induction baseline.
 *
 * This script reads and writes only the configured PostgreSQL database. It
 * never calls Stripe, Xero, SES, Sentry or another external provider, and it
 * never prints DATABASE_URL or database credentials.
 */
import "dotenv/config";
import process from "node:process";
import {
  assertDatabaseTargetConfirmation,
  buildBlockedInductionBaselineResult,
  buildPlanMismatchInductionBaselineResult,
  formatInductionBaselineOutput,
  parseInductionBaselineArgs,
  parseSafeDatabaseTarget,
} from "../src/lib/induction-baseline-cli";

function printUsage() {
  console.log(`Usage:
  IFS= read -r ACTOR_MEMBER_ID < /protected/path/actor-member-id
  IFS= read -r BASELINE_DATE < /protected/path/baseline-date
  IFS= read -r PROVENANCE_NOTE < /protected/path/provenance-note

  npm run induction:baseline -- \\
    --actor-member-id "$ACTOR_MEMBER_ID" \\
    --baseline-date "$BASELINE_DATE" \\
    --provenance-note "$PROVENANCE_NOTE"

  IFS= read -r CONFIRM_CLUB_NAME < /protected/path/confirm-club-name
  IFS= read -r CONFIRM_DB_HOST < /protected/path/confirm-db-host
  IFS= read -r CONFIRM_DB_NAME < /protected/path/confirm-db-name
  IFS= read -r CONFIRM_PLAN_DIGEST < /protected/path/confirm-plan-digest

  npm run induction:baseline -- \\
    --apply \\
    --actor-member-id "$ACTOR_MEMBER_ID" \\
    --baseline-date "$BASELINE_DATE" \\
    --provenance-note "$PROVENANCE_NOTE" \\
    --confirm-club-name "$CONFIRM_CLUB_NAME" \\
    --confirm-db-host "$CONFIRM_DB_HOST" \\
    --confirm-db-name "$CONFIRM_DB_NAME" \\
    --confirm-plan-digest "$CONFIRM_PLAN_DIGEST"

Options:
  --dry-run                 Explicit dry run (the default). Never writes.
  --apply                   Apply the reported baseline atomically.
  --actor-member-id <id>    Active, login-enabled Full Admin actor.
  --baseline-date <date>    Trusted historical NZ date-only value (YYYY-MM-DD).
  --provenance-note <note>  Stable source note stored on every created row.
  --confirm-club-name <name>
                            Exact effective DB-first club name (apply only).
  --confirm-db-host <host>  Exact parsed DATABASE_URL host[:port] (apply only).
  --confirm-db-name <name>  Exact parsed DATABASE_URL database name (apply only).
  --confirm-plan-digest <digest>
                            Exact PLAN DIGEST from the reviewed dry run (apply only).
  --json                    Emit safe machine-readable JSON after the report.
  --help, -h                Show this help.

DATABASE_URL is read but is never printed. The report exposes only its parsed
host[:port] and database name for the apply confirmation.

Each protected input file must contain exactly one non-empty,
newline-terminated line; embedded newlines are forbidden. Read values with
IFS= read -r into unexported variables and pass them only as quoted arguments.
Club and provenance text is data: never paste database-backed text into
executable shell syntax. See docs/INDUCTION_BASELINE_RUNBOOK.md for the
fail-closed file-shape and live Compose-image checks.
`);
}

async function main() {
  const args = parseInductionBaselineArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const databaseTarget = parseSafeDatabaseTarget(process.env.DATABASE_URL);
  assertDatabaseTargetConfirmation({
    apply: args.apply,
    target: databaseTarget,
    confirmHost: args.confirmDatabaseHost,
    confirmDatabaseName: args.confirmDatabaseName,
  });

  const [{ prisma }, baseline] = await Promise.all([
    import("../src/lib/prisma"),
    import("../src/lib/induction-baseline"),
  ]);

  try {
    const report = await baseline.runInductionBaseline({
      actorMemberId: args.actorMemberId,
      baselineDate: args.baselineDate,
      provenanceNote: args.provenanceNote,
      databaseTarget,
      apply: args.apply,
      confirmClubName: args.confirmClubName,
      confirmPlanDigest: args.confirmPlanDigest,
    });
    console.log(
      formatInductionBaselineOutput(report, databaseTarget, args.json),
    );
  } catch (error) {
    if (error instanceof baseline.InductionBaselineBlockedError) {
      const blocked = buildBlockedInductionBaselineResult(
        error.report,
        databaseTarget,
        args.json,
      );
      console.log(blocked.output);
      process.exitCode = blocked.exitCode;
      return;
    }
    if (error instanceof baseline.InductionBaselinePlanMismatchError) {
      const mismatch = buildPlanMismatchInductionBaselineResult(
        error.report,
        databaseTarget,
        args.json,
      );
      console.log(mismatch.output);
      process.exitCode = mismatch.exitCode;
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Unknown trusted induction baseline error",
  );
  process.exitCode = 1;
});
