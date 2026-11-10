/**
 * #4744: a later increase records each waiting increase retry it folded in.
 * The repair pass reads that record: while the folding edit's own mint is
 * still open the folded invoice is accounted for, and once that mint has had
 * its chance and queued nothing a person is asked to raise it.
 */
import { describe, expect, it } from "vitest";

import {
  foldedIncreaseInvoiceRepair,
  NO_FOLDED_WAITING_ASKS,
  NO_UNPAID_ASK_SETTLEMENT,
  recordedFoldedIncreaseAsks,
  unpaidAskOffsetHistory,
} from "@/lib/unpaid-ask-offset-marker";

const folded = {
  cents: 5_000,
  invoiceCents: 5_000,
  reissues: { cents: 0, modificationIds: [], invoiceCents: 0 },
  increases: [{
    modificationId: "mod_increase",
    askCents: 5_000,
    invoiceCents: 5_000,
    invoiceUnsure: false,
    hadIssuedXeroInvoice: true as boolean | null,
  }],
};

describe("a folded waiting increase (#4744)", () => {
  it("MUTATION: records the folded retry on the later edit's history, under the keys a previous release already reads", () => {
    expect(unpaidAskOffsetHistory({ ...NO_UNPAID_ASK_SETTLEMENT, foldedWaitingAsks: folded })).toEqual({
      foldedReissuedAskCents: 5_000,
      foldedReissuedAskInvoiceCents: 5_000,
      foldedIncreaseAsks: folded.increases,
    });
    expect(unpaidAskOffsetHistory({ ...NO_UNPAID_ASK_SETTLEMENT, foldedWaitingAsks: NO_FOLDED_WAITING_ASKS })).toEqual({});
  });

  it("MUTATION: a history entry that is not a folded retry is dropped, and the record is unsure rather than billed as a guess", () => {
    const read = recordedFoldedIncreaseAsks({
      foldedIncreaseAsks: [
        folded.increases[0],
        { modificationId: "mod_bad", askCents: "5000" },
      ],
    });
    expect(read.entries).toEqual(folded.increases);
    expect(read.unsure).toBe(true);
    expect(recordedFoldedIncreaseAsks({}).unsure).toBe(false);
  });

  const modifications = [
    { id: "mod_increase", newData: {} },
    { id: "mod_later", newData: unpaidAskOffsetHistory({ ...NO_UNPAID_ASK_SETTLEMENT, foldedWaitingAsks: folded }) },
  ];

  it("MUTATION: the repair pass raises nothing while the folding edit still owes the invoice, and asks a person once that chance has passed", () => {
    expect(foldedIncreaseInvoiceRepair("mod_increase", modifications, new Set(["mod_later"]))).toBe("accounted");
    expect(foldedIncreaseInvoiceRepair("mod_increase", modifications, new Set())).toBe("missing");
    expect(foldedIncreaseInvoiceRepair("mod_later", modifications, new Set())).toBe("none");
  });
});
