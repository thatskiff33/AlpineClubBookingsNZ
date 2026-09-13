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
 * and catastrophic at the ones that fell inside a number. "no cut position of a
 * representative payload can produce a field that disagrees with the payload"
 * sweeps every position there is.
 *
 * WHAT THE MUTATION PROBES HERE ARE FOR. Each of these was applied to the
 * source, run, seen to fail the NAMED test below, and restored:
 *
 *  - letting `recoverTruncatedStructuredDetail` close at the last top-level
 *    COLON instead of the last top-level comma — so a half-written value is
 *    admitted — fails "no cut position can produce a field that disagrees with
 *    the payload", naming the offset and the two values;
 *  - dropping the `depth === 1` test on the comma scan, so a comma inside a
 *    nested object or array counts as a pair boundary, fails the same test;
 *  - reverting `sanitizeAuditDetails` to the plain text clip fails "stores a
 *    payload that still parses, with no fragment of a number in it";
 *  - deleting the `hasStructuredDetails` argument to `getDescription` — putting
 *    the raw clipped blob back in the sentence slot — fails "renders a legacy
 *    clipped payload as fields, and keeps the raw record beside them".
 */
import { describe, expect, it } from "vitest";

import {
  buildStructuredAuditLogCreateArgs,
  sanitizeAuditMetadata,
} from "@/lib/audit";
import {
  AUDIT_TRUNCATION_SUFFIX,
  REDUCED_DETAIL_KEYS,
  recoverTruncatedStructuredDetail,
  reduceStructuredDetail,
} from "@/lib/audit-structured-detail";
import { getAuditTimelinePage } from "@/lib/audit-query";

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
  it("no cut position can produce a field that disagrees with the payload", () => {
    const payload = representativePayload(3);
    const original = JSON.parse(payload) as Record<string, unknown>;

    for (let cut = 1; cut < payload.length; cut += 1) {
      const clipped = `${payload.slice(0, cut)}${AUDIT_TRUNCATION_SUFFIX}`;
      const recovered = recoverTruncatedStructuredDetail(clipped);
      if (recovered === null) {
        continue;
      }

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

  it("cannot be handed a forged recovery marker by the stored text", () => {
    const recovered = recoverTruncatedStructuredDetail(
      `{"${REDUCED_DETAIL_KEYS.recovered}":"not mine","bookingId":"bkg_1","x"${AUDIT_TRUNCATION_SUFFIX}`,
    );
    expect(recovered?.[REDUCED_DETAIL_KEYS.recovered]).toBe(true);
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
    // A number is kept whole or not at all — it is small, so it is kept.
    expect(parsed.droppedNumber).toBe(4242);
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
    // `INV-OPS-012`: the recovery is a view, so the stored record stays visible.
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

  it("does not let a bookkeeping key become the officer's description", async () => {
    const entry = await timelineEntry(
      rowOf({ details: `{"_truncated":true,"unremarkable":"x","y"${AUDIT_TRUNCATION_SUFFIX}` }),
      "admin",
    );
    expect(entry.description ?? "").not.toContain("Truncated");
  });
});
