/**
 * Settle or close every still-OPEN edit review, then re-base frozen headlines
 * (#4343, wave B). The owner runs this. An agent does not, and it is never
 * pointed at production from a lane.
 *
 * OPEN reviews are priced from the guests' stored nights and completed through
 * the ordinary refund, credit or charge path, which charges the change fee
 * when the edit moved check-in and had not already charged one. Anything that
 * cannot be priced is dismissed and listed, and no money moves for it. A
 * review whose guest was removed after it was raised is dismissed the same
 * way: that removal already credited the guest.
 *
 * A frozen headline is a booking that has an edit review, none of them still
 * open, and a total that is not the sum of its guests. The re-base stores
 * that sum. It does not refund, charge, credit or write a Xero document.
 *
 * WHEN IT MAY RUN. `--apply` only from the image that contains this change,
 * after that colour is the only one serving. Never during a mixed-colour
 * window: the other colour can still reopen a review this script is closing.
 * There is no migration. Dry-run against a non-production copy first.
 *
 * A second `--apply` changes nothing.
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     pnpm run bookings:edit-review-cleanup
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     pnpm run bookings:edit-review-cleanup -- --dry-run
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     pnpm run bookings:edit-review-cleanup -- --apply --actor <memberId>
 */
import "dotenv/config";
import process from "node:process";

import { clubToday } from "../src/lib/club-time";
import { clubFormatValues } from "../src/lib/club-format-server";
import { runEditReviewCleanup } from "../src/lib/edit-review-cleanup";
import { formatEditReviewCleanupReport } from "../src/lib/edit-review-cleanup-report";
import { resolveBookingDoorClock } from "../src/lib/member-money/doors";
import { prisma } from "../src/lib/prisma";

function printUsage() {
  console.log(`Usage:
  pnpm run bookings:edit-review-cleanup                         # census (default): counts, no writes
  pnpm run bookings:edit-review-cleanup -- --census             # the same
  pnpm run bookings:edit-review-cleanup -- --dry-run            # the decision for every open review and frozen headline
  pnpm run bookings:edit-review-cleanup -- --apply --actor <id> # perform those decisions

Options:
  --census        Read-only counts. This is the default.
  --dry-run       Print each decision. A headline preview is rolled back, so nothing is kept.
  --apply         Settle open reviews, then re-base frozen headlines. Requires --actor.
  --actor <id>    The member recorded as having done the apply.
  --json          Print the report as JSON after the text.
  --help, -h      Show this help.

Name DATABASE_URL yourself. Do not point it at production until this build is
the only colour serving, and read the dry-run first.
`);
}

function parseArgs(argv: string[]) {
  const options: { mode: "census" | "dry-run" | "apply"; json: boolean; actor: string | null } = {
    mode: "census",
    json: false,
    actor: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--census") {
      options.mode = "census";
      continue;
    }
    if (arg === "--dry-run") {
      options.mode = "dry-run";
      continue;
    }
    if (arg === "--apply") {
      options.mode = "apply";
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--actor") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--actor needs a member id");
      options.actor = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Name the database this run should read.");
  }
  const { zone, journal } = await resolveBookingDoorClock();
  const todayAtClub = clubToday(zone);
  const format = await clubFormatValues();
  const report = await runEditReviewCleanup({
    mode: args.mode,
    actingMemberId: args.actor,
    format,
    zone,
    todayAtClub,
    journal,
  });
  console.log(`Mode: ${report.mode}`);
  console.log(formatEditReviewCleanupReport(report));
  if (args.json) {
    console.log("");
    console.log("---BEGIN EDIT REVIEW CLEANUP JSON---");
    console.log(JSON.stringify(report, null, 2));
    console.log("---END EDIT REVIEW CLEANUP JSON---");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Unknown edit-review cleanup error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
