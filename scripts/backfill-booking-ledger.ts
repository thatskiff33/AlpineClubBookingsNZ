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
 *   pnpm run booking-ledger:back-post --apply            # post
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

import {
  formatBookingLedgerBackPostReport,
  runBookingLedgerBackPost,
} from "../src/lib/booking-ledger-back-post";
import { getClubFormat } from "../src/lib/club-format-settings";
import { prisma } from "../src/lib/prisma";
import { formatCents } from "../src/lib/utils";

const USAGE = `Usage:
  pnpm run booking-ledger:back-post [--apply] [--booking <id>] [--limit <n>] [--json]

  (default)       Dry run: post and judge each booking in a transaction that is
                  rolled back. Nothing is committed.
  --dry-run       The default, said explicitly.
  --apply         Commit each booking's lines in its own transaction.
  --booking <id>  One booking only.
  --limit <n>     The first n bookings, in id order.
  --json          Print the whole result as JSON after the report.
  --help, -h      Show this help.`;

type Options = { apply: boolean; json: boolean; bookingId: string | null; limit: number | null };

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { apply: false, json: false, bookingId: null, limit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--booking" && argv[index + 1]) options.bookingId = argv[(index += 1)]!;
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
  // The club's currency (#3565), read once, before any booking's locks are taken.
  const format = await getClubFormat();
  const run = await runBookingLedgerBackPost({
    client: prisma,
    apply: options.apply,
    bookingId: options.bookingId,
    limit: options.limit,
  });
  process.stdout.write(`${formatBookingLedgerBackPostReport(run, (cents) => formatCents(cents, format))}\n`);
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
