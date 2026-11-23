/**
 * ALP-801 against real PostgreSQL: a member's first read of their email
 * preferences (`GET /api/notifications/preferences`, which the AI app action
 * `get_my_notification_preferences` calls) writes nothing, so two first reads
 * at once both answer 200.
 *
 * The read used to create the member's row when it found none. Two parallel
 * first reads (an AI app firing two calls) both found none, both created, and
 * the loser hit the unique `memberId` and answered 500. The interleaving is
 * forced: each read's lookup waits until both have looked, which is exactly
 * the window the old create lost in. Restore create-on-read and the second
 * read fails here.
 *
 * Ordinary Vitest runs skip the file; CI's real-PostgreSQL job runs it against
 * the guarded loopback race database. It cleans its own namespaced rows.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { raceSession } from "@/lib/__tests__/support/race-session-double";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/** The one shared doubles: the LAST file to register a factory wins, so every realdb file registers these same ones. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);
vi.mock("@/lib/auth", async () => (await import("./support/race-session-double")).raceAuthDouble());

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const MEMBER = "race-alp801-member";
const REALDB_TIMEOUT_MS = 60_000;

let prisma: PrismaClient;
let route: typeof import("@/app/api/notifications/preferences/route");

async function clean(): Promise<void> {
  await prisma.notificationPreference.deleteMany({ where: { memberId: MEMBER } });
  await prisma.member.deleteMany({ where: { id: MEMBER } });
}

describe.skipIf(!RUN)("notification preferences first read, real PostgreSQL", { timeout: REALDB_TIMEOUT_MS }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Notification preferences first read");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    route = await import("@/app/api/notifications/preferences/route");
    await clean();
    await prisma.member.create({
      data: {
        id: MEMBER,
        email: "race-alp801@example.invalid",
        passwordHash: "test-only",
        firstName: "First",
        lastName: "Read",
        ageTier: "ADULT",
        canLogin: true,
        joinedDate: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    raceSession.current = { user: { id: MEMBER } };
  }, REALDB_TIMEOUT_MS);

  afterAll(async () => {
    raceSession.current = null;
    try {
      if (prisma) await clean();
    } finally {
      await prisma?.$disconnect();
    }
  }, REALDB_TIMEOUT_MS);

  it("answers two simultaneous first reads with the defaults and writes no row", async () => {
    // Each lookup returns only once both reads have looked and found no row.
    const realFindUnique = prisma.notificationPreference.findUnique.bind(prisma.notificationPreference);
    let looked = 0;
    let bothLooked!: () => void;
    const barrier = new Promise<void>((resolve) => { bothLooked = resolve; });
    const spy = vi.spyOn(prisma.notificationPreference, "findUnique").mockImplementation((async (args: never) => {
      const row = await realFindUnique(args);
      if (++looked === 2) bothLooked();
      await barrier;
      return row;
    }) as never);

    const read = () => route.GET(new Request("http://localhost/api/notifications/preferences"));
    let outcomes: PromiseSettledResult<Response>[];
    try {
      outcomes = await Promise.allSettled([read(), read()]);
    } finally {
      spy.mockRestore();
    }

    expect(looked).toBe(2);
    const defaults = {
      bookingConfirmation: true,
      bookingReminder: true,
      bookingBumped: true,
      bookingCancelled: true,
      bookingAddedByFamily: true,
      choreRoster: true,
      clubNotices: true,
      marketingEmails: false,
    };
    for (const outcome of outcomes) {
      expect(outcome.status, outcome.status === "rejected" ? String(outcome.reason) : "").toBe("fulfilled");
      const response = (outcome as PromiseFulfilledResult<Response>).value;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(defaults);
    }
    expect(await prisma.notificationPreference.count({ where: { memberId: MEMBER } })).toBe(0);
  });
});
