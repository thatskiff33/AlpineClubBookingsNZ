/**
 * ALP-718 (`INV-MCP-006`): the club-information actions an AI app connection
 * may run. Each route is public and answers the browser as before; the
 * connection gets exactly the action's `returns` fields
 * (`expectActionContract`), so a field the public page uses but the app does
 * not need, such as a committee member's photo or contact key, stays behind.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getAgeTierSettings: vi.fn(),
  loadPublicBookingMessages: vi.fn(),
  buildBookingMessageGlobalData: vi.fn(),
  fetchWhakapapaCurlData: vi.fn(),
  prisma: {
    committeeAssignment: { findMany: vi.fn() },
    publicContentSettings: { findUnique: vi.fn() },
    whakapapaReportCache: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/age-tier", () => ({ getAgeTierSettings: h.getAgeTierSettings }));
vi.mock("@/lib/booking-message-settings", () => ({
  loadPublicBookingMessages: h.loadPublicBookingMessages,
  buildBookingMessageGlobalData: h.buildBookingMessageGlobalData,
}));
vi.mock("@/lib/whakapapa-report.server", () => ({ fetchWhakapapaCurlData: h.fetchWhakapapaCurlData }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn(async () => null),
  rateLimiters: { skifieldConditions: { id: "skifield-conditions" } },
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import { GET as getAgeGroups } from "@/app/api/age-tier-settings/route";
import { GET as getBookingMessages } from "@/app/api/booking-messages/route";
import { GET as getCommittee } from "@/app/api/committee/route";
import { GET as getSkifieldReport } from "@/app/api/skifield-whakapapa/route";
import { expectActionContract } from "@/lib/__tests__/helpers/mcp-action-contract";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("get_age_groups", () => {
  it("answers with each age group's label, range and subscription rule", async () => {
    const settings = [
      {
        tier: "ADULT",
        minAge: 18,
        maxAge: null,
        label: "Adult",
        subscriptionRequiredForBooking: true,
        familyGroupRequestCreateMemberAllowed: false,
        sortOrder: 1,
      },
    ];
    h.getAgeTierSettings.mockResolvedValue(settings);
    const { connection, browser } = await expectActionContract({ actionId: "get_age_groups", handler: getAgeGroups });
    expect(connection).toEqual({
      settings: [{ tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", subscriptionRequiredForBooking: true }],
    });
    expect(browser).toEqual({ settings });
  });
});

describe("get_booking_messages", () => {
  it("answers with every message and the club values its tokens take", async () => {
    const messages = { paymentInstructions: "Pay {{CLUB_NAME}} by bank transfer.", waitlistNotice: "You are waitlisted." };
    const tokens = {
      CLUB_NAME: "Example Alpine Club",
      CLUB_LODGE_NAME: "Main lodge",
      BASE_URL: "https://club.example.test",
      SUPPORT_EMAIL: "help@club.example.test",
    };
    h.loadPublicBookingMessages.mockResolvedValue(messages);
    h.buildBookingMessageGlobalData.mockResolvedValue(tokens);
    const { connection, browser } = await expectActionContract({
      actionId: "get_booking_messages",
      handler: getBookingMessages,
    });
    expect(connection).toEqual({ messages, tokens });
    expect(browser).toEqual({ messages, tokens });
  });
});

describe("list_committee", () => {
  it("answers with names, roles and descriptions, without photos or contact keys", async () => {
    h.prisma.committeeAssignment.findMany.mockResolvedValue([
      {
        id: "assignment-1",
        blurb: "Runs the lodge.",
        showPhone: true,
        contactable: true,
        committeeRole: { key: "president", name: "President", description: null },
        member: {
          id: "member-9",
          firstName: "Rangi",
          lastName: "Smith",
          phoneCountryCode: "64",
          phoneAreaCode: "21",
          phoneNumber: "5550100",
          photoImageId: "img-1",
          photoUpdatedAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      },
    ]);
    h.prisma.publicContentSettings.findUnique.mockResolvedValue({ committeePhotoDisplay: "AVATAR" });
    const { connection, browser } = await expectActionContract({ actionId: "list_committee", handler: getCommittee });
    expect(connection).toEqual({
      members: [{ name: "Rangi Smith", role: "President", description: "Runs the lodge." }],
    });
    // The public committee page's answer is unchanged, phone and photo included.
    expect(browser).toEqual({
      members: [
        {
          id: "assignment-1",
          role: "President",
          roleKey: "president",
          name: "Rangi Smith",
          phone: "64 21 5550100",
          contactKey: "assignment-1",
          description: "Runs the lodge.",
          photo: { memberId: "member-9", version: "2026-05-01T00:00:00.000Z" },
        },
      ],
      photoDisplay: "AVATAR",
    });
  });
});

describe("get_skifield_report", () => {
  it("answers with the report, saying when it is stale", async () => {
    const report = {
      updated: "2026-07-01T00:00:00.000Z",
      roadStatus: { name: "Bruce Road", status: "Open", wheelRequirements: "None", roadContent: "Clear" },
      facilities: [{ name: "Cafe", status: "Open" }],
      foodAndDrink: [{ name: "Knoll Ridge", status: "Open" }],
      lifts: [{ name: "Sky Waka", status: "Open" }],
      conditions: [
        { name: "Top", temperature: "-2", wind: "Light", snowBase: "120cm", snowfall24h: "5cm", snowfall7d: "20cm" },
      ],
      trails: [
        {
          name: "Happy Valley Area",
          trails: [{ name: "Valley", status: "Open", groomed: true, difficulty: "Easy", size: "Short" }],
        },
      ],
      visibility: { roadStatus: true, lifts: true, facilities: true, foodAndDrink: false, conditions: true, trails: true },
    };
    // An old cache and an upstream that cannot be reached: the stale answer.
    h.prisma.whakapapaReportCache.findUnique.mockResolvedValue({
      source: "whakapapa-report",
      payload: report,
      config: null,
      fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
      frozenUntil: null,
    });
    h.fetchWhakapapaCurlData.mockRejectedValue(new Error("upstream down"));
    const { connection, browser } = await expectActionContract({
      actionId: "get_skifield_report",
      handler: getSkifieldReport,
    });
    expect(connection).toMatchObject({ stale: true, lifts: [{ name: "Sky Waka", status: "Open" }] });
    expect(browser).toEqual(connection);
  });
});
