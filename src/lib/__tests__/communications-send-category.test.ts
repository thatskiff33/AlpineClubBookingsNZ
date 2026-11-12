import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// #4987: the Communications send route and its recipient preview resolve the
// same audience through the shared bulk-email rule (INV-PRIV-023).
const mocks = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  sendEmail: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({
    ok: true,
    session: { user: { id: "admin-1" } },
  })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ success: true, resetAt: 0 })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findMany: mocks.memberFindMany } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/email-theme", () => ({
  renderEmailHtml: async () => "<html></html>",
}));
vi.mock("@/lib/email-templates/communications", () => ({
  bulkCommunicationTemplate: () => "<html></html>",
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/communications/send/route";
import { GET as previewGet } from "@/app/api/admin/communications/preview/route";
import { NextRequest } from "next/server";

const MEMBERS = [
  { id: "no-row", email: "no-row@test", notificationPreference: null },
  {
    id: "club-off",
    email: "club-off@test",
    notificationPreference: { clubNotices: false, marketingEmails: false },
  },
  {
    id: "defaults",
    email: "defaults@test",
    notificationPreference: { clubNotices: true, marketingEmails: false },
  },
  {
    id: "newsletter-on",
    email: "newsletter-on@test",
    notificationPreference: { clubNotices: true, marketingEmails: true },
  },
];

function sendRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/admin/communications/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subject: "Lodge closed",
      body: "Closed 14-16 August",
      recipientFilter: "all",
      ...body,
    }),
  });
}

async function emailedAddresses() {
  // The send loop runs after the response; let it drain.
  await vi.waitFor(() => expect(mocks.sendEmail).toHaveBeenCalled());
  return mocks.sendEmail.mock.calls.map(([args]) => args.to).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberFindMany.mockResolvedValue(MEMBERS);
  mocks.sendEmail.mockResolvedValue({ status: "sent" });
});

describe("POST /api/admin/communications/send", () => {
  it("sends a club notice to members with no saved preferences and skips those who turned it off", async () => {
    const res = await POST(sendRequest({ category: "clubNotice" }));
    const json = await res.json();

    expect(json).toMatchObject({
      category: "clubNotice",
      totalRecipients: 4,
      eligibleRecipients: 3,
      optedOut: 1,
      neverOptedIn: 0,
      filteredByPreference: 1,
    });
    expect(await emailedAddresses()).toEqual([
      "defaults@test",
      "newsletter-on@test",
      "no-row@test",
    ]);
  });

  it("sends a newsletter only to members who opted in, telling apart opted-out and never-opted-in members", async () => {
    const res = await POST(sendRequest({ category: "newsletter" }));
    const json = await res.json();

    expect(json).toMatchObject({
      category: "newsletter",
      eligibleRecipients: 1,
      optedOut: 2,
      neverOptedIn: 1,
      filteredByPreference: 3,
    });
    expect(await emailedAddresses()).toEqual(["newsletter-on@test"]);
    expect(JSON.parse(mocks.logAudit.mock.calls[0][0].details)).toMatchObject({
      category: "newsletter",
      totalRecipients: 4,
      eligibleRecipients: 1,
      optedOut: 2,
      neverOptedIn: 1,
    });
  });

  it("treats a send that names no category as a newsletter, so an older page can never widen who is emailed", async () => {
    const res = await POST(sendRequest({}));
    expect(await res.json()).toMatchObject({
      category: "newsletter",
      eligibleRecipients: 1,
    });
    expect(await emailedAddresses()).toEqual(["newsletter-on@test"]);
  });

  it("rejects an unknown category", async () => {
    const res = await POST(sendRequest({ category: "everyone" }));
    expect(res.status).toBe(400);
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/communications/preview", () => {
  function previewRequest(query: string) {
    return new NextRequest(`http://x/api/admin/communications/preview?${query}`);
  }

  it("returns the counts the send would use, and no addresses", async () => {
    const res = await previewGet(
      previewRequest("recipientFilter=all&category=newsletter"),
    );
    const json = await res.json();

    expect(json).toEqual({
      totalRecipients: 4,
      eligibleRecipients: 1,
      optedOut: 2,
      neverOptedIn: 1,
    });
    expect(JSON.stringify(json)).not.toContain("@");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("changes with the category", async () => {
    const res = await previewGet(
      previewRequest("recipientFilter=all&category=clubNotice"),
    );
    expect(await res.json()).toMatchObject({ eligibleRecipients: 3, optedOut: 1 });
  });

  it("requires a category", async () => {
    const res = await previewGet(previewRequest("recipientFilter=all"));
    expect(res.status).toBe(400);
  });
});
