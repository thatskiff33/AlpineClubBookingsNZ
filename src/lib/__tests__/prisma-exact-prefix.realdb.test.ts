/**
 * Real-PostgreSQL proof for #4146: a key-prefix lookup built from an id matches
 * only its own rows.
 *
 * Prisma sends `startsWith` as SQL `LIKE 'prefix%'` and does not escape the
 * prefix, so a `_` in it matches any one character. The fixtures hold ids that
 * differ only where the other's prefix has a `_`. Two lookups are driven
 * through their production functions (the duplicate-capture adjudication and
 * the group hand-back fragment); the Xero retire is inline in a larger writer,
 * so its fragment is run on the same column. The search and force-sync sites
 * are pinned by their unit tests and `prisma-exact-prefix-census.test.ts`, not
 * here. The CONTRAST case pins the premise: if Prisma ever
 * starts escaping `startsWith` itself, `exactPrefix` would double-escape and
 * match nothing, and that case fails first.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL that `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so hosted CI reaches it, and it cleans its
 * own `race-4146-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4146-member";
const LODGE_ID = "race-4146-lodge";
// Differ only at the position where BOOKING_A has a `_`.
const BOOKING_A = "race-4146-b_1";
const BOOKING_B = "race-4146-bx1";
// Starts with BOOKING_A and its `_` delimiter, so even a literal prefix match
// takes its keys: only the lookup's booking scope keeps them apart.
const BOOKING_C = "race-4146-b_1_x";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeExactPrefixRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Exact-prefix proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run exact-prefix proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Exact-prefix proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Exact-prefix proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let exactContains: typeof import("@/lib/prisma-exact-prefix")["exactContains"];
let exactPrefix: typeof import("@/lib/prisma-exact-prefix")["exactPrefix"];
let duplicateCaptureOwnership: typeof import("@/lib/duplicate-capture-ownership");
let keys: typeof import("@/lib/payment-recovery-keys");
let handBack: typeof import("@/lib/group-organiser-hand-back-rules");

async function clean(): Promise<void> {
  const bookingIds = [BOOKING_A, BOOKING_B, BOOKING_C];
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: "race-4146:" } } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: ["race-4146-p_1", "race-4146-px1"] } } });
  await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
  await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
  await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
  await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
}

(RUN ? describe : describe.skip)(
  "a key-prefix lookup built from an id matches only its own rows (#4146)",
  () => {
    const paymentOf: Record<string, string> = {};

    beforeAll(async () => {
      assertSafeExactPrefixRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ exactPrefix, exactContains } = await import("@/lib/prisma-exact-prefix"));
      duplicateCaptureOwnership = await import("@/lib/duplicate-capture-ownership");
      keys = await import("@/lib/payment-recovery-keys");
      handBack = await import("@/lib/group-organiser-hand-back-rules");

      await clean();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: "race-4146@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Prefix",
          lastName: "Proof",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4146 Lodge", slug: "race-4146" } });
      for (const bookingId of [BOOKING_A, BOOKING_B, BOOKING_C]) {
        await prisma.booking.create({
          data: {
            id: bookingId,
            memberId: MEMBER_ID,
            lodgeId: LODGE_ID,
            checkIn: NIGHT,
            checkOut: CHECK_OUT,
            status: "CONFIRMED",
            totalPriceCents: 5000,
            finalPriceCents: 5000,
          },
        });
        const payment = await prisma.payment.create({ data: { bookingId, amountCents: 5000 } });
        paymentOf[bookingId] = payment.id;
      }
    });

    afterAll(async () => {
      if (!prisma) return;
      await clean();
    });

    it("CONTRAST: Prisma's bare startsWith still reads `_` as a wildcard, so exactPrefix is not double-escaping", async () => {
      // B's duplicate-capture row, under A's prefix: a bare `startsWith` takes it.
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_BOOKING_MODIFICATION",
          bookingId: BOOKING_B,
          paymentId: paymentOf[BOOKING_B],
          paymentIntentId: "pi_race_4146_b",
          amountCents: 100,
          idempotencyKey: keys.buildDuplicateCaptureRefundRecoveryIdempotencyKey(BOOKING_B, "pi_race_4146_b"),
        },
      });
      const prefixA = keys.buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(BOOKING_A);
      const bare = await prisma.paymentRecoveryOperation.findMany({
        where: { idempotencyKey: { startsWith: prefixA } },
        select: { bookingId: true },
      });
      expect(bare.map((row) => row.bookingId)).toEqual([BOOKING_B]);
      const exact = await prisma.paymentRecoveryOperation.findMany({
        where: { idempotencyKey: exactPrefix(prefixA) },
        select: { bookingId: true },
      });
      expect(exact).toEqual([]);
      // ...and it still matches its own row.
      const own = await prisma.paymentRecoveryOperation.findMany({
        where: { idempotencyKey: exactPrefix(keys.buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(BOOKING_B)) },
        select: { bookingId: true },
      });
      expect(own.map((row) => row.bookingId)).toEqual([BOOKING_B]);
      await prisma.alertCooldown.createMany({
        data: ["race-4146:%_\\:x", "race-4146:ab\\:y"].map((key) => ({ key, lastAlertedAt: NIGHT })),
      });
      try {
        // A prefix holding `%`, `_` and `\` matches only the key that spells them.
        const literal = await prisma.alertCooldown.findMany({ where: { key: exactPrefix("race-4146:%_\\") }, select: { key: true } });
        expect(literal.map((row) => row.key)).toEqual(["race-4146:%_\\:x"]);
      } finally {
        await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: "race-4146:" } } });
      }
    });

    it("CONTRAST: bare insensitive contains wildcards decoys; exactContains matches literal text (#4190)", async () => {
      const fixtureKeys = [
        "race-4146:before-JoHn_SmItH-after",
        "race-4146:before-JoHnXSmItH-after",
        "race-4146:before-100%-after",
        "race-4146:before-100percent-after",
        "race-4146:before-FoLdEr\\NaMe-after",
        "race-4146:before-FoLdErNaMe-after",
        "race-4146:before-MiX_%\\EnD-after",
        "race-4146:before-MiXabEnD-after",
      ] as const;
      await prisma.alertCooldown.createMany({ data: fixtureKeys.map((key) => ({ key, lastAlertedAt: NIGHT })) });
      try {
        for (const [value, literal, decoy] of [
          ["john_smith", fixtureKeys[0], fixtureKeys[1]],
          ["100%", fixtureKeys[2], fixtureKeys[3]],
          ["folder\\name", fixtureKeys[4], fixtureKeys[5]],
          ["mix_%\\end", fixtureKeys[6], fixtureKeys[7]],
        ] as const) {
          const scope = { key: { in: [literal, decoy] } };
          const bare = await prisma.alertCooldown.findMany({
            where: { AND: [scope, { key: { contains: value, mode: "insensitive" } }] },
            select: { key: true },
          });
          expect(bare.map((row) => row.key)).toContain(decoy);
          const exact = await prisma.alertCooldown.findMany({
            where: { AND: [scope, { key: exactContains(value, "insensitive") }] },
            select: { key: true },
          });
          expect(exact.map((row) => row.key)).toEqual([literal]);
          // Omitting mode must retain case sensitivity (URL/path reference checks).
          expect(await prisma.alertCooldown.count({
            where: { AND: [scope, { key: exactContains(value) }] },
          })).toBe(value === "100%" ? 1 : 0);
        }
      } finally {
        await prisma.alertCooldown.deleteMany({ where: { key: { in: [...fixtureKeys] } } });
      }
    });

    it("the duplicate-capture adjudication lookup no longer takes another booking's refund row", async () => {
      const recoveryRow = (bookingId: string, idempotencyKey: string) => ({
        type: "REFUND_BOOKING_MODIFICATION" as const,
        bookingId,
        paymentId: paymentOf[bookingId],
        paymentIntentId: "pi_race_4146_x",
        amountCents: 100,
        idempotencyKey,
      });
      // B's row is in place from the contrast case. C's key starts with A's
      // prefix literally (C's id is A's id plus `_x`), so only the booking scope
      // rules it out. The A row below is no duplicate-capture key; it matches
      // A's prefix only as a LIKE pattern, so the escape rules it out. Since
      // #4211 the lookup also parses each key literally, which would hide a lost
      // escape, so the read itself (its exported `where`) is asserted too.
      await prisma.paymentRecoveryOperation.createMany({
        data: [
          recoveryRow(BOOKING_C, keys.buildDuplicateCaptureRefundRecoveryIdempotencyKey(BOOKING_C, "pi_race_4146_c")),
          recoveryRow(BOOKING_A, "duplicate-capture-race-4146-b-1-not-a-duplicate-capture-key"),
        ],
      });
      const { duplicateCaptureRefundOperationWhere, listDuplicateCaptureRefundIntentIds } = duplicateCaptureOwnership;
      const read = async () =>
        (
          await prisma.paymentRecoveryOperation.findMany({
            where: duplicateCaptureRefundOperationWhere(BOOKING_A),
            select: { idempotencyKey: true },
          })
        ).map((row) => row.idempotencyKey);
      // Premise: the decoy is a LIKE match for A's unescaped prefix.
      expect(
        await prisma.paymentRecoveryOperation.count({
          where: {
            bookingId: BOOKING_A,
            idempotencyKey: { startsWith: keys.buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(BOOKING_A) },
          },
        }),
      ).toBe(1);
      expect(await read()).toEqual([]);
      expect(await listDuplicateCaptureRefundIntentIds({ bookingId: BOOKING_A, store: prisma })).toEqual([]);
      // A's own row is still found, and names its intent.
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_BOOKING_MODIFICATION",
          bookingId: BOOKING_A,
          paymentId: paymentOf[BOOKING_A],
          paymentIntentId: "pi_race_4146_a2",
          amountCents: 100,
          idempotencyKey: keys.buildDuplicateCaptureRefundRecoveryIdempotencyKey(BOOKING_A, "pi_race_4146_a2"),
        },
      });
      expect(await read()).toEqual([keys.buildDuplicateCaptureRefundRecoveryIdempotencyKey(BOOKING_A, "pi_race_4146_a2")]);
      expect(await listDuplicateCaptureRefundIntentIds({ bookingId: BOOKING_A, store: prisma })).toEqual(["pi_race_4146_a2"]);
    });

    it("a group settlement's hand-back tasks exclude another settlement's supplementary task", async () => {
      const settlementA = "race-4146-s_1";
      const settlementB = "race-4146-sx1";
      // B's supplementary task: its key starts with A's `${key}:` prefix under LIKE.
      await prisma.manualRefundTask.create({
        data: {
          bookingId: BOOKING_B,
          reason: "race-4146 supplementary hand-back",
          amountCents: 100,
          kind: "CANCELLED_BOOKING_HAND_BACK",
          occurrenceKey: handBack.groupOrganiserHandBackOccurrenceKey(settlementB, BOOKING_B),
        },
      });
      const bare = await prisma.manualRefundTask.count({
        where: { occurrenceKey: { startsWith: `${handBack.groupOrganiserHandBackOccurrenceKey(settlementA)}:` } },
      });
      expect(bare).toBe(1);
      expect(await prisma.manualRefundTask.count({ where: handBack.groupOrganiserHandBackTasksWhere(settlementA) })).toBe(0);
      expect(await prisma.manualRefundTask.count({ where: handBack.groupOrganiserHandBackTasksWhere(settlementB) })).toBe(1);
    });

    it("a payment's refund-credit-note correlation key excludes another payment's", async () => {
      // The fragment `invoice-paid-effects.ts` retires a pending clearing note with.
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          status: "PENDING",
          localModel: "Payment",
          localId: "race-4146-px1",
          correlationKey: "payment:race-4146-px1:refund-credit-note:1",
        },
      });
      const prefixA = "payment:race-4146-p_1:refund-credit-note:";
      expect(await prisma.xeroSyncOperation.count({ where: { correlationKey: { startsWith: prefixA } } })).toBe(1);
      expect(await prisma.xeroSyncOperation.count({ where: { correlationKey: exactPrefix(prefixA) } })).toBe(0);
    });
  },
);
