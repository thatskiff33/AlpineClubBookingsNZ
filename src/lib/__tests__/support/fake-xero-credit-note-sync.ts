/**
 * The REAL inbound credit-note sync (`reconcileXeroCreditNote`) of one Xero
 * reading, against a fake Xero client: no provider call, the reading is what
 * `getCreditNote` returns. For real-PostgreSQL suites that drive the sync's
 * writers (allocation writes, removals, the recount) through the real code
 * rather than a stand-in (#5289 G).
 *
 * Imported lazily inside the call, so a suite that sets `DATABASE_URL` in its
 * `beforeAll` has done so before the sync's modules load.
 */
import { vi } from "vitest";

/** A credit note as Xero's `getCreditNote` returns it, in the fields the sync reads. */
export type FakeXeroCreditNote = {
  creditNoteID: string;
  creditNoteNumber: string;
  status: "AUTHORISED" | "PAID" | "VOIDED" | "DELETED";
  total: number;
  appliedAmount: number;
  remainingCredit: number;
  updatedDateUTC: Date;
  allocations: Array<{ invoice: { invoiceID: string }; amount: number }>;
  payments: unknown[];
};

export async function syncFakeXeroCreditNote(note: FakeXeroCreditNote) {
  const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
  const apiClient = await import("@/lib/xero-api-client");
  const spies = [
    vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-fake-credit-note" } as never),
    vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
  ];
  try {
    const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
    return await reconcileXeroCreditNote(note.creditNoteID);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}
