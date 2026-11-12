import { beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  resolveAudience: vi.fn(),
  noticeFindUnique: vi.fn(),
  noticeUpdateMany: vi.fn(),
  memberFindMany: vi.fn(),
  getAppBaseUrl: vi.fn(() => "http://x"),
  createAuditLog: vi.fn(),
}));

vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/email-templates/communications", () => ({
  noticePublishedTemplate: () => "<html></html>",
}));
vi.mock("@/lib/app-url", () => ({ getAppBaseUrl: mocks.getAppBaseUrl }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
// `warn` is load-bearing, not padding: the real `email-theme` module is used
// here, and the #2900 render gate warns when it cannot read the club theme —
// which is exactly what happens with this file's narrow `prisma` mock. A logger
// mock without `warn` made that warning throw, the per-recipient catch swallowed
// it, and the notice silently emailed nobody.
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/notices", () => ({ resolveNoticeAudienceMembers: mocks.resolveAudience }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notice: {
      findUnique: mocks.noticeFindUnique,
      updateMany: mocks.noticeUpdateMany,
    },
    member: { findMany: mocks.memberFindMany },
  },
}));

import { sendNoticePublishedEmails } from "@/lib/notices-email";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.noticeFindUnique.mockResolvedValue({
    id: "notice-1",
    title: "Hut closed",
    status: "PUBLISHED",
  });
  mocks.sendEmail.mockResolvedValue({ status: "sent" });
  mocks.noticeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.createAuditLog.mockResolvedValue(undefined);
});

it("does nothing for a notice that is not published", async () => {
  mocks.noticeFindUnique.mockResolvedValue({ id: "n", title: "t", status: "DRAFT" });
  const result = await sendNoticePublishedEmails("n");
  expect(result).toEqual({ sent: 0, skipped: 0 });
  expect(mocks.sendEmail).not.toHaveBeenCalled();
});

// #4987: a notice is club business, sent under the opt-out Club notices
// preference (INV-PRIV-023) — never the newsletter (marketingEmails) opt-in.
it("emails every audience member except those who turned club notices off", async () => {
  mocks.resolveAudience.mockResolvedValue([
    { memberId: "m1", name: "A", email: "a@x.test", audienceVia: "All members", viaExplicitMember: false },
    { memberId: "m2", name: "B", email: "b@x.test", audienceVia: "All members", viaExplicitMember: false },
  ]);
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", notificationPreference: { clubNotices: true, marketingEmails: false } },
    { id: "m2", firstName: "B", notificationPreference: { clubNotices: false, marketingEmails: true } },
  ]);

  const result = await sendNoticePublishedEmails("notice-1");

  expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  expect(mocks.sendEmail.mock.calls[0][0].to).toBe("a@x.test");
  expect(result.sent).toBe(1);
  // m2 turned club notices off (its newsletter opt-in is irrelevant) -> skipped.
  expect(result.skipped).toBe(1);
});

it("counts a suppressed recipient as skipped (suppression enforced inside sendEmail)", async () => {
  mocks.resolveAudience.mockResolvedValue([
    { memberId: "m1", name: "A", email: "a@x.test", audienceVia: "All members", viaExplicitMember: false },
  ]);
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", notificationPreference: { clubNotices: true, marketingEmails: false } },
  ]);
  mocks.sendEmail.mockResolvedValue({ status: "suppressed" });

  const result = await sendNoticePublishedEmails("notice-1");
  expect(result.sent).toBe(0);
  expect(result.skipped).toBe(1);
});

it("emails a member with no preference row (club notices start on)", async () => {
  mocks.resolveAudience.mockResolvedValue([
    { memberId: "m1", name: "A", email: "a@x.test", audienceVia: "All members", viaExplicitMember: false },
  ]);
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", notificationPreference: null },
  ]);

  const result = await sendNoticePublishedEmails("notice-1");
  expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ sent: 1, skipped: 0 });
});

it("resets the single-send claim when the pre-send phase fails, so a retry can send", async () => {
  // Audience resolution crashes BEFORE any email is attempted.
  mocks.resolveAudience.mockRejectedValueOnce(new Error("db down"));

  const result = await sendNoticePublishedEmails("notice-1");

  expect(result).toEqual({ sent: 0, skipped: 0 });
  expect(mocks.sendEmail).not.toHaveBeenCalled();
  // emailedAt released (guarded on emailedAt not null) so a re-publish retries.
  expect(mocks.noticeUpdateMany).toHaveBeenCalledWith({
    where: { id: "notice-1", emailedAt: { not: null } },
    data: { emailedAt: null },
  });
  // No audit record for a pre-send crash — nothing was sent.
  expect(mocks.createAuditLog).not.toHaveBeenCalled();
});

it("does NOT reset the claim after a partial send (would double-email delivered recipients)", async () => {
  mocks.resolveAudience.mockResolvedValue([
    { memberId: "m1", name: "A", email: "a@x.test", audienceVia: "All members", viaExplicitMember: false },
    { memberId: "m2", name: "B", email: "b@x.test", audienceVia: "All members", viaExplicitMember: false },
  ]);
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", notificationPreference: { clubNotices: true, marketingEmails: false } },
    { id: "m2", firstName: "B", notificationPreference: { clubNotices: true, marketingEmails: false } },
  ]);
  // First recipient delivers, second throws mid-batch.
  mocks.sendEmail
    .mockResolvedValueOnce({ status: "sent" })
    .mockRejectedValueOnce(new Error("smtp blip"));

  const result = await sendNoticePublishedEmails("notice-1");

  expect(result.sent).toBe(1);
  // Second recipient counted as skipped (failed), not re-queued.
  expect(result.skipped).toBe(1);
  // The claim is retained — never released after a send was attempted.
  expect(mocks.noticeUpdateMany).not.toHaveBeenCalled();
});

it("writes an audit record with the send counts after the batch", async () => {
  mocks.resolveAudience.mockResolvedValue([
    { memberId: "m1", name: "A", email: "a@x.test", audienceVia: "All members", viaExplicitMember: false },
    { memberId: "m2", name: "B", email: "b@x.test", audienceVia: "All members", viaExplicitMember: false },
    { memberId: "m3", name: "C", email: "c@x.test", audienceVia: "All members", viaExplicitMember: false },
  ]);
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", notificationPreference: { clubNotices: true, marketingEmails: false } },
    { id: "m2", firstName: "B", notificationPreference: { clubNotices: true, marketingEmails: false } },
    // m3 turned club notices off.
    { id: "m3", firstName: "C", notificationPreference: { clubNotices: false, marketingEmails: true } },
  ]);
  // m1 sends, m2 suppressed.
  mocks.sendEmail
    .mockResolvedValueOnce({ status: "sent" })
    .mockResolvedValueOnce({ status: "suppressed" });

  await sendNoticePublishedEmails("notice-1");

  expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
  const arg = mocks.createAuditLog.mock.calls[0][0];
  expect(arg.action).toBe("notice.emailSent");
  expect(arg.entityId).toBe("notice-1");
  expect(arg.metadata).toMatchObject({
    noticeId: "notice-1",
    audienceCount: 3,
    recipientCount: 2,
    sentCount: 1,
    failedCount: 1,
    optedOutCount: 1,
    neverOptedInCount: 0,
  });
});
