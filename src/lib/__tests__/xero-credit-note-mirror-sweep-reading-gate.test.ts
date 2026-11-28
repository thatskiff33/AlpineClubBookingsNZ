/**
 * #4347 (`INV-ADDPAY-041`): the nightly mirror sweep, like the inbound
 * reconcile, moves a member's credit on a Xero reading only while the note's
 * account-credit row, as stored under the member's credit lock, still takes it.
 * The sweep's own live read hands the mirror the reading's snapshot
 * (`xeroCreditNoteSnapshotMetadata`) and the mirror re-judges it there through
 * `accountCreditNoteReadingIsCurrent` (refusal "stale-reading", pinned in
 * `xero-account-credit-note-stale-live-status.realdb.test.ts`).
 *
 * Xero, the recheck queue and the mirror's transaction are stubbed; the
 * judgement and the evidence parser are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOTE = "cn_4347";
const EARLY = "2026-06-30T11:00:00.000Z";
const LATE = "2026-06-30T12:00:00.000Z";

const mocks = vi.hoisted(() => ({ getCreditNote: vi.fn(), mirror: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({ xero: { accountingApi: { getCreditNote: mocks.getCreditNote } }, tenantId: "tenant" }),
  callXeroApi: (call: () => unknown) => call(),
}));
vi.mock("@/lib/xero-credit-note-mirror", async (importActual) => ({
  ...((await importActual()) as typeof import("@/lib/xero-credit-note-mirror")),
  dueCreditNoteMirrorRechecks: async () => [NOTE],
  clearCreditNoteMirrorRecheck: async () => undefined,
  mirrorCreditNoteOutsideSpend: mocks.mirror,
}));

import { runCreditNoteMirrorSweep } from "@/lib/xero-credit-note-mirror-sweep";
import { REFUND_NOTE_SNAPSHOT_AT_KEY as AT } from "@/lib/xero-refund-note-status";

/** The transaction the mirror re-judges in, holding the note's stored account-credit rows. */
const tx = (stored: unknown[]) => ({ xeroObjectLink: { findMany: async () => stored.map((metadata) => ({ metadata })) } }) as never;

/** The gate the sweep handed the mirror for one AUTHORISED reading read at EARLY. */
async function gateForEarlyReading() {
  mocks.getCreditNote.mockResolvedValue({
    body: { creditNotes: [{ creditNoteID: NOTE, status: "AUTHORISED", total: 100, remainingCredit: 60, allocations: [], payments: [], updatedDateUTC: EARLY }] },
  });
  mocks.mirror.mockResolvedValue({ acted: false, reason: "stale-reading" });
  // One note a run, so only the recheck is read and the full pass never starts.
  await runCreditNoteMirrorSweep({ db: {} as never, noteLimit: 1 });
  expect(mocks.mirror).toHaveBeenCalledTimes(1);
  const [evidence, deps] = mocks.mirror.mock.calls[0]!;
  expect(evidence).toMatchObject({ creditNoteId: NOTE, status: "AUTHORISED" });
  expect(evidence).not.toHaveProperty("readingMetadata");
  return deps.readingIsCurrent as ((client: never) => Promise<boolean>) | undefined;
}

describe("the mirror sweep's reading gate (#4347)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("MUTATION (sweep gate): a reading a stored void beat is refused under the lock", async () => {
    const gate = await gateForEarlyReading();
    expect(gate).toBeTypeOf("function");
    expect(await gate!(tx([{ status: "VOIDED", [AT]: LATE }]))).toBe(false);
  });

  it("a reading a newer stored live snapshot beat is refused; one no stored row beats is current", async () => {
    const gate = (await gateForEarlyReading())!;
    expect(await gate(tx([{ status: "AUTHORISED", total: 100, remainingCredit: 100, [AT]: LATE }]))).toBe(false);
    expect(await gate(tx([]))).toBe(true);
    expect(await gate(tx([{ status: "AUTHORISED", [AT]: EARLY }]))).toBe(true);
  });
});
