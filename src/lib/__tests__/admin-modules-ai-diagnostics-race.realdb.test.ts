/**
 * Real-PostgreSQL proof of the modules save's AI Diagnostics guard (#5243).
 *
 * `admin-modules-api.test.ts` and `ai-diagnostics-disclosure-gate.test.ts` pin
 * the PUT handler against a mocked Prisma: they show the guarded `update` is
 * sent with `where: { id, aiDiagnostics }` and that a P2025 maps to 409, but not
 * that PostgreSQL really re-checks that guard for a save queued behind a
 * concurrent change. This suite drives the REAL `PUT` handler against a real
 * database and forces the interleaving rather than hoping for it: a second
 * connection switches AI Diagnostics off and holds the settings row, the save
 * (which read Diagnostics as on, so needs no acknowledgement) queues on that
 * row, and only then does the holder commit.
 *
 * Expected: the save matches no row, Prisma throws P2025, the route answers
 * 409, and the transaction rolls back with its audit rows: Diagnostics stays
 * off and no `CLUB_MODULE_SETTINGS_UPDATED` or acknowledgement row exists. An
 * unguarded write would have switched Diagnostics back on with no
 * acknowledgement.
 *
 * Mocks only the session guards and the cache flush. Ordinary Vitest runs skip
 * it. Reads ONLY `CONCURRENCY_RACE_DATABASE_URL` (the shared race-database
 * guard), owns its `race-5317-` actor's audit rows, and puts the
 * ClubModuleSettings singleton back as it found it.
 */
import type { PrismaClient } from "@prisma/client";
import type { ModuleSettingsValues } from "@/config/modules";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => ({
    ok: true,
    session: { user: { id: "race-5317-admin" } },
  }),
}));
vi.mock("@/lib/require-recent-auth", () => ({
  requireRecentAuth: async () => ({ ok: true }),
}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: () => undefined,
}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const ADMIN_ID = "race-5317-admin";
const LOCK_POLL_TIMEOUT_MS = 10_000;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let route: typeof import("@/app/api/admin/modules/route");
let modules: typeof import("@/config/modules");
let holderClient: PrismaClient;
let observerClient: PrismaClient;
// The singleton as this suite found it, put back in `afterAll`.
let originalRow: { settings: ModuleSettingsValues; updatedByMemberId: string | null } | null = null;

(RUN ? describe : describe.skip)(
  "modules save racing a concurrent AI Diagnostics switch-off, against real PostgreSQL (#5243)",
  { timeout: 60_000 },
  () => {
    async function deleteOwnedAuditRows() {
      await prisma.auditLog.deleteMany({ where: { actorMemberId: ADMIN_ID } });
    }

    /** Sessions of this database currently waiting on a lock, observer excluded. */
    async function lockWaiters(): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      `;
      return rows[0]?.count ?? 0;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Modules AI Diagnostics save race");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      route = await import("@/app/api/admin/modules/route");
      modules = await import("@/config/modules");

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      holderClient = createSeparateClient("race-5317-holder");
      observerClient = createSeparateClient("race-5317-observer");
      await Promise.all([holderClient.$connect(), observerClient.$connect()]);

      const found = await prisma.clubModuleSettings.findUnique({
        where: { id: modules.CLUB_MODULE_SETTINGS_ID },
        select: modules.CLUB_MODULE_SETTINGS_COLUMN_SELECT,
      });
      originalRow = found
        ? {
            settings: Object.fromEntries(
              modules.MODULE_KEYS.map((key) => [key, found[key]]),
            ) as ModuleSettingsValues,
            updatedByMemberId: found.updatedByMemberId,
          }
        : null;
      await deleteOwnedAuditRows();
      // Diagnostics on and Waitlist off: the save below changes only Waitlist.
      const fixture = { ...modules.DEFAULT_MODULE_SETTINGS, aiDiagnostics: true, waitlist: false };
      await prisma.clubModuleSettings.upsert({
        where: { id: modules.CLUB_MODULE_SETTINGS_ID },
        create: { id: modules.CLUB_MODULE_SETTINGS_ID, ...fixture },
        update: fixture,
        select: modules.CLUB_MODULE_SETTINGS_COLUMN_SELECT,
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteOwnedAuditRows();
      if (originalRow) {
        await prisma.clubModuleSettings.update({
          where: { id: modules.CLUB_MODULE_SETTINGS_ID },
          data: { ...originalRow.settings, updatedByMemberId: originalRow.updatedByMemberId },
          select: modules.CLUB_MODULE_SETTINGS_COLUMN_SELECT,
        });
      } else {
        await prisma.clubModuleSettings.deleteMany({ where: { id: modules.CLUB_MODULE_SETTINGS_ID } });
      }
      await Promise.all([holderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("a save queued behind a committed switch-off matches no row, answers 409, and writes no audit row", async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: () => void;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });

      // The concurrent change: switch Diagnostics off and keep the row until the
      // save has read it as on and queued on it.
      const switchOff = holderClient.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE "ClubModuleSettings"
            SET "aiDiagnostics" = false, "updatedAt" = now()
            WHERE "id" = ${modules.CLUB_MODULE_SETTINGS_ID}
          `;
          held();
          await released;
        },
        { timeout: 30_000 },
      );
      await holding;

      // The save read Diagnostics as on, so it keeps it on and needs no
      // acknowledgement; it changes only Waitlist.
      const settings = { ...modules.DEFAULT_MODULE_SETTINGS, aiDiagnostics: true, waitlist: true };
      const save = route.PUT(
        new Request("http://localhost/api/admin/modules", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ settings }),
        }),
      );

      const started = process.hrtime.bigint();
      while ((await lockWaiters()) < 1) {
        if (realElapsedMs(started) > LOCK_POLL_TIMEOUT_MS) throw new Error("The save never queued on the settings row.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      release();
      await switchOff;

      const response = await save;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error:
          "Someone else changed the module settings while you were saving. Reload the page and try again.",
      });

      // The switch-off stands, and the save's Waitlist change rolled back with it.
      const row = await prisma.clubModuleSettings.findUnique({
        where: { id: modules.CLUB_MODULE_SETTINGS_ID },
        select: modules.CLUB_MODULE_SETTINGS_COLUMN_SELECT,
      });
      expect(row).toMatchObject({ aiDiagnostics: false, waitlist: false });
      expect(row?.updatedByMemberId).not.toBe(ADMIN_ID);

      // No audit row of either kind from the save.
      expect(
        await prisma.auditLog.count({
          where: {
            actorMemberId: ADMIN_ID,
            action: { in: ["CLUB_MODULE_SETTINGS_UPDATED", "AI_DIAGNOSTICS_DISCLOSURE_ACKNOWLEDGED"] },
          },
        }),
      ).toBe(0);
    });
  },
);
