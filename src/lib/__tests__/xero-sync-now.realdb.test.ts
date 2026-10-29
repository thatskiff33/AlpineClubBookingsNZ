/** #4432: real inbound writers; only Xero's client and non-financial config are doubled. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const MEMBER = "race-4432-member";
const CONTACT = "44320000-0000-4000-8000-000000000001";
const NOTE = "race-4432-note";
const LOT = "race-4432-lot";
let db: (typeof import("@/lib/prisma"))["prisma"];
const spies: Array<{ mockRestore(): void }> = [];

(RUN ? describe : describe.skip)("member sync converges like cron, real PostgreSQL", () => {
  const note = {
    creditNoteID: NOTE, contact: { contactID: CONTACT }, status: "AUTHORISED", total: 52.50, remainingCredit: 32.50,
    updatedDateUTC: new Date("2026-06-30T23:00:00.000Z"),
    allocations: [{ allocationID: "race-4432-allocation", invoice: { invoiceID: "outside-app-invoice" }, amount: 20 }],
    payments: [],
  };
  async function clean() {
    await db.rateLimitCounter.deleteMany({ where: { id: `xero-sync-now:${MEMBER}` } });
    await db.auditLog.deleteMany({ where: { action: "XERO_SYNC_NOW", memberId: MEMBER } });
    await db.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: MEMBER } } });
    await db.memberCredit.deleteMany({ where: { memberId: MEMBER } });
    await db.xeroObjectLink.deleteMany({ where: { OR: [{ localModel: "Member", localId: MEMBER }, { xeroObjectId: NOTE }] } });
    await db.xeroContactCache.deleteMany({ where: { contactId: CONTACT } });
    await db.xeroContactGroupMembershipCache.deleteMany({ where: { contactId: CONTACT } });
    await db.member.deleteMany({ where: { id: MEMBER } });
    await db.xeroSyncCursor.deleteMany({ where: { resourceType: "CREDIT_NOTE_OUTSIDE_SPEND_MIRROR", scope: NOTE } });
  }
  async function seed() {
    await clean();
    await db.member.create({ data: { id: MEMBER, email: "race-4432@example.invalid", passwordHash: "test-only", firstName: "Sync", lastName: "Test", ageTier: "ADULT", xeroContactId: CONTACT, joinedDate: new Date("2026-01-01T00:00:00.000Z") } });
    await db.memberCredit.create({ data: { id: LOT, memberId: MEMBER, amountCents: 5250, type: "CANCELLATION_REFUND", description: "Test funding lot", xeroCreditNoteId: NOTE } });
  }
  const amounts = () => db.memberCredit.findMany({ where: { memberId: MEMBER }, select: { amountCents: true, type: true }, orderBy: [{ amountCents: "asc" }, { type: "asc" }] });
  beforeAll(async () => {
    assertSafeRaceDbUrl(DB_URL, "Xero sync now");
    process.env.DATABASE_URL = DB_URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    const api = await import("@/lib/xero-api-client");
    const modules = await import("@/lib/admin-modules");
    const tokens = await import("@/lib/xero-token-store");
    const format = await import("@/lib/club-format-server");
    spies.push(vi.spyOn(api, "getAuthenticatedXeroClient").mockResolvedValue({ tenantId: "test-tenant", xero: { accountingApi: {
      getContact: async () => ({ body: { contacts: [{ contactID: CONTACT, name: "Sync Test", contactGroups: [] }] } }),
      getInvoices: async () => ({ body: { invoices: [] } }),
      getCreditNotes: async () => ({ body: { creditNotes: [note] } }),
      getCreditNote: async () => ({ body: { creditNotes: [note] } }),
    } } } as never));
    spies.push(vi.spyOn(api, "callXeroApi").mockImplementation(((fn: () => Promise<unknown>) => fn()) as never));
    spies.push(vi.spyOn(modules, "isEffectiveModuleEnabled").mockResolvedValue(true));
    spies.push(vi.spyOn(tokens, "isXeroConnected").mockResolvedValue(true));
    spies.push(vi.spyOn(format, "clubFormatValues").mockResolvedValue(CLUB_FORMAT_TEST));
  });
  afterAll(async () => {
    try { if (db) await clean(); } finally { for (const spy of spies) spy.mockRestore(); await db?.$disconnect(); }
  });
  it("mirrors an outside allocation exactly as the scheduled credit-note handler and a second sync changes nothing", async () => {
    const inbound = await import("@/lib/xero-inbound/credit-note");
    const service = await import("@/lib/xero-sync-now");
    await seed();
    await inbound.reconcileXeroCreditNote(NOTE);
    const cronAmounts = await amounts();
    expect(cronAmounts).toEqual([{ amountCents: -2000, type: "ADMIN_ADJUSTMENT" }, { amountCents: 5250, type: "CANCELLATION_REFUND" }]);
    await seed();
    const first = await service.syncMemberFromXeroNow(MEMBER);
    expect(first.changed).toBe(1);
    expect(await amounts()).toEqual(cronAmounts);
    const second = await service.syncMemberFromXeroNow(MEMBER);
    expect(second).toMatchObject({ changed: 0, message: "Already in step." });
    expect(await amounts()).toEqual(cronAmounts);
  });
  it("rate-limits all scopes per officer and persists the Xero audit rows", async () => {
    await seed();
    // Only authentication is doubled here; the limiter and audit writer use PostgreSQL.
    vi.doMock("@/lib/session-guards", () => ({
      requireAdmin: async () => ({ ok: true, session: { user: { id: MEMBER } } }),
    }));
    try {
      const { POST } = await import("@/app/api/admin/xero/sync-now/route");
      const request = () => new Request("http://localhost/api/admin/xero/sync-now", { method: "POST", body: JSON.stringify({ scope: "member", id: MEMBER }) });
      for (let attempt = 0; attempt < 3; attempt++) expect((await POST(request())).status).toBe(200);
      expect((await POST(request())).status).toBe(429);
      expect(await db.auditLog.count({ where: { action: "XERO_SYNC_NOW", memberId: MEMBER, category: "xero" } })).toBe(3);
    } finally { vi.doUnmock("@/lib/session-guards"); }
  });

});
