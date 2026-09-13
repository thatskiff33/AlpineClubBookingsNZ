/**
 * STRUCTURED AUDIT DETAIL SURVIVES NOT FITTING (#2704).
 *
 * The contract is one sentence — a value is kept whole, or dropped by name, or
 * (for a string only) clipped behind the visible marker, never partially
 * rendered — and these tests are what hold it.
 *
 * THE CENTRAL TEST IS THE PROPERTY, NOT THE WORKED EXAMPLE. One example proves
 * nothing about the cut offsets the example did not land on, and the offset is
 * the whole hazard: the old rule was correct-looking at almost every position
 * and catastrophic at the ones that fell inside a number. The sweep below cuts
 * a payload at every offset there is and demands that whatever comes back is a
 * byte-identical subset of what the writer wrote.
 *
 * WHAT THE SWEEP DOES AND DOES NOT DISCRIMINATE, measured rather than assumed,
 * because this repository has shipped tests that passed for the wrong reason.
 * It proves the OUTPUT is never wrong — no invented field, no altered value, at
 * any cut. It does NOT catch a wrong boundary SEARCH by catching a wrong VALUE:
 * moving the scan to the wrong token leaves the reconstructed document
 * unbalanced, so the final `JSON.parse` refuses it and every cut returns null.
 * What then fails is the vacuity guard at the end of the sweep — `recoveries`
 * is 0 — and that is the only thing standing between "recovers nothing" and a
 * green run. That is the division of labour worth knowing when changing this
 * code: the parse is the safety net, the `depth === 1` scan is what makes
 * recovery find anything at all, and the scan therefore needs its own named
 * tests, which it has.
 *
 * WHAT THE MUTATION PROBES SHOWED. Each was applied to the source, run,
 * restored, and the tree proved clean with `git diff`. The failing test named
 * here is what actually failed, not what was expected to:
 *
 *  - closing at the last top-level COLON instead of the last comma, so a
 *    half-written value is admitted, fails six — "keeps whole pairs from before
 *    the cut", "does not mistake a comma inside a nested value", "cannot be
 *    handed forged bookkeeping", "renders a legacy clipped payload as fields",
 *    and BOTH sweep variants, each on the vacuity guard rather than on a wrong
 *    value. An earlier version of this list said "not the sweep"; re-measured,
 *    that was wrong, and the paragraph above says why the distinction matters;
 *  - dropping the `depth === 1` test on the comma scan fails exactly one:
 *    "does not mistake a comma inside a nested value for a pair boundary". It
 *    was expected to fail the sweep too and does not, even against a payload
 *    whose last field is a nested object — which is why that limit is written
 *    down above instead of left as an assumption;
 *  - reverting `sanitizeAuditDetails` to the plain text clip fails five:
 *    "stores a payload that still parses, with no fragment of a number in it",
 *    "shortens a long string behind the marker rather than dropping it",
 *    "records the payload's own length", "does not claim truncation when
 *    sanitising made the payload fit", and "narrows, and cannot widen, what a
 *    member's own booking page reads";
 *  - admitting the first pass's fields in KEY order rather than cheapest-first
 *    fails exactly one, and it is the one written for it: "keeps every short
 *    field whatever the length of the long one in front of them";
 *  - dropping `_droppedKeyCount` fails "says how many fields it dropped when it
 *    cannot name them all" and "records the payload's own length";
 *  - sanitising the over-budget `details` payload through `sanitizeAuditMetadata`
 *    again — the double reduction — fails "records the payload's own length,
 *    not an intermediate nobody wrote";
 *  - taking `_truncatedKeys` back out of the reserved set fails two: "cannot be
 *    handed forged bookkeeping" and "filters the sanitiser's own dropped-keys
 *    flag out of the description too";
 *  - removing the reserved-key strip from the recovery fails "cannot be handed
 *    forged bookkeeping". The test it REPLACED, which forged only the recovery
 *    marker, stayed green under this mutation — that is why it was replaced;
 *  - putting the raw clipped blob back in the sentence slot, by re-deriving the
 *    parse inside `getDescription` instead of taking `hasStructuredDetails`,
 *    fails "renders a legacy clipped payload as fields, and keeps the raw
 *    record beside them";
 *  - dropping the reserved-key filter from the description fallback fails "does
 *    not let a bookkeeping key become the officer's description".
 */
