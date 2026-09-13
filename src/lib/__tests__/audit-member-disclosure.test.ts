/**
 * MEMBER-VISIBLE AUDIT TEXT IS DECLARED, AND DENIED BY DEFAULT (#2695).
 *
 * These are the behavioural half of the contract. The census beside them
 * (`audit-writer-census.test.ts`) pins WHICH sites declare; this file pins what
 * the declaration does at the write boundary and what the member's timeline
 * does with it.
 *
 * WHAT THE MUTATION PROBES HERE ARE FOR. Two changes must fail a NAMED test,
 * and both were run against this file with the mutation applied, then restored:
 *
 *  - making an undeclared event's free text member-visible again — reverting
 *    `projectFreeTextForAudience`'s member branch to the old
 *    `hasLegacyMetadata ? null : log.details` shape test — fails
 *    "denies an undeclared event's free text to the member";
 *  - flipping a declaration from `internal` to `member-facing` at a write site
 *    fails the census's "publishes free text to a member from exactly the
 *    pinned write sites", by name and with the action it would publish.
 */
import { describe, expect, it } from "vitest";

import {
  buildStructuredAuditLogCreateArgs,
  type StructuredAuditEvent,
} from "@/lib/audit";
import {
  MEMBER_FACING_AUDIT_TEXT_KEY,
  readDeclaredMemberText,
} from "@/lib/audit-member-disclosure";
import { getAuditTimelinePage } from "@/lib/audit-query";

const ACTOR = "officer-1";
const SUBJECT = "member-1";

function eventOf(
  overrides: Partial<StructuredAuditEvent> = {},
): StructuredAuditEvent {
  return {
    action: "member.credit.adjustment.approve",
    category: "payment",
    actor: { memberId: ACTOR },
    subject: { memberId: SUBJECT },
    details: "Approved admin credit adjustment req_1 as credit cr_1",
    ...overrides,
  };
}

function storedMetadata(event: StructuredAuditEvent) {
  return buildStructuredAuditLogCreateArgs(event).data.metadata;
}

/** One stored row, as the timeline's `select` returns it. */
function rowOf(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    action: "member.credit.adjustment.approve",
    memberId: ACTOR,
    targetId: SUBJECT,
    details: null,
    ipAddress: "203.0.113.1",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    actorMemberId: ACTOR,
    subjectMemberId: SUBJECT,
    entityType: "Member",
    entityId: SUBJECT,
    category: "payment",
    severity: "info",
    outcome: "success",
    summary: null,
    metadata: null,
    requestId: "req-1",
    userAgent: "agent",
    retentionClass: "critical",
    ...overrides,
  };
}

async function timelineEntry(
  row: Record<string, unknown>,
  audience: "admin" | "member",
) {
  const db = {
    auditLog: {
      findMany: async () => [row],
      count: async () => 1,
    },
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

describe("audit member-disclosure write boundary (#2695)", () => {
  it("stores the declared sentence, and stores nothing for the two silent cases", () => {
    expect(
      readDeclaredMemberText(
        storedMetadata(
          eventOf({
            memberDisclosure: {
              visibility: "member-facing",
              text: "Credit of $25.00 added to your account. Reason: goodwill",
            },
          }),
        ),
      ),
    ).toBe("Credit of $25.00 added to your account. Reason: goodwill");

    expect(
      readDeclaredMemberText(
        storedMetadata(eventOf({ memberDisclosure: { visibility: "internal" } })),
      ),
    ).toBeNull();

    // The default, and the whole safety property: a writer that thinks about
    // none of this publishes none of it.
    expect(readDeclaredMemberText(storedMetadata(eventOf()))).toBeNull();
  });

  it("refuses to let a caller forge the reserved key through its own metadata", () => {
    // "Prefer unrepresentable over policed": there is no lint rule to forget,
    // because the boundary strips the key from whatever a caller supplies and
    // re-attaches it only from a declaration.
    const forged = storedMetadata(
      eventOf({
        metadata: {
          [MEMBER_FACING_AUDIT_TEXT_KEY]: "You were refused because you argued",
          decision: "APPROVED",
        },
      }),
    );

    expect(readDeclaredMemberText(forged)).toBeNull();
    expect(forged).toEqual({ decision: "APPROVED" });
  });

  it("lets a declaration beat a forged key rather than merge with it", () => {
    const stored = storedMetadata(
      eventOf({
        metadata: { [MEMBER_FACING_AUDIT_TEXT_KEY]: "forged" },
        memberDisclosure: { visibility: "member-facing", text: "declared" },
      }),
    );

    expect(readDeclaredMemberText(stored)).toBe("declared");
  });

  it("keeps the declared text when the site's own metadata blows the JSON budget", () => {
    // THE SECOND FORM OF THE HOLE THIS ISSUE CLOSED. `sanitizeAuditMetadata`
    // swaps an over-budget payload for a `{_truncated, preview}` stub. Merge the
    // declared text in BEFORE that and a large admin payload silently deletes
    // what the member reads — an audience decided by a length, which is the
    // same defect as the shape test in a different disguise.
    // Each string is clipped at 1000 characters first, so one giant value does
    // not reach the JSON budget — it takes many of them.
    const huge = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `field${index}`,
        "x".repeat(1_000),
      ]),
    );
    const stored = storedMetadata(
      eventOf({
        metadata: huge,
        memberDisclosure: { visibility: "member-facing", text: "kept" },
      }),
    );

    expect(stored).toMatchObject({ _truncated: true });
    expect(readDeclaredMemberText(stored)).toBe("kept");
  });

  it("holds the declared sentence to the audit trail's own secret rules", () => {
    const stored = storedMetadata(
      eventOf({
        memberDisclosure: {
          visibility: "member-facing",
          text: "Reason: card 4242 4242 4242 4242 was declined",
        },
      }),
    );

    const text = readDeclaredMemberText(stored) ?? "";
    expect(text).not.toContain("4242 4242 4242 4242");
    expect(text).toContain("[REDACTED_CARD]");
  });

  it("refuses a declaration whose text sanitises away to nothing", () => {
    // Fail-closed in the right direction: no row, rather than a row that claims
    // to explain something to a member and does not.
    expect(() =>
      storedMetadata(
        eventOf({ memberDisclosure: { visibility: "member-facing", text: "   " } }),
      ),
    ).toThrow(/declared member-facing text that cannot be stored/);
  });
});

