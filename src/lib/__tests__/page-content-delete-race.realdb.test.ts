/**
 * Real-PostgreSQL proof of the page-content DELETE race (#3852).
 *
 * `admin-page-content-route.test.ts` pins the handler against a mocked Prisma:
 * it can show that a P2025 is mapped to 404, but not that PostgreSQL really
 * raises one for the loser of two deletes, nor that `DELETE ... RETURNING`
 * hands back the row as a concurrent UPDATE left it. This suite drives the REAL
 * `DELETE` handler against a real database and forces the interleaving rather
 * than hoping for it: a second connection holds the page row, both deletes pass
 * their existence check and queue on it, and only then does the holder commit
 * an edit.
 *
 * Expected: one delete wins and archives the EDITED text; the other gets the
 * dedicated `404 "Page not found"`, rolls back, and writes no audit row.
 *
 * Mocks only the session guard and the cache flush, so it cannot be imported by
 * `concurrency-lock-races.realdb.test.ts` (whose other suites forbid a
 * `vi.mock` leaking into them): it has its OWN ci.yml step, pinned by
 * `review-findings-contracts.test.ts`, like the member-merge race suite.
 * Ordinary Vitest runs skip it. Reads ONLY `CONCURRENCY_RACE_DATABASE_URL`
 * (loopback, port 55442+, name containing `concurrency_race_1881`) and owns and
 * cleans its `race-3852-` fixtures.
 */
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => ({
    ok: true,
    session: { user: { id: "race-3852-admin" } },
  }),
}));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: () => undefined,
}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const ADMIN_ID = "race-3852-admin";
const PAGE_ID = "race-3852-page";
const PAGE_SLUG = "race-3852-page";
const ORIGINAL_HTML = "<p>original text</p>";
const EDITED_HTML = "<p>edited while both deletes were queued</p>";
const LOCK_POLL_TIMEOUT_MS = 10_000;

/** Fail closed: never run against anything but the disposable race database. */
function assertSafeDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Page-content delete race proof needs a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Page-content delete race proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Page-content delete race proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let route: typeof import("@/app/api/admin/page-content/route");
let holderClient: PrismaClient;
let observerClient: PrismaClient;

function deleteRequest() {
  return new NextRequest("http://localhost/api/admin/page-content", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: PAGE_ID }),
  });
}

(RUN ? describe : describe.skip)(
  "page-content DELETE under a concurrent edit and a second delete — real PostgreSQL (#3852)",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.auditLog.deleteMany({ where: { entityType: "PageContent", entityId: PAGE_ID } });
      await prisma.pageContent.deleteMany({ where: { id: PAGE_ID } });
      await prisma.member.deleteMany({ where: { id: ADMIN_ID } });
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
      assertSafeDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      route = await import("@/app/api/admin/page-content/route");

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
      holderClient = createSeparateClient("race-3852-holder");
      observerClient = createSeparateClient("race-3852-observer");
      await Promise.all([holderClient.$connect(), observerClient.$connect()]);

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: ADMIN_ID,
          email: `${ADMIN_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Page",
          lastName: "Delete",
          ageTier: "ADULT",
        },
      });
      await prisma.pageContent.create({
        data: {
          id: PAGE_ID,
          slug: PAGE_SLUG,
          path: `/${PAGE_SLUG}`,
          title: "Race 3852 page",
          contentHtml: ORIGINAL_HTML,
          published: true,
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
      await Promise.all([holderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("archives the row as a concurrent edit left it, and the second delete gets the dedicated 404 with no audit row", async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: () => void;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });

      // The concurrent edit: take the page row, and keep it until both deletes
      // have read the page and queued on it.
      const editor = holderClient.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            UPDATE "PageContent"
            SET "contentHtml" = ${EDITED_HTML}, "updatedAt" = now()
            WHERE "id" = ${PAGE_ID}
          `;
          held();
          await released;
        },
        { timeout: 30_000 },
      );
      await holding;

      const first = route.DELETE(deleteRequest());
      const second = route.DELETE(deleteRequest());

      const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
      while ((await lockWaiters()) < 2) {
        if (Date.now() > deadline) throw new Error("Both deletes never queued on the page row.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      release();
      await editor;

      const responses = await Promise.all([first, second]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 404]);

      const loser = responses.find((response) => response.status === 404)!;
      expect(await loser.json()).toEqual({ error: "Page not found" });

      expect(await prisma.pageContent.findUnique({ where: { id: PAGE_ID } })).toBeNull();

      // Exactly one audit row: the loser rolled back and wrote none.
      const auditRows = await prisma.auditLog.findMany({
        where: { action: "PAGE_CONTENT_DELETED", entityType: "PageContent", entityId: PAGE_ID },
      });
      expect(auditRows).toHaveLength(1);
      const metadata = auditRows[0]!.metadata as {
        before: { contentHtml: string; id: string };
        snapshotComplete: boolean;
      };
      // The row as the delete removed it, not as the pre-transaction read saw it.
      expect(metadata.before.id).toBe(PAGE_ID);
      expect(metadata.before.contentHtml).toBe(EDITED_HTML);
      expect(metadata.snapshotComplete).toBe(true);
    });
  },
);