import { describe, expect, it } from "vitest";

import {
  buildStructuredAuditLogCreateArgs,
  sanitizeAuditMetadata,
} from "@/lib/audit";
import { readDeclaredMemberText } from "@/lib/audit-member-disclosure";
import {
  AUDIT_TRUNCATED_KEYS_FLAG,
  AUDIT_TRUNCATION_SUFFIX,
  REDUCED_DETAIL_KEYS,
  recoverTruncatedStructuredDetail,
  reduceStructuredDetail,
} from "@/lib/audit-structured-detail";
import { getAuditTimelinePage } from "@/lib/audit-query";
import { buildBookingHistoryItems } from "@/lib/booking-history";

const ACTOR = "officer-1";
const SUBJECT = "member-1";

/**
 * A payload in the shape the real writers use: an identifier, a money figure, a
 * boolean, a nested before/after pair, and one long free value. Every kind this
 * rule treats differently is present, which is what makes the sweep meaningful.
 */
function representativePayload(padding: number): string {
  return JSON.stringify({
    bookingId: "bkg_01HQ8Z",
    amountCents: 1234567,
    confirmed: true,
    before: { status: "PENDING", nights: 2 },
    after: { status: "CONFIRMED", nights: 3 },
    note: `Officer note. ${"detail ".repeat(padding)}end`,
  });
}

/**
 * What the WRITE BOUNDARY actually stores in `details` for this payload.
 *
 * Deliberately not `sanitizeAuditArchiveText`, which is the text rule and stays
 * the text rule: it also sanitises the declared member sentence (#2695) and the
 * retention archive's copy of a stored row, neither of which is a payload. The
 * structural path belongs to the column, so the column's boundary is what these
 * tests exercise.
 */
function storedDetails(details: string): string | undefined {
  return buildStructuredAuditLogCreateArgs({
    action: "booking.review.approve",
    category: "booking",
    actor: { memberId: ACTOR },
    subject: { memberId: SUBJECT },
    details,
  }).data.details as string | undefined;
}

/** One stored row, as the timeline's `select` returns it. */
function rowOf(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    action: "booking.review.approve",
    memberId: ACTOR,
    targetId: SUBJECT,
    details: null,
    ipAddress: "203.0.113.1",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    actorMemberId: ACTOR,
    subjectMemberId: SUBJECT,
    entityType: "Booking",
    entityId: "bkg_01HQ8Z",
    category: "booking",
    severity: "info",
    outcome: "success",
    summary: null,
    metadata: null,
    requestId: "req-1",
    userAgent: "agent",
    retentionClass: "standard",
    ...overrides,
  };
}

async function timelineEntry(
  row: Record<string, unknown>,
  audience: "admin" | "member",
) {
  const db = {
    auditLog: { findMany: async () => [row], count: async () => 1 },
    member: { findMany: async () => [] },
  };
  const page = await getAuditTimelinePage({
    db: db as never,
    where: {},
    page: 1,
    pageSize: 10,
    category: "all",
    audience,
    currentMemberId: audience === "member" ? SUBJECT : undefined,
  });
  const entry = page.data[0];
  if (!entry) throw new Error("the timeline returned no entry to assert on");
  return entry;
}

