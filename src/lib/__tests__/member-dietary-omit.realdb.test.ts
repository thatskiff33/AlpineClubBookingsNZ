/**
 * Real-PostgreSQL proof of the dietary/allergy omission (#2941, `INV-PRIV-022`).
 *
 * Every other dietary test mocks Prisma, so none of them can show that the
 * application client really leaves `Member.dietaryRequirements` out. This suite
 * uses the REAL `@/lib/prisma` client against a real database and asserts the
 * key is ABSENT (not null, absent) from:
 *
 *  1. a top-level read with no select;
 *  2. a nested relation, through both `include` and `select: { rel: true }`;
 *  3. a read inside an interactive transaction;
 *  4. the rows `create` and `update` hand back;
 *
 * and PRESENT through `src/lib/member-dietary.ts`'s explicit select.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL that `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so hosted CI reaches it, and it cleans its
 * own `race-2941-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PARENT_ID = "race-2941-parent";
const CHILD_ID = "race-2941-child";
const VALUE = "Severe peanut allergy";

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeDietaryOmitRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Dietary omit proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run dietary omit proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Dietary omit proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Dietary omit proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let dietary: typeof import("@/lib/member-dietary");

async function clear(): Promise<void> {
  await prisma.memberAccessRole.deleteMany({ where: { memberId: { in: [PARENT_ID, CHILD_ID] } } });
  await prisma.member.deleteMany({ where: { id: CHILD_ID } });
  await prisma.member.deleteMany({ where: { id: PARENT_ID } });
}

function hasKey(row: unknown): boolean {
  return (
    typeof row === "object" &&
    row !== null &&
    Object.prototype.hasOwnProperty.call(row, "dietaryRequirements")
  );
}

(RUN ? describe : describe.skip)(
  "the application client omits dietary/allergy data in PostgreSQL itself (#2941, INV-PRIV-022)",
  () => {
    let created: unknown;

    beforeAll(async () => {
      assertSafeDietaryOmitRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      dietary = await import("@/lib/member-dietary");
      await clear();
      created = await prisma.member.create({
        data: {
          id: PARENT_ID,
          email: "race-2941-parent@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Dietary",
          lastName: "Parent",
          ageTier: "ADULT",
          dietaryRequirements: VALUE,
        },
      });
      await prisma.member.create({
        data: {
          id: CHILD_ID,
          email: "race-2941-child@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Dietary",
          lastName: "Child",
          ageTier: "CHILD",
          parentMemberId: PARENT_ID,
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await clear();
    });

    it("the value really is stored (so absence below is the omission, not an empty row)", async () => {
      const rows = await prisma.$queryRaw<{ value: string | null }[]>`
        SELECT "dietaryRequirements" AS value FROM "Member" WHERE id = ${PARENT_ID}`;
      expect(rows[0]?.value).toBe(VALUE);
    });

    it("a top-level read with no select carries no key", async () => {
      const row = await prisma.member.findUnique({ where: { id: PARENT_ID } });
      expect(row).not.toBeNull();
      expect(hasKey(row)).toBe(false);
      const many = await prisma.member.findMany({ where: { id: PARENT_ID } });
      expect(many.some(hasKey)).toBe(false);
    });

    it("a nested relation carries no key, through include and through select", async () => {
      const included = await prisma.member.findUnique({
        where: { id: CHILD_ID },
        include: { parent: true },
      });
      expect(included?.parent?.id).toBe(PARENT_ID);
      expect(hasKey(included?.parent)).toBe(false);

      const selected = await prisma.member.findUnique({
        where: { id: CHILD_ID },
        select: { id: true, parent: true },
      });
      expect(selected?.parent?.id).toBe(PARENT_ID);
      expect(hasKey(selected?.parent)).toBe(false);
    });

    it("a read inside an interactive transaction carries no key", async () => {
      const row = await prisma.$transaction(async (tx) =>
        tx.member.findUnique({ where: { id: PARENT_ID } }),
      );
      expect(row?.id).toBe(PARENT_ID);
      expect(hasKey(row)).toBe(false);
    });

    it("the rows create and update hand back carry no key", async () => {
      expect(hasKey(created)).toBe(false);
      const updated = await prisma.member.update({
        where: { id: PARENT_ID },
        data: { lastName: "Parent" },
      });
      expect(updated.id).toBe(PARENT_ID);
      expect(hasKey(updated)).toBe(false);
    });

    it("the one door's explicit select returns the value", async () => {
      await expect(
        dietary.readMemberDietaryRequirements(
          dietary.grantSelfDietaryAccess({ user: { id: PARENT_ID } }),
          PARENT_ID,
        ),
      ).resolves.toBe(VALUE);
      // The membership grant reads the ACTOR's own row and roles from the
      // database; the parent is given a membership-view role for this.
      await prisma.memberAccessRole.create({
        data: { memberId: PARENT_ID, role: "ADMIN_READONLY" },
      });
      const grant = await dietary.grantMembershipAdminDietaryAccess(
        { ok: true, session: { user: { id: PARENT_ID } } },
        "view",
      );
      // The child holds no admin role, so its row grants nothing.
      await expect(
        dietary.grantMembershipAdminDietaryAccess(
          { ok: true, session: { user: { id: CHILD_ID } } },
          "view",
        ),
      ).resolves.toBeNull();
      expect(grant).not.toBeNull();
      const values = await dietary.readMemberDietaryRequirementsByIds(grant!, [
        PARENT_ID,
        CHILD_ID,
      ]);
      expect(values.get(PARENT_ID)).toBe(VALUE);
      expect(values.get(CHILD_ID)).toBeNull();
    });
  },
);
