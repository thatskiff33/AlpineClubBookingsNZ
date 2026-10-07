/**
 * Read-only Stage 4 census. Run only against the database explicitly named by
 * DATABASE_URL; it performs one ordered repeatable-read snapshot and writes no
 * booking or money row.
 */
import { censusBookingMoneyReconciliation } from "../src/lib/booking-money-reconciliation-store";
import { readClubTimeZoneOutsideRequest } from "../src/lib/club-time-zone-runtime";
import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  // The per-month lines (#3531 3c) file each creation instant under the club's
  // calendar month (INV-DATE-019); the zone is read once, outside the snapshot.
  const census = await censusBookingMoneyReconciliation(prisma, await readClubTimeZoneOutsideRequest());
  process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