describe("recovering a character-clipped payload (#2704)", () => {
  /**
   * THE PROPERTY. Cut the payload at every single offset, append the marker the
   * old rule appended, and demand of the recovery that whatever it returns is a
   * byte-identical SUBSET of the original. No approximation, no coercion, no
   * field the writer did not write.
   *
   * This is what "truncation cannot produce misleading structured evidence"
   * means when it is stated as something a machine can check.
   */
  it.each([
    ["a long free value last", representativePayload(3)],
    // A NESTED OBJECT LAST: a second shape rather than a second guard. With the
    // trailing field a string, a wrongly-admitted boundary inside a nested value
    // almost always leaves the outer object unclosed, so the parse throws and
    // the sweep sees a null it is entitled to skip. With a nested object last,
    // closing at an inner comma can instead yield a document that PARSES, which
    // is the only way a sweep could see the class at all.
    //
    // IT DOES NOT ACTUALLY DISCRIMINATE THE `depth === 1` GUARD, and an earlier
    // version of this comment claimed it did — contradicting the measurement in
    // this file's own header, which is the one that is right. Dropping the guard
    // was applied to the source and run: it fails exactly one NAMED test and
    // lowers this sweep's recovery count without ever producing a wrong value,
    // on this payload included. Kept for the coverage of the shape, not for a
    // discrimination it does not have.
    [
      "a nested object last",
      JSON.stringify({
        bookingId: "bkg_01HQ8Z",
        amountCents: 1234567,
        note: "Officer note. detail detail detail",
        before: { status: "PENDING", nights: 2, lodgeId: "lodge_1" },
      }),
    ],
  ])("no cut position can produce a field that disagrees with the payload — %s", (_label, payload) => {
    const original = JSON.parse(payload) as Record<string, unknown>;
    let recoveries = 0;

    for (let cut = 1; cut < payload.length; cut += 1) {
      const clipped = `${payload.slice(0, cut)}${AUDIT_TRUNCATION_SUFFIX}`;
      const recovered = recoverTruncatedStructuredDetail(clipped);
      if (recovered === null) {
        continue;
      }
      recoveries += 1;

      for (const [key, value] of Object.entries(recovered)) {
        if (key === REDUCED_DETAIL_KEYS.recovered) {
          continue;
        }
        expect(
          { cut, key, value },
          `cut ${cut} invented or altered "${key}"`,
        ).toEqual({ cut, key, value: original[key] });
      }
    }

    // A sweep that recovered nothing anywhere would pass vacuously, which is
    // the failure mode this repository has shipped before.
    expect(recoveries).toBeGreaterThan(10);
  });

  it("never returns a half-written value, at any cut inside one", () => {
    const payload = representativePayload(3);
    // Every offset that falls inside the money figure. Under the old rule these
    // stored "amountCents":1 / :12 / :123 … for a recorded 1234567.
    const start = payload.indexOf('"amountCents":') + '"amountCents":'.length;
    for (let cut = start + 1; cut < start + 7; cut += 1) {
      const recovered = recoverTruncatedStructuredDetail(
        `${payload.slice(0, cut)}${AUDIT_TRUNCATION_SUFFIX}`,
      );
      expect(recovered?.amountCents ?? 1234567).toBe(1234567);
    }
  });

  it("keeps whole pairs from before the cut and discards the partial one", () => {
    const payload = representativePayload(3);
    const cut = payload.indexOf('"before"') + 20;
    const recovered = recoverTruncatedStructuredDetail(
      `${payload.slice(0, cut)}${AUDIT_TRUNCATION_SUFFIX}`,
    );

    expect(recovered).toEqual({
      bookingId: "bkg_01HQ8Z",
      amountCents: 1234567,
      confirmed: true,
      [REDUCED_DETAIL_KEYS.recovered]: true,
    });
  });

  it("declines a clean document, prose, and a cut with no complete pair", () => {
    // A clean parse is the caller's job; recovery must not shadow it.
    expect(recoverTruncatedStructuredDetail('{"a":1}')).toBeNull();
    expect(
      recoverTruncatedStructuredDetail("Rejected: the dates overlap"),
    ).toBeNull();
    // Nothing complete precedes the cut, so there is nothing honest to show.
    expect(
      recoverTruncatedStructuredDetail(`{"bookingId":"bkg${AUDIT_TRUNCATION_SUFFIX}`),
    ).toBeNull();
    expect(recoverTruncatedStructuredDetail(null)).toBeNull();
  });

  it("does not mistake a comma inside a nested value for a pair boundary", () => {
    // `depth === 1` is the whole guard. Without it the scan closes the object
    // in the middle of `before`, and `JSON.parse` either throws or — worse, on
    // a different payload — succeeds against a shape nobody wrote.
    const recovered = recoverTruncatedStructuredDetail(
      `{"bookingId":"bkg_1","before":{"status":"PENDING","nights"${AUDIT_TRUNCATION_SUFFIX}`,
    );
    expect(recovered).toEqual({
      bookingId: "bkg_1",
      [REDUCED_DETAIL_KEYS.recovered]: true,
    });
  });

  /**
   * THE FORGE THAT ACTUALLY SURVIVES REMOVING THE STRIP, which is the point
   * (#2704 review). An earlier version of this test forged only the recovery
   * marker and could not fail: the marker is assigned AFTER the strip, so it
   * overwrites whatever the stored text claimed whether the strip runs or not.
   * It is still forged below, so the assertion covers it, but the discriminating
   * forge is a legacy row minting the REDUCTION's own keys — claiming a release
   * that had not shipped when the row was written produced it, complete with an
   * invented list of fields it says were dropped. The sanitiser's own
   * `_truncatedKeys` flag is the same shape of lie and is stripped with them.
   */
  it("cannot be handed forged bookkeeping by the stored text", () => {
    const forged = [
      `"${REDUCED_DETAIL_KEYS.recovered}":"not mine"`,
      `"${REDUCED_DETAIL_KEYS.truncated}":true`,
      `"${REDUCED_DETAIL_KEYS.originalLength}":99`,
      `"${REDUCED_DETAIL_KEYS.droppedKeys}":["neverExisted"]`,
      `"${REDUCED_DETAIL_KEYS.droppedKeyCount}":400`,
      `"${AUDIT_TRUNCATED_KEYS_FLAG}":true`,
    ].join(",");
    const recovered = recoverTruncatedStructuredDetail(
      `{${forged},"bookingId":"bkg_1","x"${AUDIT_TRUNCATION_SUFFIX}`,
    );

    expect(recovered).toEqual({
      bookingId: "bkg_1",
      [REDUCED_DETAIL_KEYS.recovered]: true,
    });
  });
});

