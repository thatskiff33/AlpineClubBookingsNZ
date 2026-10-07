/**
 * `pnpm run booking-ledger:back-post` — post every historical booking's ledger
 * lines (#3583 PR 2, programme #3527; design `docs/design/booking-ledger.md` §6,
 * §7; the owner's runbook is `docs/MAINTENANCE.md`).
 *
 * Operator-run. DRY RUN BY DEFAULT: each booking is posted and judged inside a
 * transaction that is then rolled back, so the report is exactly what --apply
 * would post and nothing is committed. With --apply each booking commits in its
 * own transaction. Idempotent: a second --apply posts nothing. ZERO provider
 * calls (no Stripe, no Xero, no email).
 *
 *   pnpm run booking-ledger:back-post                    # dry run, every booking
 *   pnpm run booking-ledger:back-post --apply --confirm-database <name>   # post
 *   pnpm run booking-ledger:back-post --booking <id>     # one booking
 *   pnpm run booking-ledger:back-post --limit <n>        # the first n bookings by id
 *   pnpm run booking-ledger:back-post --json             # the whole result as JSON too
 *
 * Every booking it cannot post is LISTED with its reason, and where the census
 * would disagree, with both figures. Exit status 2 when any booking could not be
 * posted, so an operator's script notices.
 */
import "dotenv/config";
import process from "node:process";

import { Prisma } from "@prisma/client";

import { runBookingLedgerBackPost } from "../src/lib/booking-ledger-back-post";
import {
  describeBackPostTarget,
  formatBookingLedgerBackPostOutcome,
  formatBookingLedgerBackPostSummary,
} from "../src/lib/booking-ledger-back-post-report";
import { getClubFormat } from "../src/lib/club-format-settings";
import { prisma } from "../src/lib/prisma";
import { formatCents } from "../src/lib/utils";

const USAGE = `Usage:
  pnpm run booking-ledger:back-post [--apply --confirm-database <name>] [--booking <id> ...] [--limit <n>] [--json]

  (default)       Dry run: post and judge each booking in a transaction that is
                  rolled back. Nothing is committed.
  --dry-run       The default, said explicitly.
  --apply         Commit each booking's lines in its own transaction.
  --confirm-database <name>
                  Required with --apply: the name of the database DATABASE_URL
                  points at. The run refuses if it names any other.
  --booking <id>  This booking only; repeat for several.
  --limit <n>     The first n bookings, in id order.
  --json          Print the whole result as JSON after the report: the run's id
                  and window, and every posted line's id, per booking.
  --help, -h      Show this help.`;

type Options = { apply: boolean; json: boolean; bookingIds: string[]; limit: number | null; confirmDatabase: string | null };

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { apply: false, json: false, bookingIds: [], limit: null, confirmDatabase: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--booking" && argv[index + 1]) options.bookingIds.push(argv[(index += 1)]!);
    else if (arg === "--confirm-database" && argv[index + 1]) options.confirmDatabase = argv[(index += 1)]!;
    else if (arg === "--limit" && argv[index + 1]) {
      const limit = Number(argv[(index += 1)]);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit needs a positive integer");
      options.limit = limit;
    } else throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // Before anything is read: which database, and for --apply, the operator's word that it is the one meant.
  process.stdout.write(`${describeBackPostTarget(process.env.DATABASE_URL ?? "", options)}\n\n`);
  // The club's currency (#3565), read once, before any booking's locks are taken.
  const format = await getClubFormat();
  const money = (cents: number) => formatCents(cents, format);
  const mode = options.apply ? "apply" : "dry-run";
  const run = await runBookingLedgerBackPost({
    client: prisma,
    apply: options.apply,
    bookingIds: options.bookingIds,
    limit: options.limit,
    // Each booking is printed as it finishes, so a long run shows progress.
    onOutcome: (outcome) => {
      for (const line of formatBookingLedgerBackPostOutcome(outcome, mode, money)) process.stdout.write(`${line}\n`);
    },
  });
  process.stdout.write(`\n${formatBookingLedgerBackPostSummary(run)}\n`);
  if (options.json) process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  if (run.totals.cannotPost > 0) process.exitCode = 2;
}

main()
  .catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
      process.stderr.write(
        "A table the back-post writes does not exist in this database: it predates the booking ledger's migrations (#3580). Run `prisma migrate deploy` first.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
