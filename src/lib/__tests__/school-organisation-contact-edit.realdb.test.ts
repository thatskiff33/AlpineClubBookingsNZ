/**
 * Real-PostgreSQL proof of the officer's school contact correction (#5245).
 *
 * The edit is one transaction under the organisation's Xero contact key with a
 * guarded claim on the `updatedAt` the officer loaded. Mocks cannot show that
 * two saves of one loaded version leave exactly one behind, nor that the queued
 * Xero row lands in the same transaction and survives the active-row index, so
 * this runs the real service against a real database:
 *
 *   - a save writes both fields and one audit row with the old and new values,
 *     and a school with no Xero contact queues nothing;
 *   - with a contact, one PENDING contact-details row anchored on the school;
 *   - empty values clear; identical values write nothing at all;
 *   - a stale version and two saves at once each refuse one save as a 409 and
 *     write nothing for it;
 *   - an archived school is not found;
 *   - a FAILED row goes back to PENDING through the real retry, once.
 *
 * OFF unless `RUN_CONCURRENCY_RACE_TESTS=1`, and only against
 * `CONCURRENCY_RACE_DATABASE_URL` (loopback, port 55442+, the
 * `concurrency_race_1881` marker). It owns and cleans its `race-5245-` rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LABEL = "School contact correction (#5245)";
const ACTOR = "race-5245-officer";
const NO_CONTACT = "race-5245-school-plain";
const WITH_CONTACT = "race-5245-school-linked";
const ARCHIVED = "race-5245-school-archived";
const SCHOOLS = [NO_CONTACT, WITH_CONTACT, ARCHIVED];
const ACTION = "organisation.contact_details.updated";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let edit: typeof import("@/lib/school-organisation-contact-edit");
let retry: typeof import("@/lib/xero-operation-retry");

async function clean() {
  await prisma.auditLog.deleteMany({ where: { targetId: { in: SCHOOLS } } });
  await prisma.xeroSyncOperation.deleteMany({
    where: { localModel: "Organisation", localId: { in: SCHOOLS } },
  });
  await prisma.organisation.deleteMany({ where: { id: { in: SCHOOLS } } });
}

async function version(id: string) {
  const row = await prisma.organisation.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
  return row.updatedAt;
}

(RUN ? describe : describe.skip)(
  "school contact correction — real PostgreSQL (#5245)",
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, LABEL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      edit = await import("@/lib/school-organisation-contact-edit");
      retry = await import("@/lib/xero-operation-retry");
      await prisma.member.upsert({
        where: { id: ACTOR },
        create: {
          id: ACTOR,
          email: "race-5245-officer@example.invalid",
          firstName: "Race",
          lastName: "Officer",
          passwordHash: "not-a-real-password",
        },
        update: {},
      });
    });

    beforeEach(async () => {
      await clean();
      await prisma.organisation.createMany({
        data: [
          { id: NO_CONTACT, name: "Race 5245 Plain School", email: "office@plain.example", phone: "07 111 1111" },
          { id: WITH_CONTACT, name: "Race 5245 Linked School", email: "office@linked.example", phone: "07 222 2222", xeroContactId: "race-5245-xero-contact" },
          { id: ARCHIVED, name: "Race 5245 Archived School", archivedAt: new Date("2026-06-01T00:00:00.000Z") },
        ],
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await clean();
      await prisma.member.deleteMany({ where: { id: ACTOR } });
      await prisma.$disconnect();
    });

    it("saves both fields with one audit row, and queues nothing for a school with no Xero contact", async () => {
      const result = await edit.updateSchoolOrganisationContact({
        organisationId: NO_CONTACT,
        email: "  bursar@plain.example ",
        phone: "07 333 3333",
        expectedUpdatedAt: await version(NO_CONTACT),
        actorId: ACTOR,
      });

      expect(result).toMatchObject({ changed: true, email: "bursar@plain.example", phone: "07 333 3333", queueOperationId: null });
      await expect(prisma.organisation.findUnique({ where: { id: NO_CONTACT }, select: { email: true, phone: true } }))
        .resolves.toEqual({ email: "bursar@plain.example", phone: "07 333 3333" });
      const audits = await prisma.auditLog.findMany({ where: { targetId: NO_CONTACT, action: ACTION } });
      expect(audits).toHaveLength(1);
      expect(audits[0].category).toBe("booking");
      expect(audits[0].metadata).toMatchObject({
        previousEmail: "office@plain.example",
        previousPhone: "07 111 1111",
        email: "bursar@plain.example",
        phone: "07 333 3333",
      });
      await expect(prisma.xeroSyncOperation.count({ where: { localId: NO_CONTACT } })).resolves.toBe(0);
    });

    it("queues one PENDING contact-details row anchored on a school that has a Xero contact", async () => {
      const result = await edit.updateSchoolOrganisationContact({
        organisationId: WITH_CONTACT,
        email: "bursar@linked.example",
        phone: "07 444 4444",
        expectedUpdatedAt: await version(WITH_CONTACT),
        actorId: ACTOR,
      });

      const rows = await prisma.xeroSyncOperation.findMany({ where: { localId: WITH_CONTACT } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.queueOperationId,
        status: "PENDING",
        direction: "OUTBOUND",
        entityType: "CONTACT",
        operationType: "UPDATE",
        localModel: "Organisation",
        queueType: "ORGANISATION_CONTACT_DETAILS",
        requestPayload: { queueType: "ORGANISATION_CONTACT_DETAILS" },
        createdByMemberId: ACTOR,
      });

      // A second correction gets a row of its own rather than sharing the first.
      await edit.updateSchoolOrganisationContact({
        organisationId: WITH_CONTACT,
        email: "accounts@linked.example",
        phone: "07 444 4444",
        expectedUpdatedAt: result.updatedAt,
        actorId: ACTOR,
      });
      await expect(prisma.xeroSyncOperation.count({ where: { localId: WITH_CONTACT } })).resolves.toBe(2);
    });

    it("clears a field left empty, and writes nothing when nothing changed", async () => {
      const cleared = await edit.updateSchoolOrganisationContact({
        organisationId: NO_CONTACT,
        email: "",
        phone: "   ",
        expectedUpdatedAt: await version(NO_CONTACT),
        actorId: ACTOR,
      });
      expect(cleared).toMatchObject({ changed: true, email: null, phone: null });

      const again = await edit.updateSchoolOrganisationContact({
        organisationId: NO_CONTACT,
        email: "",
        phone: "",
        expectedUpdatedAt: cleared.updatedAt,
        actorId: ACTOR,
      });
      expect(again).toMatchObject({ changed: false, updatedAt: cleared.updatedAt });
      await expect(prisma.auditLog.count({ where: { targetId: NO_CONTACT, action: ACTION } })).resolves.toBe(1);
    });

    it("refuses a save over a version something else has moved, writing nothing", async () => {
      const loaded = await version(WITH_CONTACT);
      await edit.updateSchoolOrganisationContact({
        organisationId: WITH_CONTACT,
        email: "first@linked.example",
        phone: "07 222 2222",
        expectedUpdatedAt: loaded,
        actorId: ACTOR,
      });

      await expect(
        edit.updateSchoolOrganisationContact({
          organisationId: WITH_CONTACT,
          email: "second@linked.example",
          phone: "07 999 9999",
          expectedUpdatedAt: loaded,
          actorId: ACTOR,
        }),
      ).rejects.toMatchObject({ name: "SchoolContactEditError", status: 409 });
      await expect(prisma.organisation.findUnique({ where: { id: WITH_CONTACT }, select: { email: true, phone: true } }))
        .resolves.toEqual({ email: "first@linked.example", phone: "07 222 2222" });
      await expect(prisma.auditLog.count({ where: { targetId: WITH_CONTACT, action: ACTION } })).resolves.toBe(1);
      await expect(prisma.xeroSyncOperation.count({ where: { localId: WITH_CONTACT } })).resolves.toBe(1);
    });

    it("lets exactly one of two saves of the same loaded version win", async () => {
      const loaded = await version(WITH_CONTACT);
      const outcomes = await Promise.allSettled(
        ["a@linked.example", "b@linked.example"].map((email) =>
          edit.updateSchoolOrganisationContact({
            organisationId: WITH_CONTACT,
            email,
            phone: "07 222 2222",
            expectedUpdatedAt: loaded,
            actorId: ACTOR,
          }),
        ),
      );

      const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const lost = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      const winner = (won[0] as PromiseFulfilledResult<{ email: string | null }>).value.email;
      await expect(prisma.organisation.findUnique({ where: { id: WITH_CONTACT }, select: { email: true } }))
        .resolves.toEqual({ email: winner });
      await expect(prisma.auditLog.count({ where: { targetId: WITH_CONTACT, action: ACTION } })).resolves.toBe(1);
      await expect(prisma.xeroSyncOperation.count({ where: { localId: WITH_CONTACT } })).resolves.toBe(1);
    });

    it("does not find an archived school", async () => {
      await expect(
        edit.updateSchoolOrganisationContact({
          organisationId: ARCHIVED,
          email: "x@archived.example",
          phone: "",
          expectedUpdatedAt: await version(ARCHIVED),
          actorId: ACTOR,
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(edit.readSchoolOrganisationContact(ARCHIVED)).resolves.toBeNull();
    });

    it("sends a FAILED contact-details row back to the outbox through the real retry, once", async () => {
      const result = await edit.updateSchoolOrganisationContact({
        organisationId: WITH_CONTACT,
        email: "bursar@linked.example",
        phone: "07 444 4444",
        expectedUpdatedAt: await version(WITH_CONTACT),
        actorId: ACTOR,
      });
      const id = result.queueOperationId!;
      await prisma.xeroSyncOperation.update({
        where: { id },
        data: { status: "FAILED", completedAt: new Date(), lastErrorMessage: "Xero said no" },
      });
      await expect(edit.readSchoolOrganisationContact(WITH_CONTACT)).resolves.toMatchObject({
        hasXeroContact: true,
        xeroSync: { operationId: id, status: "FAILED", lastErrorMessage: "Xero said no" },
      });

      const outcomes = await Promise.allSettled([
        retry.retryXeroSyncOperation(id, CLUB_FORMAT_TEST),
        retry.retryXeroSyncOperation(id, CLUB_FORMAT_TEST),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      await expect(prisma.xeroSyncOperation.findUnique({ where: { id } })).resolves.toMatchObject({
        status: "PENDING",
        lastErrorMessage: null,
        requestPayload: { queueType: "ORGANISATION_CONTACT_DETAILS" },
      });
    });
  },
);