describe("reducing a payload that will not fit (#2704)", () => {
  it("stores a payload that still parses, with no fragment of a number in it", () => {
    const payload = representativePayload(400);
    expect(payload.length).toBeGreaterThan(1000);

    const stored = storedDetails(payload) ?? "";
    const parsed = JSON.parse(stored) as Record<string, unknown>;

    expect(stored.length).toBeLessThanOrEqual(1000);
    expect(parsed.bookingId).toBe("bkg_01HQ8Z");
    expect(parsed.amountCents).toBe(1234567);
    expect(parsed.confirmed).toBe(true);
    expect(parsed.before).toEqual({ status: "PENDING", nights: 2 });
    expect(parsed[REDUCED_DETAIL_KEYS.truncated]).toBe(true);
    expect(parsed[REDUCED_DETAIL_KEYS.originalLength]).toBeGreaterThan(1000);
  });

  it("shortens a long string behind the marker rather than dropping it", () => {
    // `issue.reported` carries a page URL the schema caps at 2048 characters.
    // Dropping it would lose the field the row exists for; clipping it keeps
    // the useful head and says out loud that there is more.
    const stored =
      storedDetails(
        JSON.stringify({
          pageUrl: `https://club.example.nz/book?${"q=1&".repeat(500)}`,
          pageTitle: "Booking page",
          hasScreenshot: true,
        }),
      ) ?? "";
    const parsed = JSON.parse(stored) as Record<string, unknown>;

    expect(String(parsed.pageUrl)).toContain("https://club.example.nz/book?");
    expect(String(parsed.pageUrl).endsWith(AUDIT_TRUNCATION_SUFFIX)).toBe(true);
    // The short fields behind the long one are not starved by it.
    expect(parsed.pageTitle).toBe("Booking page");
    expect(parsed.hasScreenshot).toBe(true);
  });

  it("names what it dropped, and drops only whole fields", () => {
    const reduced = reduceStructuredDetail(
      {
        keptId: "k1",
        droppedObject: { padding: "p".repeat(2000) },
        droppedNumber: 4242,
      },
      200,
    );

    const parsed = JSON.parse(reduced?.text ?? "") as Record<string, unknown>;
    expect(parsed.keptId).toBe("k1");
    expect(parsed.droppedObject).toBeUndefined();
    expect(parsed[REDUCED_DETAIL_KEYS.droppedKeys]).toEqual(["droppedObject"]);
    // Every name fitted, so there is no count: the count is the marker that the
    // list below it is SHORT, and writing one here would say the opposite.
    expect(parsed[REDUCED_DETAIL_KEYS.droppedKeyCount]).toBeUndefined();
    // A number is kept whole or not at all — it is small, so it is kept.
    expect(parsed.droppedNumber).toBe(4242);
  });

  /**
   * THE BAND IN WHICH A LONGER VALUE KEPT MORE EVIDENCE THAN A SHORTER ONE
   * (#2704 review), and it is walked rather than sampled because one worked
   * example inside or outside a band proves nothing about the band.
   *
   * Admitting fields in the payload's KEY order meant a leading string whose
   * cost landed just under the room took all of it, and every field behind it
   * was dropped. Measured at this column's budget on exactly this payload: an
   * 865-character note stored ONE field of six — losing the amount, the
   * booking, the payment and the invoice — while an 870-character note stored
   * all six, because at 870 the note no longer fitted whole and the short
   * fields got in ahead of it. The fields that band destroyed are the
   * identifiers the drill-down links are built from and the money figure the
   * description leads with, which is precisely the evidence this issue exists
   * to preserve.
   */
  it("keeps every short field whatever the length of the long one in front of them", () => {
    const identifiers = {
      amountCents: 1234567,
      bookingId: "bkg_01HQ8Z9KJ2M4N5P6Q7R8S9T",
      paymentId: "pay_01HQ8Z9KJ2M4N5P6Q7R8S9T",
      invoiceId: "inv_01HQ8Z9KJ2M4N5P6Q7R8S9T",
      memberId: "mem_01HQ8Z9KJ2M4N5P6Q7R8S9T",
    };

    for (let noteLength = 780; noteLength <= 900; noteLength += 1) {
      const reduced = reduceStructuredDetail(
        { note: "N".repeat(noteLength), ...identifiers },
        1000,
      );
      const parsed = JSON.parse(reduced?.text ?? "") as Record<string, unknown>;
      const kept = Object.fromEntries(
        Object.keys(identifiers).map((key) => [key, parsed[key]]),
      );

      expect({ noteLength, ...kept }).toEqual({ noteLength, ...identifiers });
      // And the long neighbour still contributes what it can, whole or clipped.
      expect(typeof parsed.note).toBe("string");
      expect(reduced?.text.length ?? 0).toBeLessThanOrEqual(1000);
    }
  });

  /**
   * THE ONE FIELD THIS MODULE ADDS OBEYED EVERY RULE BUT ITS OWN (#2704
   * review). The dropped-name list is shed from the end until the block fits,
   * and nothing said so — a value partially rendered with no marker, which is
   * the defect the whole module exists to remove.
   */
  it("says how many fields it dropped when it cannot name them all", () => {
    const payload: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) {
      payload[`aVeryDescriptiveFieldNameNumber${String(index).padStart(2, "0")}`] =
        "v".repeat(400);
    }

    const reduced = reduceStructuredDetail(payload, 1000);
    const parsed = JSON.parse(reduced?.text ?? "") as Record<string, unknown>;
    const named = parsed[REDUCED_DETAIL_KEYS.droppedKeys] as string[];

    // Measured: 38 dropped, one of them named in the stored row.
    expect(reduced?.droppedKeys).toHaveLength(38);
    expect(named.length).toBeLessThan(38);
    expect(parsed[REDUCED_DETAIL_KEYS.droppedKeyCount]).toBe(38);
    expect(reduced?.text.length ?? 0).toBeLessThanOrEqual(1000);
    // The caller's own return value never loses a name; only the stored row is
    // bounded, which is why it is the stored row that has to say so.
    expect(new Set(reduced?.droppedKeys)).toEqual(
      new Set(Object.keys(payload).filter((key) => !(key in parsed))),
    );
  });

  /**
   * REDUCED ONCE, NOT TWICE (#2704 review, found by both lenses).
   *
   * A payload over BOTH budgets used to be reduced at 24,000 by the metadata
   * sanitiser and then again at 1,000 here. The second pass strips the reserved
   * keys and re-mints them from the already-reduced document, so the row
   * recorded the length of an intermediate nobody ever wrote and the first
   * pass's dropped names vanished with no count and no marker.
   */
  it("records the payload's own length, not an intermediate nobody wrote", () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 58; index += 1) {
      wide[`filler${index}`] = "f".repeat(900);
    }
    const payload = JSON.stringify(wide);
    expect(payload.length).toBeGreaterThan(50_000);

    const stored = storedDetails(payload) ?? "";
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const kept = Object.keys(parsed).filter((key) => !key.startsWith("_"));
    const dropped =
      (parsed[REDUCED_DETAIL_KEYS.droppedKeyCount] as number | undefined) ??
      (parsed[REDUCED_DETAIL_KEYS.droppedKeys] as string[]).length;

    // Through the double reduction this read ~23,900 — the 24,000-character
    // intermediate — for a payload of more than fifty thousand.
    expect(parsed[REDUCED_DETAIL_KEYS.originalLength]).toBeGreaterThan(50_000);
    // And every field is accounted for: kept, or counted as dropped.
    expect(kept.length + dropped).toBe(58);
  });

  it("is deterministic, and leaves a payload that fits byte-identical", () => {
    const big = representativePayload(400);
    expect(storedDetails(big)).toBe(storedDetails(big));

    // Historical meaning: a row that fitted before still stores exactly what it
    // stored before, with no marker and no bookkeeping key.
    const small = representativePayload(2);
    expect(small.length).toBeLessThan(1000);
    expect(storedDetails(small)).toBe(small);
  });

  it("does not claim truncation when sanitising made the payload fit", () => {
    // The over-budget path is entered from the length of the RAW text, but the
    // reduction measures the SANITISED value — and redaction can shorten a
    // payload a long way. A row marked `_truncated` that was not truncated is a
    // false claim, which is the one thing this rule exists not to make.
    const stored =
      storedDetails(
        JSON.stringify({
          bookingId: "bkg_1",
          // Redacted wholesale by key name, taking 1100 characters with it.
          password: "p".repeat(1100),
        }),
      ) ?? "";
    const parsed = JSON.parse(stored) as Record<string, unknown>;

    expect(parsed.bookingId).toBe("bkg_1");
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed[REDUCED_DETAIL_KEYS.truncated]).toBeUndefined();
    expect(parsed[REDUCED_DETAIL_KEYS.droppedKeys]).toBeUndefined();
  });

  it("leaves prose over the limit on the honest text clip", () => {
    const prose = `Rejected. ${"because ".repeat(300)}`;
    const stored = storedDetails(prose) ?? "";
    expect(stored.endsWith(AUDIT_TRUNCATION_SUFFIX)).toBe(true);
    expect(stored.startsWith("Rejected. because")).toBe(true);
  });

  it("keeps the metadata envelope's fields instead of a clipped preview", () => {
    // Over the JSON envelope the column used to store one unparseable string —
    // `serialized.slice(0, 1000)` — and throw every field away.
    const wide: Record<string, string> = { bookingId: "bkg_1" };
    for (let i = 0; i < 40; i += 1) {
      wide[`filler${i}`] = "f".repeat(900);
    }
    const sanitized = sanitizeAuditMetadata(wide) as Record<string, unknown>;

    expect(sanitized.bookingId).toBe("bkg_1");
    expect(sanitized[REDUCED_DETAIL_KEYS.truncated]).toBe(true);
    expect(sanitized.preview).toBeUndefined();
    expect(JSON.stringify(sanitized).length).toBeLessThanOrEqual(24_000);
  });
});

