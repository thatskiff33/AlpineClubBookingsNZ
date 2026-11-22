/**
 * ALP-796 (`INV-MCP-006`): the lodge-life actions an AI app connection may
 * run, each held to the contract it exposes (`expectActionContract`):
 *
 * - the connection is answered with exactly the action's `returns` fields;
 * - it acts as the signed-in member only, though that member is also an
 *   officer and a hut leader (`officerMemberSession`);
 * - the browser's answer is unchanged.
 *
 * The food-order actions have their own suite, on the food-order tables
 * (`mcp-food-order-actions.test.ts`).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  createClubPost: vi.fn(),
  getInductionForMember: vi.fn(),
  getInductionById: vi.fn(),
  listInductionsAwaitingSignOff: vi.fn(),
  listUpcomingMemberWorkParties: vi.fn(),
  findMemberWorkParty: vi.fn(),
  findActiveWorkPartyEventsForRange: vi.fn(),
  loadActiveMaintenanceQuestions: vi.fn(),
  createMaintenanceReport: vi.fn(),
  prisma: {
    calendarEvent: { findMany: vi.fn() },
    clubPost: { findMany: vi.fn() },
    committeeAssignment: { findFirst: vi.fn() },
    lodge: { findMany: vi.fn(), findFirst: vi.fn() },
    member: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: h.user })) }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
  requireActiveSession: vi.fn(async () => ({ ok: true, session: { user: h.user } })),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => ({
    eventsCalendar: true,
    // `GET /api/work-parties` exists only for an AI app (INV-MCP-001).
    mcpServer: true,
    workParties: true,
    commsPortal: true,
    maintenanceReports: true,
  })),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  applyMemberScopedRateLimit: vi.fn(async () => null),
  rateLimiters: {
    bookingQuery: { id: "booking-query" },
    clubPostCreate: { id: "club-post-create" },
    maintenanceReportMember: { id: "maintenance-report-member" },
  },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: vi.fn(async () => new Date("2026-07-01T00:00:00.000Z")),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
// The board's reader and serializer stay real; only the writer is replaced.
vi.mock("@/lib/club-posts", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-posts")),
  createClubPost: h.createClubPost,
}));
vi.mock("@/lib/club-post-sharing", () => ({ shareOnePost: vi.fn(async () => undefined) }));
vi.mock("@/lib/servernz-config", () => ({ isServerNzConfigured: vi.fn(async () => true) }));
// The view mapper and the sign-off rules stay real.
vi.mock("@/lib/induction", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/induction")),
  getInductionForMember: h.getInductionForMember,
  getInductionById: h.getInductionById,
  listInductionsAwaitingSignOff: h.listInductionsAwaitingSignOff,
}));
vi.mock("@/lib/hut-leader", () => ({ hasActiveHutLeaderAssignment: vi.fn(async () => true) }));
vi.mock("@/lib/work-party-member", () => ({
  listUpcomingMemberWorkParties: h.listUpcomingMemberWorkParties,
  findMemberWorkParty: h.findMemberWorkParty,
}));
vi.mock("@/lib/work-party", () => ({
  findActiveWorkPartyEventsForRange: h.findActiveWorkPartyEventsForRange,
}));
vi.mock("@/lib/maintenance-reports", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/maintenance-reports")),
  loadActiveMaintenanceQuestions: h.loadActiveMaintenanceQuestions,
  createMaintenanceReport: h.createMaintenanceReport,
}));
vi.mock("@/lib/maintenance-report-settings", () => ({
  loadMaintenanceReportSettings: vi.fn(async () => ({ photosEnabled: true })),
}));
vi.mock("@/lib/maintenance-report-alert", () => ({
  resolveMaintenanceAlertPayload: vi.fn(async () => ({})),
}));
vi.mock("@/lib/email", () => ({ sendAdminMaintenanceReportAlert: vi.fn(async () => undefined) }));

import { GET as listEvents } from "@/app/api/calendar/events/route";
import { GET as listPosts, POST as createPost } from "@/app/api/club-posts/route";
import { GET as getOwnInduction } from "@/app/api/inductions/route";
import { GET as getInduction } from "@/app/api/inductions/[id]/route";
import {
  GET as getMaintenanceForm,
  POST as submitMaintenanceReport,
} from "@/app/api/maintenance-reports/route";
import { GET as listWorkParties } from "@/app/api/work-parties/route";
import { GET as getWorkParty } from "@/app/api/work-parties/[id]/route";
import { GET as findWorkPartiesForStay } from "@/app/api/work-parties/active/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { CLUB_POST_PAGE_SIZE } from "@/lib/club-posts";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

const MEMBER_ID = "officer-1";

function asConnection(url: string, init: { method?: string; body?: unknown } = {}): NextRequest {
  return new NextRequest(`https://club.example.test${url}`, {
    method: init.method ?? "GET",
    headers: { [MCP_PRINCIPAL_HEADER]: "test-principal", "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user = officerMemberSession(MEMBER_ID).user as unknown as Record<string, unknown>;
});

describe("list_club_events", () => {
  it("answers with the events, without whether the member may edit them or the series bookkeeping", async () => {
    h.prisma.calendarEvent.findMany.mockResolvedValue([
      {
        id: "event-1",
        title: "Committee meeting",
        location: "Clubrooms",
        details: "Agenda to follow",
        allDay: false,
        startsAt: new Date("2026-07-10T07:00:00.000Z"),
        endsAt: new Date("2026-07-10T09:00:00.000Z"),
        isMeeting: true,
        meetingRoom: "secret-room-slug",
        seriesId: "series-1",
        detachedFromSeries: false,
        workPartyEventId: null,
        series: {
          frequency: "MONTHLY",
          interval: 1,
          until: new Date("2026-12-31T00:00:00.000Z"),
          count: null,
        },
      },
    ]);
    // A committee member may add events on the website.
    h.prisma.committeeAssignment.findFirst.mockResolvedValue({ id: "assignment-1" });
    const { connection, browser } = await expectActionContract({
      actionId: "list_club_events",
      handler: listEvents,
      args: { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
    });
    expect(connection).toMatchObject({
      events: [
        {
          id: "event-1",
          title: "Committee meeting",
          isMeeting: true,
          recurrence: { frequency: "MONTHLY", endMode: "until" },
        },
      ],
    });
    expect(JSON.stringify(connection)).not.toContain("secret-room-slug");
    expect(browser).toMatchObject({ canManage: true, events: [{ seriesId: "series-1" }] });
  });

  it("keeps an organisation account's connection off the calendar, as the account is", async () => {
    h.user = { ...(h.user as object), role: "USER", accessRoles: ["ORG", "ADMIN"] };
    const response = await listEvents(asConnection("/api/calendar/events"));
    expect(response.status).toBe(404);
    expect(h.prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });
});

describe("list_message_board_posts", () => {
  it("answers each post's plain text, without the author's member id or the rich body", async () => {
    h.prisma.clubPost.findMany.mockResolvedValue(
      Array.from({ length: CLUB_POST_PAGE_SIZE }, (_, index) => ({
        id: `post-${index}`,
        authorName: "Rangi Smith",
        authorMemberId: "member-9",
        content: "Snow on the deck",
        bodyHtml: '<p>Snow on the deck <img src="/api/club-posts/images/abc"></p>',
        sharedAt: null,
        shareRequestedAt: null,
        postedAt: new Date(Date.UTC(2026, 5, 30, 0, 0, 60 - index)),
        originClubName: null,
      })),
    );
    const { connection, browser } = await expectActionContract({
      actionId: "list_message_board_posts",
      handler: listPosts,
    });
    const text = JSON.stringify(connection);
    expect(text).not.toContain("member-9");
    expect(text).not.toContain("/api/club-posts/images");
    expect(connection).toMatchObject({
      posts: expect.arrayContaining([
        { id: "post-0", authorName: "Rangi Smith", content: "Snow on the deck", sharedToAllClubs: false, postedAt: expect.any(String), mine: false, originClubName: null },
      ]),
      cursor: { beforeId: `post-${CLUB_POST_PAGE_SIZE - 1}` },
    });
    expect(browser).toMatchObject({ posts: expect.arrayContaining([expect.objectContaining({ authorMemberId: "member-9" })]) });
  });
});

describe("post_to_message_board", () => {
  beforeEach(() => {
    h.prisma.member.findUnique.mockResolvedValue({ firstName: "Olive", lastName: "Officer" });
    h.createClubPost.mockImplementation(async (input: { content: string }) => ({ id: "post-new", content: input.content }));
  });

  it("posts plain text under the member's name, never shared with other clubs", async () => {
    const { connection } = await expectActionContract({
      actionId: "post_to_message_board",
      handler: createPost,
      args: { content: "Snow on the deck" },
    });
    expect(connection).toEqual({ id: "post-new" });
    expect(h.createClubPost.mock.calls[0]?.[0]).toMatchObject({
      authorMemberId: MEMBER_ID,
      authorName: "Olive Officer",
      content: "Snow on the deck",
      bodyHtml: null,
      shareToAllClubs: false,
    });
  });

  it.each([
    ["a rich body, which is how pictures are attached", { content: "Hi", shareToAllClubs: false, bodyHtml: "<p>Hi</p>" }],
    ["a share with other clubs", { content: "Hi", shareToAllClubs: true }],
  ])("refuses a connection %s, and posts nothing", async (_label, body) => {
    const response = await createPost(asConnection("/api/club-posts", { method: "POST", body }));
    expect(response.status).toBe(400);
    expect(h.createClubPost).not.toHaveBeenCalled();
  });
});

function inductionRecord(memberId: string) {
  return {
    id: `induction-${memberId}`,
    memberId,
    templateId: "template-1",
    applicationId: "application-1",
    kind: "NEW_MEMBER",
    status: "IN_PROGRESS",
    requiredSignOffs: 2,
    inductionDate: new Date("2026-06-28T00:00:00.000Z"),
    completedAt: null,
    completionSource: null,
    finalComments: "Private final comments",
    voidedReason: null,
    createdByMemberId: "admin-9",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-28T00:00:00.000Z"),
    member: { id: memberId, firstName: "Olive", lastName: "Officer" },
    template: {
      id: "template-1",
      name: "New member induction",
      version: "3",
      kind: "NEW_MEMBER",
      sourceLabel: null,
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      sections: [
        {
          id: "section-1",
          templateId: "template-1",
          title: "Fire safety",
          description: "Exits and extinguishers",
          priority: "CRITICAL",
          sortOrder: 0,
          items: [
            {
              id: "item-1",
              sectionId: "section-1",
              label: "Shown the fire exits",
              competencyPrompt: "Private competency prompt",
              notesPrompt: null,
              isMandatory: true,
              requiresDemonstration: false,
              sortOrder: 0,
              legacySourceText: null,
            },
          ],
        },
      ],
    },
    signOffs: [
      {
        id: "signoff-1",
        inductionId: `induction-${memberId}`,
        signerMemberId: "nominator-1",
        signerName: "Nora Nominator",
        signerRole: "NOMINATOR",
        declarationAccepted: true,
        comments: "Private sign-off comment",
        signedAt: new Date("2026-06-28T00:00:00.000Z"),
      },
    ],
    application: { nominator1Id: "nominator-1", nominator2Id: "nominator-2" },
    assignedSigners: [
      {
        id: "assigned-1",
        inductionId: `induction-${memberId}`,
        memberId: "nominator-2",
        emailSentAt: new Date("2026-06-02T00:00:00.000Z"),
        member: { id: "nominator-2", firstName: "Nigel", lastName: "Nominator" },
      },
    ],
  };
}

const PRIVATE_INDUCTION_TEXT = ["Private final comments", "Private competency prompt", "Private sign-off comment"];

describe("get_my_induction", () => {
  it("answers with the member's own induction only, without comments or prompts, and never reads the sign-off queue", async () => {
    h.getInductionForMember.mockResolvedValue(inductionRecord(MEMBER_ID));
    h.listInductionsAwaitingSignOff.mockResolvedValue([]);
    const { connection, browser } = await expectActionContract({
      actionId: "get_my_induction",
      handler: getOwnInduction,
    });
    expect(h.getInductionForMember).toHaveBeenCalledWith(MEMBER_ID);
    // Once, for the browser: a connection is never a signer.
    expect(h.listInductionsAwaitingSignOff).toHaveBeenCalledTimes(1);
    expect(connection).toMatchObject({
      own: {
        status: "IN_PROGRESS",
        signOffs: [{ signerName: "Nora Nominator", signerRole: "NOMINATOR" }],
        assignedSigners: [{ firstName: "Nigel", lastName: "Nominator" }],
      },
    });
    for (const text of PRIVATE_INDUCTION_TEXT) expect(JSON.stringify(connection)).not.toContain(text);
    expect(browser).toMatchObject({ signer: { isAdmin: true, isHutLeader: true }, own: { finalComments: "Private final comments" } });
  });
});

describe("get_induction", () => {
  it("answers with one of the member's own inductions", async () => {
    h.getInductionById.mockResolvedValue(inductionRecord(MEMBER_ID));
    const { connection } = await expectActionContract({
      actionId: "get_induction",
      handler: getInduction,
      args: { id: `induction-${MEMBER_ID}` },
    });
    expect(connection).toMatchObject({ induction: { id: `induction-${MEMBER_ID}`, status: "IN_PROGRESS" } });
  });

  it("answers a connection Not Found for another member's induction, which the officer may open on the website", async () => {
    h.getInductionById.mockResolvedValue(inductionRecord("member-2"));
    const context = { params: Promise.resolve({ id: "induction-member-2" }) };
    const viaConnection = await getInduction(asConnection("/api/inductions/induction-member-2"), context);
    expect(viaConnection.status).toBe(404);
    const viaBrowser = await getInduction(
      new NextRequest("https://club.example.test/api/inductions/induction-member-2"),
      { params: Promise.resolve({ id: "induction-member-2" }) },
    );
    expect(viaBrowser.status).toBe(200);
  });
});

const WORK_PARTY = {
  id: "wp-1",
  name: "Spring working bee",
  description: "Paint the deck",
  startDate: "2026-07-03",
  endDate: "2026-07-05",
  discountPercent: 50,
  lodgeId: "lodge-a",
  lodgeName: "Lodge A",
  join: { checkIn: "2026-07-03", checkOut: "2026-07-06" },
};

describe("list_work_parties", () => {
  it("answers with the dashboard card's upcoming work parties", async () => {
    h.listUpcomingMemberWorkParties.mockResolvedValue([WORK_PARTY]);
    const { connection, browser } = await expectActionContract({
      actionId: "list_work_parties",
      handler: listWorkParties,
    });
    expect(connection).toEqual({ workParties: [WORK_PARTY] });
    expect(browser).toEqual(connection);
  });

  it("answers Not Found to an account that is not a member, as the work party page does", async () => {
    h.user = { ...(h.user as object), accessRoles: ["ADMIN"] };
    const response = await listWorkParties(asConnection("/api/work-parties"));
    expect(response.status).toBe(404);
    expect(h.listUpcomingMemberWorkParties).not.toHaveBeenCalled();
  });
});

describe("get_work_party", () => {
  it("answers with one open work party", async () => {
    h.findMemberWorkParty.mockResolvedValue(WORK_PARTY);
    const { connection } = await expectActionContract({
      actionId: "get_work_party",
      handler: getWorkParty,
      args: { id: "wp-1" },
    });
    expect(connection).toEqual({ workParty: WORK_PARTY });
  });
});

describe("find_work_parties_for_stay", () => {
  it("answers with the work parties overlapping the stay, never the internal promo code", async () => {
    h.findActiveWorkPartyEventsForRange.mockResolvedValue([
      {
        id: "wp-1",
        name: "Spring working bee",
        description: "Paint the deck",
        startDate: new Date("2026-07-03T00:00:00.000Z"),
        endDate: new Date("2026-07-05T00:00:00.000Z"),
        discountPercent: 50,
        promoCode: "INTERNAL-WP-CODE",
        lodge: { name: "Lodge A" },
      },
    ]);
    const { connection, browser } = await expectActionContract({
      actionId: "find_work_parties_for_stay",
      handler: findWorkPartiesForStay,
      args: { checkIn: "2026-07-03", checkOut: "2026-07-05" },
    });
    expect(connection).toMatchObject({ events: [{ id: "wp-1", lodgeName: "Lodge A" }] });
    expect(JSON.stringify(connection)).not.toContain("INTERNAL-WP-CODE");
    expect(browser).toEqual(connection);
  });
});

describe("get_maintenance_report_form", () => {
  it("answers with the questions and lodges, without the photo setting", async () => {
    h.loadActiveMaintenanceQuestions.mockResolvedValue([
      { id: "q-1", label: "Where is it?", helpText: null, type: "SHORT_TEXT", required: true, choices: [], sortOrder: 0 },
    ]);
    h.prisma.lodge.findMany.mockResolvedValue([{ id: "lodge-a", name: "Lodge A", isDefault: true }]);
    const { connection, browser } = await expectActionContract({
      actionId: "get_maintenance_report_form",
      handler: getMaintenanceForm,
    });
    expect(connection).toMatchObject({ lodges: [{ id: "lodge-a" }], questions: [{ id: "q-1" }] });
    expect(browser).toMatchObject({ photosEnabled: true });
  });
});

describe("report_maintenance_issue", () => {
  beforeEach(() => {
    h.loadActiveMaintenanceQuestions.mockResolvedValue([]);
    h.prisma.lodge.findFirst.mockResolvedValue({ id: "lodge-a", name: "Lodge A" });
    h.prisma.member.findUnique.mockResolvedValue({ firstName: "Olive", lastName: "Officer", email: "olive@club.test" });
    h.createMaintenanceReport.mockResolvedValue({ id: "report-1", answerCount: 1, hasPhoto: false });
  });

  it("files the member's report without a photo and answers with its id", async () => {
    const { connection } = await expectActionContract({
      actionId: "report_maintenance_issue",
      handler: submitMaintenanceReport,
      args: { lodgeId: "lodge-a", summary: "Heater in room 2 is cold", answers: [{ questionId: "q-1", value: "Room 2" }] },
    });
    expect(connection).toEqual({ id: "report-1" });
    expect(h.createMaintenanceReport.mock.calls[0]?.[0]).toMatchObject({
      source: "MEMBER_PORTAL",
      memberId: MEMBER_ID,
      photoDataUrl: null,
    });
  });

  it("refuses a connection that sends a photo, and files nothing", async () => {
    const response = await submitMaintenanceReport(
      asConnection("/api/maintenance-reports", {
        method: "POST",
        body: { lodgeId: "lodge-a", summary: "Cold heater", photoDataUrl: "data:image/png;base64,AAAA" },
      }),
    );
    expect(response.status).toBe(400);
    expect(h.createMaintenanceReport).not.toHaveBeenCalled();
  });
});
