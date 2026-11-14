/**
 * Real-PostgreSQL proofs for the officer two-factor rule (#4618).
 *
 * The grace stamp is one set-if-null `UPDATE … NOW()`: two concurrent
 * refreshes store one stamp and both read it back. A reset of a required
 * officer closes their grace with the reset's own NOW(); a member reset before
 * the rule reached them is still stamped on first exposure. A reset racing an enrolment from a session issued before it
 * leaves no factor: either the enrolment commits first and the reset clears
 * it, or the reset commits first and the enrolment is refused under the same
 * member row lock. No advisory lock (`INV-LOCK-001`).
 *
 * OFF unless `RUN_CONCURRENCY_RACE_TESTS=1`, and only against
 * `CONCURRENCY_RACE_DATABASE_URL` (loopback, port 55442+, the
 * `concurrency_race_1881` marker). The race harness imports this file.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LABEL = "Officer two-factor (#4618)";
const MEMBER = "race-4618-member";
const ADMIN = "race-4618-admin";

const savedAuthSecret: { saved: boolean; value: string | undefined } = {
  saved: false,
  value: undefined,
};

let prisma: PrismaClient;
let officer: typeof import("@/lib/officer-two-factor");
let officerGrace: typeof import("@/lib/officer-two-factor-grace");
let reset: typeof import("@/lib/officer-factor-reset");
let twoFactor: typeof import("@/lib/two-factor");

(RUN ? describe : describe.skip)(
  "officer grace stamp and factor reset — real PostgreSQL (#4618)",
  { timeout: 20_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, LABEL);
      process.env.DATABASE_URL = RACE_DB_URL;
      savedAuthSecret.value = process.env.AUTH_SECRET;
      savedAuthSecret.saved = true;
      process.env.AUTH_SECRET ??= "officer-two-factor-race-secret";

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      const url = new URL(RACE_DB_URL);
      url.searchParams.set("connection_limit", "1");
      url.searchParams.set("application_name", "race-4618");
      prisma = new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      await prisma.$connect();
      officer = await import("@/lib/officer-two-factor");
      officerGrace = await import("@/lib/officer-two-factor-grace");
      reset = await import("@/lib/officer-factor-reset");
      twoFactor = await import("@/lib/two-factor");

      await prisma.member.deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } });
      await prisma.member.createMany({
        data: [
          {
            id: MEMBER,
            email: "race-4618@example.invalid",
            firstName: "Race",
            lastName: "Officer",
            passwordHash: "not-a-real-password",
            // The officer rule only covers someone who can sign in.
            canLogin: true,
          },
          {
            id: ADMIN,
            email: "race-4618-admin@example.invalid",
            firstName: "Race",
            lastName: "Admin",
            passwordHash: "not-a-real-password",
          },
        ],
      });
    }, 60_000);

    beforeEach(async () => {
      await prisma.memberAccessRole.deleteMany({ where: { memberId: MEMBER } });
      await prisma.webAuthnCredential.deleteMany({ where: { memberId: MEMBER } });
      await prisma.twoFactorRecoveryCode.deleteMany({ where: { memberId: MEMBER } });
      await prisma.member.update({
        where: { id: MEMBER },
        data: {
          twoFactorGraceStartedAt: null,
          factorsResetAt: null,
          twoFactorEnabled: false,
          twoFactorMethod: null,
          totpSecret: null,
        },
      });
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.auditLog
          .deleteMany({
            where: { OR: [{ subjectMemberId: MEMBER }, { memberId: { in: [MEMBER, ADMIN] } }] },
          })
          .catch(() => undefined);
        await prisma.member
          .deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } })
          .catch(() => undefined);
        await prisma.$disconnect().catch(() => undefined);
      }
      if (savedAuthSecret.saved) {
        if (savedAuthSecret.value === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = savedAuthSecret.value;
      }
    }, 60_000);

    it("stores one grace stamp when two refreshes race", async () => {
      const [first, second] = await Promise.all([
        officer.stampOfficerGraceStart(MEMBER),
        officer.stampOfficerGraceStart(MEMBER),
      ]);
      expect(first.graceStartedAt).toBeInstanceOf(Date);
      expect(first.graceStartedAt?.getTime()).toBe(second.graceStartedAt?.getTime());

      const again = await officer.stampOfficerGraceStart(MEMBER);
      expect(again.graceStartedAt?.getTime()).toBe(first.graceStartedAt?.getTime());
    });

    it("closes a required officer's grace at the reset", async () => {
      // Full Admin: required whatever a role definition says.
      await prisma.memberAccessRole.create({ data: { memberId: MEMBER, role: "ADMIN" } });
      await reset.clearMemberSecondFactors({
        memberId: MEMBER,
        actor: { kind: "admin", memberId: ADMIN },
      });
      const stamped = await officer.stampOfficerGraceStart(MEMBER);
      expect(stamped.factorsResetAt).toBeInstanceOf(Date);
      expect(stamped.graceStartedAt?.getTime()).toBe(stamped.factorsResetAt?.getTime());
      expect(officerGrace.officerGraceClosedByReset(stamped)).toBe(true);
    });

    it("keeps an earlier grace stamp when a required officer is reset", async () => {
      await prisma.memberAccessRole.create({ data: { memberId: MEMBER, role: "ADMIN" } });
      const first = await officer.stampOfficerGraceStart(MEMBER);
      await reset.clearMemberSecondFactors({
        memberId: MEMBER,
        actor: { kind: "admin", memberId: ADMIN },
      });
      const after = await officer.stampOfficerGraceStart(MEMBER);
      expect(after.graceStartedAt?.getTime()).toBe(first.graceStartedAt?.getTime());
      expect(officerGrace.officerGraceClosedByReset(after)).toBe(true);
    });

    it("still owes first grace to a member reset before the rule reached them", async () => {
      await reset.clearMemberSecondFactors({
        memberId: MEMBER,
        actor: { kind: "admin", memberId: ADMIN },
      });
      const cleared = await prisma.member.findUnique({
        where: { id: MEMBER },
        select: { twoFactorGraceStartedAt: true, factorsResetAt: true },
      });
      expect(cleared?.twoFactorGraceStartedAt).toBeNull();
      expect(cleared?.factorsResetAt).toBeInstanceOf(Date);

      // Promoted later: the first refresh that reaches them stamps grace.
      await prisma.memberAccessRole.create({ data: { memberId: MEMBER, role: "ADMIN" } });
      const stamped = await officer.stampOfficerGraceStart(MEMBER);
      expect(stamped.graceStartedAt).toBeInstanceOf(Date);
      expect(officerGrace.officerGraceClosedByReset(stamped)).toBe(false);
    });

    it("leaves no factor when a reset races an enrolment from an older session", async () => {
      // Any session issued before the reset; fixed, so no clock is read.
      const sessionIssuedAt = new Date("2000-01-01T00:00:00.000Z");
      const [enrolled, cleared] = await Promise.allSettled([
        twoFactor.enrollTwoFactor({
          memberId: MEMBER,
          method: "EMAIL",
          actor: { kind: "member", memberId: MEMBER },
          sessionIssuedAt,
        }),
        reset.clearMemberSecondFactors({
          memberId: MEMBER,
          actor: { kind: "admin", memberId: ADMIN },
        }),
      ]);
      expect(cleared.status).toBe("fulfilled");
      if (enrolled.status === "rejected") {
        expect(enrolled.reason).toBeInstanceOf(reset.FactorResetBlocksEnrolmentError);
      }
      const row = await prisma.member.findUnique({
        where: { id: MEMBER },
        select: { twoFactorEnabled: true, twoFactorMethod: true, factorsResetAt: true },
      });
      expect(row?.twoFactorEnabled).toBe(false);
      expect(row?.twoFactorMethod).toBeNull();
      expect(row?.factorsResetAt).toBeInstanceOf(Date);
      expect(
        await prisma.twoFactorRecoveryCode.count({ where: { memberId: MEMBER } }),
      ).toBe(0);
    });
  },
);
