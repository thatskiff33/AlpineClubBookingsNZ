/**
 * THE DATA EXPORT IS A MEMBER-FACING CHANNEL, AND IT READS THE SAME
 * DECLARATION THE MEMBER'S TIMELINE DOES (#2695, `INV-PRIV-017`).
 *
 * WHY THIS FILE EXISTS. #2695 made what a member reads off an audit row an
 * explicit property of the event, declared where the row is written. The member
 * timeline was rebuilt around that. `/api/member/data-export` was not: it
 * selected `AuditLog.details` raw for every row matching `memberId` or
 * `targetId`, with no category filter and no audience test, and returned it
 * verbatim in the file the member downloads from Profile -> Export my data.
 *
 * So the owner's own worked example failed end to end. An officer declines an
 * account-deletion request, types a note, and ticks "do not notify the member".
 * The email is suppressed. The timeline correctly shows nothing. The member then
 * exports their data and reads the note. The credit approval's officer sentence
 * — naming the adjustment request, the credit row and the member who asked for
 * it — came back the same way, as did the note on every booking decision.
 *
 * WHAT EACH CASE IS FOR.
 *
 *  - The DECLINE case is the discriminator, and it is the owner's example. It
 *    fails against the code as it stood, because the sentence came back in the
 *    file. It asserts on the WHOLE serialised document rather than on the field,
 *    so moving the officer's text to another key does not satisfy it.
 *  - The DECLARED case is the control: gating must not become deleting. The one
 *    sentence the club decided a member keeps — why their credit balance moved —
 *    still reaches the file, from the declaration rather than from `details`.
 *  - The UNDECLARED-BUT-PARSEABLE case pins the default. A pre-#2695 row carries
 *    no reserved key whatever its shape, so it exports nothing; that is the
 *    same default-deny the timeline applies, stated here because the export
 *    reaches rows the timeline's category filter never returns.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  memberFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  choreFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  auditFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimiters: { dataExport: { limit: 5, windowSeconds: 86400 } },
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    booking: { findMany: mocks.bookingFindMany },
    choreAssignment: { findMany: mocks.choreFindMany },
    memberSubscription: { findMany: mocks.subscriptionFindMany },
    auditLog: { findMany: mocks.auditFindMany },
  },
}));

import { MEMBER_FACING_AUDIT_TEXT_KEY } from "@/lib/audit-member-disclosure";
import { GET as dataExportGet } from "@/app/api/member/data-export/route";

/** The note an officer types under the "do not notify the member" tick. */
const OFFICER_DECLINE_NOTE =
  "Note: refused because this member still owes the club money for the " +
  "August trip; chase before re-offering deletion.";

/** The sentence the owner decided the member keeps. */
const DECLARED_CREDIT_SENTENCE =
  "Credit of $25.00 added to your account. Reason: weather cancellation.";

interface ExportedAuditEntry {
  action: string;
  details: string | null;
  createdAt: string;
}

async function exportedDocument(): Promise<{
  auditLog: ExportedAuditEntry[];
  text: string;
}> {
  const res = await dataExportGet();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { auditLog: ExportedAuditEntry[] };
  return { auditLog: body.auditLog, text: JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "m1" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({
    success: true,
    limit: 5,
    remaining: 4,
    resetAt: Date.now() + 1000,
  });
  mocks.memberFindUnique.mockResolvedValue({
    firstName: "Mere",
    lastName: "Member",
    email: "member@example.test",
    dateOfBirth: null,
    joinedDate: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    role: "MEMBER",
    ageTier: "ADULT",
    active: true,
  });
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.choreFindMany.mockResolvedValue([]);
  mocks.subscriptionFindMany.mockResolvedValue([]);
  mocks.auditFindMany.mockResolvedValue([]);
});

describe("the member data export reads the #2695 declaration, not `details`", () => {
  it("does not return the deletion-decline note typed under 'do not notify'", async () => {
    // The owner's worked example, end to end. The row is `account` — it really
    // does reach this member — and it declares nothing, which since #2695 means
    // the member reads no free text from it.
    mocks.auditFindMany.mockResolvedValue([
      {
        action: "member.deletion_rejected",
        metadata: { notifyMember: false },
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ]);

    const { auditLog, text } = await exportedDocument();

    expect(auditLog).toEqual([
      {
        action: "member.deletion_rejected",
        details: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    ]);
    // Asserted on the whole document, not on the field: the officer's sentence
    // must be absent from the file, not merely moved to another key.
    expect(text).not.toContain(OFFICER_DECLINE_NOTE);
    expect(text).not.toContain("still owes the club money");
  });

  it("still returns the one sentence the club declared for the member", async () => {
    // Gating must not become deleting. This is the credit reason the owner
    // refused both of #2695's original fixes in order to keep.
    mocks.auditFindMany.mockResolvedValue([
      {
        action: "member.credit.adjustment.approve",
        metadata: {
          creditId: "credit_internal_1",
          [MEMBER_FACING_AUDIT_TEXT_KEY]: DECLARED_CREDIT_SENTENCE,
        },
        createdAt: new Date("2026-06-02T00:00:00.000Z"),
      },
    ]);

    const { auditLog, text } = await exportedDocument();

    expect(auditLog[0]?.details).toBe(DECLARED_CREDIT_SENTENCE);
    // The rest of the row's metadata is the officers' record and does not ride
    // along with the declared sentence.
    expect(text).not.toContain("credit_internal_1");
  });

  it("returns nothing for a row written before the declaration existed", async () => {
    // Two pre-#2695 shapes, because the old reader's answer depended on which
    // one a row happened to have: prose reached the member, JSON did not.
    // Neither carries the reserved key, so both export nothing now.
    mocks.auditFindMany.mockResolvedValue([
      {
        action: "booking.review.reject",
        metadata: { decision: "REJECTED", internalNoteRecorded: true },
        createdAt: new Date("2026-06-03T00:00:00.000Z"),
      },
      {
        action: "member.bulk-deactivate",
        metadata: null,
        createdAt: new Date("2026-06-04T00:00:00.000Z"),
      },
    ]);

    const { auditLog } = await exportedDocument();

    expect(auditLog.map((entry) => entry.details)).toEqual([null, null]);
  });

  it("does not ask the database for the `details` column at all", async () => {
    // Structural rather than behavioural: a column this route never selects is
    // a column no later edit to the mapping can re-publish by accident.
    await exportedDocument();

    const select = mocks.auditFindMany.mock.calls[0]?.[0]?.select as
      | Record<string, boolean>
      | undefined;
    expect(select).toBeDefined();
    expect(select).not.toHaveProperty("details");
    expect(select?.metadata).toBe(true);
  });
});
