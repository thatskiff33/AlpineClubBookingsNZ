/**
 * The audit-log metadata view annotates every cents key with the amount a
 * person reads, and changes nothing else (#3533).
 */
import { describe, expect, it } from "vitest";
import { formatAuditMetadataJson } from "@/lib/audit-metadata-amounts";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("formatAuditMetadataJson", () => {
  it("annotates a cents key with the amount, keeping the stored number", () => {
    const rendered = formatAuditMetadataJson({ refundAmountCents: 2275 }, CLUB_FORMAT_TEST);
    expect(rendered).toContain('"refundAmountCents": 2275');
    expect(rendered).toContain("$22.75");
  });

  it("annotates nested and array-held cents keys at any depth", () => {
    const rendered = formatAuditMetadataJson({
      strands: [{ guestTotalCents: 8450 }, { guestTotalCents: 10_000 }],
      totals: { nested: { changeFeeCents: 500 } },
    }, CLUB_FORMAT_TEST);
    expect(rendered).toContain("$84.50");
    expect(rendered).toContain("$100.00");
    expect(rendered).toContain("$5.00");
  });

  it("annotates a negative amount and a zero", () => {
    const rendered = formatAuditMetadataJson({ deltaCents: -2275, absorbedCents: 0 }, CLUB_FORMAT_TEST);
    expect(rendered).toContain("-$22.75");
    expect(rendered).toContain("$0.00");
  });

  it("leaves a key that is not cents, and a cents key that is not a whole number, alone", () => {
    const rendered = formatAuditMetadataJson({
      bookingId: "abc",
      nightCount: 3,
      percentCents: 12.5,
      bookingCentsId: 7,
    }, CLUB_FORMAT_TEST);
    expect(rendered).not.toContain("//");
  });

  it("wants the camelCase suffix, not four letters that happen to end a word", () => {
    // Review of #3533, lens A: `/[Cc]ents$/` also matched `descents`.
    const rendered = formatAuditMetadataJson({ descents: 3, accents: 4, recents: 5 }, CLUB_FORMAT_TEST);
    expect(rendered).not.toContain("//");
    // The convention itself, with and without a prefix, still annotates.
    expect(formatAuditMetadataJson({ changeFeeCents: 500 }, CLUB_FORMAT_TEST)).toContain("$5.00");
    expect(formatAuditMetadataJson({ cents: 500 }, CLUB_FORMAT_TEST)).toContain("$5.00");
  });

  it("is a pure annotation: every stored line survives unchanged", () => {
    const metadata = { refundAmountCents: 2275, reason: "CANCELLATION", nights: [1, 2] };
    const raw = JSON.stringify(metadata, null, 2);
    const rendered = formatAuditMetadataJson(metadata, CLUB_FORMAT_TEST);
    for (const line of raw.split("\n")) {
      // Each stored line is still there; an annotated one only gains a suffix.
      expect(rendered).toContain(line.replace(/,$/, ""));
    }
  });

  it("renders nothing for metadata JSON cannot represent", () => {
    expect(formatAuditMetadataJson(undefined, CLUB_FORMAT_TEST)).toBe("");
  });
});
