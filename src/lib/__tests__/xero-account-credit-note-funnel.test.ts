/**
 * #4347 (`INV-ADDPAY-041`): the link funnel (`upsertXeroObjectLink`) judges a
 * payment's account-credit note link before any refund-note logic, so an older
 * live reading never overwrites a stored void. Driven through the funnel on a
 * fake transaction client; the real-database order is pinned in
 * `xero-account-credit-note-stale-live-status.realdb.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { upsertXeroObjectLink } from "@/lib/xero-sync";
import { REFUND_NOTE_SNAPSHOT_AT_KEY as AT } from "@/lib/xero-refund-note-status";

const EARLY = "2026-06-30T11:00:00.000Z";
const LATE = "2026-06-30T12:00:00.000Z";

/** One stored account-credit row; records every write the funnel makes. */
function store(stored: { metadata: unknown; active: boolean }) {
  const raw: Array<{ sql: string; values: unknown[] }> = [];
  const upserts: Array<{ update: Record<string, unknown> }> = [];
  const client = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (raw.push({ sql: strings.join("?"), values }), 1),
    xeroObjectLink: {
      createMany: async () => ({ count: 0 }),
      findUnique: async () => stored,
      updateMany: async () => ({ count: 0 }),
      upsert: async (args: { update: Record<string, unknown> }) => (upserts.push(args), { id: "link_1" }),
      findUniqueOrThrow: async () => ({ id: "link_1" }),
    },
    payment: { findUnique: vi.fn(), updateMany: vi.fn() },
  };
  return { client: client as never, raw, upserts, payment: client.payment };
}

describe("upsertXeroObjectLink for a payment's account-credit note (#4347)", () => {
  it("MUTATION (funnel branch): an older AUTHORISED reading keeps the stored void and active flag, and touches no Payment", async () => {
    const { client, raw, upserts, payment } = store({ metadata: { status: "VOIDED", [AT]: LATE }, active: true });
    await upsertXeroObjectLink(
      {
        localModel: "Payment", localId: "pay_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_1", role: "ACCOUNT_CREDIT_NOTE",
        metadata: { status: "AUTHORISED", [AT]: EARLY }, mergeMetadata: true,
      },
      { store: client },
    );
    expect(raw.some((call) => call.sql.includes("FOR UPDATE"))).toBe(true);
    const merged = raw.find((call) => call.sql.includes("UPDATE \"XeroObjectLink\""));
    expect(merged).toBeDefined();
    const written = merged!.values.filter((value): value is string => typeof value === "string").join(" ");
    expect(written).toContain("VOIDED");
    expect(written).not.toContain("AUTHORISED");
    expect(upserts[0]!.update).toMatchObject({ active: true });
    expect(payment.findUnique).not.toHaveBeenCalled();
    expect(payment.updateMany).not.toHaveBeenCalled();
  });
});
