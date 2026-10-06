/**
 * THE CI SEED RUN'S DATABASE (#3583 PR 2; design `docs/design/booking-ledger.md`
 * §6 — "It then keeps running — in CI against the seeded database").
 *
 * Seeds a throwaway database with booking histories made by the real writers
 * and stripped of their lines (`support/booking-ledger-history.ts`), and LEAVES
 * them there. The `migration-drift` job's step "Back-post a seeded booking
 * history and require the census gate" then runs the operator commands over it,
 * exactly as the owner's runbook does: census (gate shut), back-post dry run,
 * `--apply`, `--apply` again (posts nothing), the acknowledgement draft for the
 * expected classes, and the census with `--acknowledged --fail-on-gap`.
 *
 * Why not the demo seed: `prisma/demo-seed.ts` writes money rows by hand, many
 * of them states no writer can reach (a paid booking whose nights do not make
 * its price, a captured payment with no transaction row, `e2e-unreconciled-booking`
 * on purpose), so the census rightly disagrees with it and no back-post may
 * paper over that. These histories are what production's writers leave.
 *
 * Runs only when `SEED_BOOKING_LEDGER_HISTORY=1`, against a database the race
 * guard accepts; the race harness does not import it, because it keeps its rows.
 */
import { describe, expect, it } from "vitest";

import { buildBookingLedgerHistories, cleanHistories, HISTORIES, seedHistoryFixtures } from "@/lib/__tests__/support/booking-ledger-history";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.SEED_BOOKING_LEDGER_HISTORY === "1";
const SEED_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const PREFIX = "seed-3583-";

(RUN ? describe : describe.skip)("seed a booking history for the CI back-post and census run (#3583)", () => {
  it("builds every history through the real writers and leaves it without lines", async () => {
    assertSafeRaceDbUrl(SEED_DB_URL, "Booking-ledger history seed");
    process.env.DATABASE_URL = SEED_DB_URL;
    const { prisma } = await import("@/lib/prisma");
    await cleanHistories(prisma, PREFIX);
    await seedHistoryFixtures(prisma, PREFIX);
    const built = await buildBookingLedgerHistories(prisma, PREFIX);
    expect(Object.keys(built)).toEqual([...HISTORIES]);
    await prisma.$disconnect();
  }, 300_000);
});