describe("audit member timeline reads only what was declared (#2695)", () => {
  it("denies an undeclared event's free text to the member", async () => {
    // THE DEFECT, in one row: an administrator's rejection note, typed under a
    // "do not notify the member" tick, stored as prose. The old reader handed it
    // over because it did not parse as JSON.
    const row = rowOf({
      action: "member.deletion_rejected",
      category: "privacy",
      details: "Note: they have an unpaid account and we suspect a duplicate",
    });

    const member = await timelineEntry(row, "member");
    expect(member.description).toBeNull();
    expect(member.details).toBeNull();
    expect(member.metadata).toBeNull();

    // And the officers keep it, which is the point of an audit trail.
    const admin = await timelineEntry(row, "admin");
    expect(admin.description).toBe(
      "Note: they have an unpaid account and we suspect a duplicate",
    );
    expect(admin.details).toBe(
      "Note: they have an unpaid account and we suspect a duplicate",
    );
  });

  it("gives the member the declared sentence and none of the row it came from", async () => {
    const row = rowOf({
      details:
        "Approved admin credit adjustment req_1 as credit cr_1: +2500 cents. Requested by officer-9. Reason: goodwill",
      metadata: {
        [MEMBER_FACING_AUDIT_TEXT_KEY]:
          "Credit of $25.00 added to your account. Reason: goodwill",
        internalRequestId: "req_1",
      },
    });

    const member = await timelineEntry(row, "member");
    expect(member.description).toBe(
      "Credit of $25.00 added to your account. Reason: goodwill",
    );
    // Not the officers' sentence, which names two database ids and the member
    // who asked for the adjustment.
    expect(member.details).toBeNull();
    expect(member.description).not.toContain("req_1");
    expect(member.description).not.toContain("officer-9");
    expect(member.metadata).toBeNull();
    expect(member.requestId).toBeUndefined();
    expect(member.ipAddress).toBeUndefined();
  });

  it("decides the member's text by declaration, never by whether the payload parses", async () => {
    // Both rows are undeclared. Under the old shape test the first showed the
    // member nothing and the second showed them everything, purely because one
    // string was JSON and the other was not.
    const asJson = await timelineEntry(
      rowOf({ details: JSON.stringify({ note: "internal" }) }),
      "member",
    );
    const asProse = await timelineEntry(
      rowOf({ details: "internal" }),
      "member",
    );

    expect(asJson.description).toBeNull();
    expect(asProse.description).toBeNull();
    expect([asJson.details, asProse.details]).toEqual([null, null]);
  });

  it("falls back to the derived title for BOTH audiences when the stored title is blank", async () => {
    // One fallback rule, two audiences. The admin title has always fallen
    // through on a blank `summary`; the member title was first written with
    // `??`, which only catches null — so an empty string, which the write
    // boundary stores as readily as any other value, gave an officer
    // "Member Deletion Rejected" and the member an empty row title. A member
    // reading their own history should never be shown less than an officer is
    // shown of the same row unless somebody DECIDED it, and nobody decided this.
    for (const blank of ["", "   "]) {
      const row = rowOf({
        action: "member.deletion_rejected",
        category: "privacy",
        summary: blank,
      });

      const member = await timelineEntry(row, "member");
      const admin = await timelineEntry(row, "admin");

      expect(member.summary).toBe("Member Deletion Rejected");
      expect(admin.summary).toBe("Member Deletion Rejected");
      expect(member.summary).toBe(admin.summary);
    }
  });

  it("never shows a member a payload-derived title for somebody else", async () => {
    // The admin title for these two actions is read out of the legacy JSON
    // payload. A row reaches the ACTING member's own timeline through the
    // null-subject `memberId` leg, so that payload's `recipientEmail` can be a
    // different member's address.
    const row = rowOf({
      action: "member.setup-invite-sent",
      category: "security",
      subjectMemberId: null,
      summary: null,
      details: JSON.stringify({ recipientEmail: "someone.else@example.com" }),
    });

    const member = await timelineEntry(row, "member");
    expect(member.summary).toBe("Member Setup Invite Sent");
    expect(member.summary).not.toContain("someone.else@example.com");

    const admin = await timelineEntry(row, "admin");
    expect(admin.summary).toBe("Setup invite sent to someone.else@example.com");
  });
});
