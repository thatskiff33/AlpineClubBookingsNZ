/**
 * Real-PostgreSQL proof of #5221: a manual credit grant's queued Xero note
 * survives a stale-contact repair followed by a failed retry.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the member and the approved `ADMIN_ADJUSTMENT` credit.
 * - REAL: the approval's enqueue (`enqueueAdminGrantCreditNote`); the outbox
 *   worker (`processQueuedXeroOutboxOperations`) scanning, claiming and routing
 *   the row to `createAdminGrantCreditNote`; the contact-repair retry
 *   (`retryXeroWriteWithContactRepair`), which rewrites the row's stored
 *   request; the outbox's cooldown give-back; and the officer's Retry
 *   (`retryXeroSyncOperation`), which requeues the row with that stored request.
 * - FAKED: Xero itself (each create answers from a script), the contact lookup
 *   and repair (no provider), and the account mapping.
 *
 * Before the fix the repair stored only `{ creditNotes }`. Whichever way the
 * row went back to PENDING, the next pass read no queue type from it, tried to
 * claim it as an invoice, lost the claim, and skipped it on every pass: the
 * credit never got its note and the spend fence waited for good.
 *
 * Ordinary Vitest runs skip the whole file. CI's `realdb-all` job runs it on
 * the disposable race database; it owns and cleans its own `race-5221-` rows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-5221";
const MEMBER_ID = `${P}-member`;
const CREDIT_ID = `${P}-credit`;
const CREDIT_CENTS = 12_000;
const STALE_CONTACT = `${P}-contact-stale`;
const REPAIRED_CONTACT = `${P}-contact-repaired`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

type Outcome = "stale-contact" | "refused" | "cooldown" | "created";

/** A fake Xero that answers each credit-note create from a script, then records the note. */
function fakeXero(script: Outcome[]) {
  const created: Array<{ id: string; contactID: string }> = [];
  const calls: string[] = [];
  const accountingApi = {
    createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ contact: { contactID: string } }> }) => {
      const contactID = body.creditNotes[0]!.contact.contactID;
      calls.push(contactID);
      const outcome = script.shift() ?? "created";
      if (outcome === "stale-contact") {
        throw Object.assign(new Error("A validation exception occurred: Contact could not be found"), { response: { statusCode: 400 } });
      }
      if (outcome === "refused") throw new Error(`${P}: Xero refused the create`);
      if (outcome === "cooldown") {
        const { XeroTransientOutageError } = await import("@/lib/xero-api-client");
        throw new XeroTransientOutageError(60, true);
      }
      const id = `${P}-note-${created.length + 1}`;
      created.push({ id, contactID });
      return { body: { creditNotes: [{ creditNoteID: id, creditNoteNumber: `CN-${created.length}`, status: "AUTHORISED" }] } };
    },
  };
  return { accountingApi, created, calls };
}