describe("who the recovered detail reaches (#2704 with #2695)", () => {
  const CLIPPED = `${representativePayload(400).slice(0, 1000)}${AUDIT_TRUNCATION_SUFFIX}`;
  /** Long enough that it cannot slot into the room a reduced payload leaves. */
  const LONG_SENTENCE = `Credit of $25.00 added to your account. Reason: ${"goodwill, ".repeat(90)}thank you`;

  it("renders a legacy clipped payload as fields, and keeps the raw record beside them", async () => {
    const entry = await timelineEntry(rowOf({ details: CLIPPED }), "admin");

    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.bookingId).toBe("bkg_01HQ8Z");
    expect(metadata.amountCents).toBe(1234567);
    expect(metadata[REDUCED_DETAIL_KEYS.recovered]).toBe(true);
    // The sentence slot holds a formatted summary, never the broken blob.
    expect(entry.description).not.toContain(AUDIT_TRUNCATION_SUFFIX);
    // Formatted as the money figure it is, which is the structured rendering
    // working — under the old rule this slot held a fragment of raw JSON.
    expect(entry.description).toContain("$12,345.67");
    // The recovery is a view, so the stored record stays visible beside it. A
    // property of this module, held HERE — not `INV-OPS-012`, which an earlier
    // draft cited for it and which is about reclassifying a stored `category`.
    expect(entry.details).toBe(CLIPPED);
  });

  it("shows the member none of it — declared, clipped or recovered", async () => {
    // The payload now survives truncation as readable fields. That must change
    // nothing at all on the member's side, where #2695 answers from the
    // declaration and reads neither the column nor its shape.
    const entry = await timelineEntry(rowOf({ details: CLIPPED }), "member");

    expect(entry.details).toBeNull();
    expect(entry.description).toBeNull();
    expect(entry.metadata).toBeNull();

    // And the same for a payload that DOES parse, reduced or not.
    const parses = await timelineEntry(
      rowOf({ details: representativePayload(2) }),
      "member",
    );
    expect(parses.details).toBeNull();
    expect(parses.description).toBeNull();
    expect(parses.metadata).toBeNull();
  });

  it("cannot drop the member's declared sentence by reducing the payload", async () => {
    // #2695's ORDERING is what makes this safe, and this change had to not
    // break it: the caller's metadata is sanitised — now reduced — FIRST, and
    // the declared sentence is attached on top of the result afterwards. Were
    // the two ever merged into one step, a large admin payload would eat the
    // budget and the one sentence the member reads would be clipped or
    // dropped, on their timeline AND in their data export. That is the defect
    // #2695's docblock warns the next simplifier about, and this rule's
    // reduction is what would make it bite.
    //
    // THE SENTENCE IS LONG ON PURPOSE, and that is the whole discrimination.
    // Written with a SHORT one this test passed against the merged ordering —
    // measured — because the reduction takes every field that fits and a short
    // pair slots into the room the big fields left behind. Only a sentence too
    // long to slot in tells the two orderings apart.
    const wide: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) {
      wide[`filler${i}`] = "f".repeat(900);
    }
    const args = buildStructuredAuditLogCreateArgs({
      action: "member.credit.adjustment.approve",
      category: "payment",
      actor: { memberId: ACTOR },
      subject: { memberId: SUBJECT },
      metadata: wide,
      memberDisclosure: { visibility: "member-facing", text: LONG_SENTENCE },
    });

    const stored = args.data.metadata as Record<string, unknown>;
    expect(stored[REDUCED_DETAIL_KEYS.truncated]).toBe(true);
    expect(readDeclaredMemberText(stored)).toBe(LONG_SENTENCE);

    // And the member reads that sentence and nothing from the reduced payload.
    const entry = await timelineEntry(
      rowOf({
        action: "member.credit.adjustment.approve",
        category: "payment",
        metadata: stored,
      }),
      "member",
    );
    expect(entry.description).toBe(LONG_SENTENCE);
    expect(entry.metadata).toBeNull();
    expect(entry.details).toBeNull();
  });

  it("does not let a bookkeeping key become the officer's description", async () => {
    const entry = await timelineEntry(
      rowOf({ details: `{"_truncated":true,"unremarkable":"x","y"${AUDIT_TRUNCATION_SUFFIX}` }),
      "admin",
    );
    expect(entry.description ?? "").not.toContain("Truncated");
  });

  it("filters the sanitiser's own dropped-keys flag out of the description too", async () => {
    // `_truncatedKeys` is written by `audit.ts` when a payload carries more than
    // 75 keys, and it was the one bookkeeping key missing from the reserved set
    // (#2704 review) — so it read as the officer's sentence, and survived into
    // a recovered row as though the writer had recorded it.
    const entry = await timelineEntry(
      rowOf({
        details: JSON.stringify({
          [AUDIT_TRUNCATED_KEYS_FLAG]: true,
          unremarkable: "x",
        }),
      }),
      "admin",
    );
    expect(entry.description ?? "").not.toContain("Truncated");
    expect(entry.description ?? "").toContain("Unremarkable");
  });

  /**
   * THE ONE MEMBER-FACING SURFACE THIS CHANGE'S WRITE SIDE CAN REACH, pinned
   * rather than reasoned about, because "this cannot widen what a member reads"
   * is an absolute claim (#2704 review).
   *
   * A member's own booking page reads the audit row DIRECTLY
   * (`booking-detail-history.ts` → `buildBookingHistoryItems`) instead of
   * through the timeline projection, and it falls back to the WHOLE stored
   * string when the payload does not parse. That fallback is what the old clip
   * triggered: the member read a broken JSON blob, payment-intent id and all.
   * The claim rests on a property of two call sites — `stripe-webhook-service`
   * and `payments/charge-saved-method` both put the member-readable text in
   * `errorMessage` — so the property is what is pinned here. This surface is
   * the decided second door of `INV-PRIV-012` and is named in `INV-PRIV-017`;
   * both put the readership decision at the surface, which is why a WRITE-side
   * change to what that surface reads owes a test rather than an argument.
   */
  it("narrows, and cannot widen, what a member's own booking page reads", () => {
    const stored =
      storedDetails(
        JSON.stringify({
          paymentIntentId: "pi_3QabcdEFGHijkLMN0PqrSTUv",
          amountCents: 24_500,
          errorMessage: `Your card was declined. ${"Contact your bank for details. ".repeat(40)}`,
        }),
      ) ?? "";

    const items = buildBookingHistoryItems({
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      audience: "member",
      payment: null,
      modifications: [],
      refundRequests: [],
      auditLogs: [
        {
          id: "audit-1",
          action: "booking.payment.failed",
          details: stored,
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      ],
    });
    const detail = items.find((item) => item.id === "audit-audit-1")?.detail ?? "";

    expect(detail).toContain("Your card was declined.");
    // Never the raw record, and never a neighbouring field the page does not
    // render — which is what the unparseable fallback used to hand over.
    expect(detail).not.toContain("pi_3QabcdEFGHijkLMN0PqrSTUv");
    expect(detail).not.toContain('{"');
  });
});
