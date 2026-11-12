/**
 * Real-PostgreSQL proofs for a passkey (#4617).
 *
 * Two concurrent presents of one challenge: one deleteMany matches the row.
 * Two concurrent counter updates from the same stored value: one updateMany
 * matches. With a credential row present, a member read of the old columns
 * does not throw and twoFactorEnabled is unchanged.
 *
 * OFF unless `RUN_CONCURRENCY_RACE_TESTS=1`, and only against
 * `CONCURRENCY_RACE_DATABASE_URL` (loopback, port 55442+, the
 * `concurrency_race_1881` marker). The race harness imports this file.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LABEL = "WebAuthn passkey (#4617)";
const MEMBER = "race-4617-member";

let prisma: PrismaClient;
let webauthn: typeof import("@/lib/webauthn");

(RUN ? describe : describe.skip)(
  "passkey challenge and counter claims — real PostgreSQL (#4617)",
  { timeout: 20_000 },
  () => {
    const previousAuthUrl = process.env.NEXTAUTH_URL;
    const authUrlWasSet = Object.prototype.hasOwnProperty.call(process.env, "NEXTAUTH_URL");

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, LABEL);
      process.env.DATABASE_URL = RACE_DB_URL;
      process.env.NEXTAUTH_URL ??= "http://localhost:3000";

      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] =
        await Promise.all([import("@prisma/client"), import("@/lib/prisma-adapter")]);
      const url = new URL(RACE_DB_URL);
      url.searchParams.set("connection_limit", "1");
      const own = new URL(url.toString());
      own.searchParams.set("application_name", "race-4617");
      prisma = new SeparatePrismaClient({ adapter: createPrismaPgAdapter(own.toString()) });
      await prisma.$connect();
      webauthn = await import("@/lib/webauthn");

      await prisma.member.deleteMany({ where: { id: MEMBER } });
      await prisma.member.create({
        data: {
          id: MEMBER,
          email: "race-4617@example.invalid",
          firstName: "Race",
          lastName: "Passkey",
          passwordHash: "not-a-real-password",
          twoFactorEnabled: false,
        },
      });
    }, 60_000);

    afterAll(async () => {
      if (authUrlWasSet) process.env.NEXTAUTH_URL = previousAuthUrl;
      else delete process.env.NEXTAUTH_URL;
      if (prisma) {
        await prisma.member.deleteMany({ where: { id: MEMBER } }).catch(() => undefined);
        await prisma.$disconnect().catch(() => undefined);
      }
    });

    it("lets one of two concurrent challenge claims succeed", async () => {
      const challenge = `race-4617-challenge-${Date.now()}`;
      await prisma.webAuthnChallenge.create({
        data: {
          memberId: MEMBER,
          challenge,
          purpose: "authentication",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const [first, second] = await Promise.all([
        webauthn.consumeWebAuthnChallenge(MEMBER, challenge, "authentication"),
        webauthn.consumeWebAuthnChallenge(MEMBER, challenge, "authentication"),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
    });

    it("lets one of two concurrent counter updates succeed", async () => {
      const credential = await prisma.webAuthnCredential.create({
        data: {
          memberId: MEMBER,
          credentialId: `race-4617-cred-${Date.now()}`,
          publicKey: Buffer.from("not-a-key"),
          counter: 1,
        },
      });
      const [first, second] = await Promise.all([
        webauthn.claimWebAuthnCounter({
          id: credential.id,
          verifiedCounter: 1,
          newCounter: 2,
        }),
        webauthn.claimWebAuthnCounter({
          id: credential.id,
          verifiedCounter: 1,
          newCounter: 2,
        }),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      const stored = await prisma.webAuthnCredential.findUnique({
        where: { id: credential.id },
      });
      expect(stored?.counter).toBe(2);
    });

    it("leaves twoFactorEnabled unchanged and a member read does not throw", async () => {
      const before = await prisma.member.findUnique({
        where: { id: MEMBER },
        select: { id: true, twoFactorEnabled: true, email: true },
      });
      expect(before).toEqual({
        id: MEMBER,
        twoFactorEnabled: false,
        email: "race-4617@example.invalid",
      });
      const credentials = await prisma.webAuthnCredential.count({ where: { memberId: MEMBER } });
      expect(credentials).toBeGreaterThan(0);
    });
  },
);