(RUN ? describe : describe.skip)(
  "a grant credit note stays dispatchable after a contact repair and a failed retry - real PostgreSQL (#5221)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.xeroObjectLink.deleteMany({ where: { localId: CREDIT_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: CREDIT_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Grant note contact repair (#5221)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await clearRun();
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Grant", lastName: "Repair", role: "USER", ageTier: "ADULT" },
      });
    }, 60_000);

    let xero: ReturnType<typeof fakeXero>;
    async function arrange(script: Outcome[]) {
      xero = fakeXero(script);
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const mappings = await import("@/lib/xero-mappings");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi: xero.accountingApi }, tenantId: `tenant-${P}` } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
      vi.spyOn(mappings, "getResolvedAccountMappingWithFallback").mockResolvedValue({
        code: "610", itemCode: null, codeExplicitlyConfigured: true, sourceKey: "hutFeeRefunds", usingFallback: false,
      } as never);
      // The stored link is stale until the repair relinks the member's live contact.
      let linked = STALE_CONTACT;
      vi.spyOn(contacts, "findOrCreateXeroContact").mockImplementation(async () => linked);
      // The real repair retry, with only its provider-backed contact lookup replaced.
      const realRetry = contacts.retryXeroWriteWithContactRepair;
      vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation(((options: Parameters<typeof realRetry>[0]) =>
        realRetry({ ...options, repairContactLink: async () => (linked = REPAIRED_CONTACT) })) as never);

      await prisma.memberCredit.create({
        data: { id: CREDIT_ID, memberId: MEMBER_ID, amountCents: CREDIT_CENTS, type: "ADMIN_ADJUSTMENT", description: "Double charge held as credit" },
      });
      const { enqueueAdminGrantCreditNote } = await import("@/lib/admin-grant-credit-note");
      await prisma.$transaction((tx) =>
        enqueueAdminGrantCreditNote(tx, { id: CREDIT_ID, amountCents: CREDIT_CENTS, grantAccount: "MEMBER_OWN_MONEY" }),
      );
    }

    beforeEach(clearRun);

    afterEach(async () => {
      vi.restoreAllMocks();
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await clearRun();
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }, 60_000);

    async function runOutbox() {
      const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
      return processQueuedXeroOutboxOperations({ limit: 5 });
    }

    async function grantRow() {
      return prisma.xeroSyncOperation.findFirstOrThrow({
        where: { localId: CREDIT_ID, queueType: "ADMIN_GRANT_CREDIT_NOTE" },
      });
    }

    async function expectStoredRequestStillQueued() {
      const { readAdminGrantCreditNotePayload } = await import("@/lib/admin-grant-credit-note-payload");
      const row = await grantRow();
      expect(readAdminGrantCreditNotePayload(row.requestPayload)).toEqual({
        queueType: "ADMIN_GRANT_CREDIT_NOTE",
        amountCents: CREDIT_CENTS,
        mappingKey: "hutFeeRefunds",
        memberCreditId: CREDIT_ID,
      });
      // The repair still records the note as it was sent, to the repaired contact.
      expect(row.requestPayload).toMatchObject({ creditNotes: [{ contact: { contactID: REPAIRED_CONTACT } }] });
    }

    async function expectNextPassStampsTheCredit() {
      await expect(runOutbox()).resolves.toMatchObject({ processed: 1, succeeded: 1, skipped: 0 });
      expect(xero.created).toEqual([{ id: `${P}-note-1`, contactID: REPAIRED_CONTACT }]);
      expect((await prisma.memberCredit.findUniqueOrThrow({ where: { id: CREDIT_ID } })).xeroCreditNoteId).toBe(`${P}-note-1`);
      expect((await grantRow()).status).toBe("SUCCEEDED");
    }

    it("MUTATION: after a repair and a refused retry, the officer's Retry queues a row the next pass sends", async () => {
      await arrange(["stale-contact", "refused"]);
      await expect(runOutbox()).resolves.toMatchObject({ processed: 1, failed: 1 });
      expect(xero.calls).toEqual([STALE_CONTACT, REPAIRED_CONTACT]);
      expect((await grantRow()).status).toBe("FAILED");
      await expectStoredRequestStillQueued();

      const { retryXeroSyncOperation } = await import("@/lib/xero-operation-retry");
      await expect(retryXeroSyncOperation((await grantRow()).id, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Queued admin grant credit note retry.",
      });
      expect((await grantRow()).status).toBe("PENDING");
      await expectNextPassStampsTheCredit();
    });

    it("MUTATION: after a repair and a cooldown refusal, the row the outbox gives back is sent on the next pass", async () => {
      await arrange(["stale-contact", "cooldown"]);
      await expect(runOutbox()).resolves.toMatchObject({ processed: 1, skipped: 1, cooldownDeferred: 1 });
      expect((await grantRow()).status).toBe("PENDING");
      await expectStoredRequestStillQueued();
      await expectNextPassStampsTheCredit();
    });
  },
);
