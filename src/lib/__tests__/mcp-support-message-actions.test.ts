/**
 * ALP-724 (`INV-MCP-006`): the Support area's message actions an officer's AI
 * app connection may run, bar the email templates (their own file): booking
 * message wording, the club's email settings, delivery policies, an officer's
 * alerts, stopped addresses and failed emails. Each route answers the browser
 * as before; the connection gets exactly the action's `returns` fields
 * (`expectActionContract`). Every handler runs twice (connection, then
 * browser), so the mocks answer both runs.
 *
 * What a connection must never be sent here: the lodge's door code (the email
 * settings in force carry it for the emails that print it), the ids of the
 * officers who last saved a setting, a stopped address's provider message id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma = {
    $transaction: vi.fn(),
    bookingMessageOverride: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    emailMessageSetting: { findUnique: vi.fn(), upsert: vi.fn() },
    notificationDeliveryPolicy: { findUnique: vi.fn(), upsert: vi.fn() },
    notificationPreference: { upsert: vi.fn() },
    member: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    prisma,
    requireAdmin: vi.fn(),
    loadBookingMessages: vi.fn(),
    sampleBookingData: vi.fn(),
    loadPersistedSettings: vi.fn(),
    loadSettingsForLodge: vi.fn(),
    listPolicies: vi.fn(),
    telemetry: vi.fn(),
    clearSuppression: vi.fn(),
    logAudit: vi.fn(),
    requeue: vi.fn(),
    markReviewed: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/audit")),
  logAudit: h.logAudit,
}));
vi.mock("@/lib/booking-message-settings", () => ({
  loadEffectiveBookingMessages: h.loadBookingMessages,
  buildSampleBookingMessageData: h.sampleBookingData,
}));
vi.mock("@/lib/email-message-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email-message-settings")),
  loadPersistedEmailMessageSettings: h.loadPersistedSettings,
  loadEmailMessageSettingsForLodge: h.loadSettingsForLodge,
}));
vi.mock("@/lib/notification-delivery-policies", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/notification-delivery-policies")),
  listNotificationDeliveryPolicySettings: h.listPolicies,
}));
vi.mock("@/lib/email-suppression", () => ({
  getEmailDeliverabilityTelemetry: h.telemetry,
  clearEmailSuppression: h.clearSuppression,
}));
vi.mock("@/lib/email-failure-review", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email-failure-review")),
  requeueExhaustedEmailFailure: h.requeue,
  markExhaustedEmailFailureReviewed: h.markReviewed,
}));

import { POST as previewBookingMessage } from "@/app/api/admin/booking-messages/preview/route";
import { POST as resetBookingMessage } from "@/app/api/admin/booking-messages/reset/route";
import { GET as listBookingMessages, PUT as putBookingMessage } from "@/app/api/admin/booking-messages/route";
import { POST as retryFailure } from "@/app/api/admin/email-failures/[id]/retry/route";
import { POST as reviewFailure } from "@/app/api/admin/email-failures/[id]/review/route";
import { GET as getEmailSettings, PUT as putEmailSettings } from "@/app/api/admin/email-settings/route";
import { POST as clearSuppression } from "@/app/api/admin/email-suppressions/[id]/clear/route";
import { GET as listSuppressions } from "@/app/api/admin/email-suppressions/route";
import { GET as listPolicies, PUT as putPolicy } from "@/app/api/admin/notification-delivery-policies/route";
import { PUT as putAlerts } from "@/app/api/admin/notifications/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { BOOKING_MESSAGE_KEYS } from "@/lib/booking-message-definitions";
import { EMAIL_TEMPLATE_DEFINITIONS, isAdminSystemTemplate } from "@/lib/email-message-registry";
import { SUPPORT_MESSAGE_MCP_ACTIONS } from "@/lib/mcp/catalogue/support-messages";

const STAMP = new Date("2026-06-30T00:00:00.000Z");
const MESSAGE_KEY = BOOKING_MESSAGE_KEYS[0];

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: officerMemberSession() });
  h.prisma.$transaction.mockImplementation(async (work: unknown) =>
    typeof work === "function" ? (work as (tx: typeof h.prisma) => unknown)(h.prisma) : Promise.all(work as unknown[]),
  );
  h.prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
});

describe("the message entries", () => {
  it("are officer actions: reads for GET and the previews, destructive otherwise, none core", () => {
    for (const action of SUPPORT_MESSAGE_MCP_ACTIONS) {
      expect(action.summary.startsWith("Officer: "), action.id).toBe(true);
      expect(action.kind, action.id).toBe(action.method === "GET" || action.preview ? "read" : "destructive");
      expect(action.core, action.id).toBe(false);
    }
  });

  it("never names who last saved a setting or a provider message id", () => {
    for (const action of SUPPORT_MESSAGE_MCP_ACTIONS) {
      expect(JSON.stringify(action.returns), action.id).not.toMatch(/ByMemberId|ById|SesMessageId|doorCode/);
    }
  });
});

// ---------------------------------------------------------------------------
// Booking message wording
// ---------------------------------------------------------------------------

describe("booking message wording", () => {
  const override = { id: "override-1", messageKey: MESSAGE_KEY, bodyText: "Pay by card now.", updatedAt: STAMP, updatedByMemberId: "officer-9" };

  it("list_booking_message_wording sends each message with its saved change, not who saved it", async () => {
    h.loadBookingMessages.mockResolvedValue([
      {
        key: MESSAGE_KEY,
        section: "Booking Flow",
        label: "Card payment method",
        description: "Shown next to the card option.",
        defaultBody: "Pay now.",
        bodyText: "Pay by card now.",
        tokens: ["CLUB_NAME"],
        override: { bodyText: "Pay by card now.", updatedAt: STAMP.toISOString(), updatedByMemberId: "officer-9" },
      },
    ]);
    const { connection, browser } = await expectActionContract({
      actionId: "list_booking_message_wording",
      handler: listBookingMessages,
    });
    expect(JSON.stringify(connection)).not.toContain("officer-9");
    expect(JSON.stringify(browser)).toContain("officer-9");
  });

  it("preview_booking_message renders the wording and saves nothing", async () => {
    h.sampleBookingData.mockResolvedValue({ CLUB_NAME: "Example Club" });
    const { connection } = await expectActionContract({
      actionId: "preview_booking_message",
      handler: previewBookingMessage,
      args: { messageKey: MESSAGE_KEY, bodyText: "Welcome to {{CLUB_NAME}}." },
    });
    expect(connection).toMatchObject({ messageKey: MESSAGE_KEY, rendered: "Welcome to Example Club." });
    expect(h.prisma.bookingMessageOverride.upsert).not.toHaveBeenCalled();
  });

  it("update_booking_message saves the wording the app sends", async () => {
    h.prisma.bookingMessageOverride.findUnique.mockResolvedValue(null);
    h.prisma.bookingMessageOverride.upsert.mockResolvedValue(override);
    const { connection } = await expectActionContract({
      actionId: "update_booking_message",
      handler: putBookingMessage,
      args: { messageKey: MESSAGE_KEY, bodyText: "Pay by card now." },
    });
    expect(connection).toEqual({
      override: { messageKey: MESSAGE_KEY, bodyText: "Pay by card now.", updatedAt: STAMP.toISOString() },
    });
  });

  it("reset_booking_message deletes the club's wording", async () => {
    h.prisma.bookingMessageOverride.deleteMany.mockResolvedValue({ count: 1 });
    const { connection } = await expectActionContract({
      actionId: "reset_booking_message",
      handler: resetBookingMessage,
      args: { messageKey: MESSAGE_KEY },
    });
    expect(connection).toEqual({ reset: true });
    expect(h.prisma.bookingMessageOverride.deleteMany).toHaveBeenCalledWith({ where: { messageKey: MESSAGE_KEY } });
  });
});

// ---------------------------------------------------------------------------
// The club's email settings
// ---------------------------------------------------------------------------

describe("get_email_settings and update_email_settings", () => {
  const inForce = {
    clubName: "Example Club",
    bookingsName: "Example Bookings",
    lodgeName: "Example Lodge",
    emailFromName: "Example Club",
    supportEmail: "support@example.test",
    contactEmail: "hello@example.test",
    publicUrl: "https://club.example.test",
    lodgeTravelNote: "Chains required.",
    doorCode: "4321",
  };
  const persisted = {
    clubName: "Example Club",
    bookingsName: null,
    emailFromName: null,
    supportEmail: "support@example.test",
    contactEmail: null,
    publicUrl: null,
    updatedAt: STAMP,
    updatedByMemberId: "officer-9",
  };

  it("never sends the lodge's door code the settings in force carry", async () => {
    h.loadPersistedSettings.mockResolvedValue(persisted);
    h.loadSettingsForLodge.mockResolvedValue(inForce);
    const { connection, browser } = await expectActionContract({
      actionId: "get_email_settings",
      handler: getEmailSettings,
    });
    expect(JSON.stringify(connection)).not.toContain("4321");
    expect(JSON.stringify(browser)).toContain("4321");
  });

  it("saves the fields the app sends, normalising the public address", async () => {
    h.prisma.emailMessageSetting.findUnique.mockResolvedValue(null);
    h.prisma.emailMessageSetting.upsert.mockResolvedValue({ id: "default", ...persisted });
    h.loadSettingsForLodge.mockResolvedValue(inForce);
    const { connection } = await expectActionContract({
      actionId: "update_email_settings",
      handler: putEmailSettings,
      args: { supportEmail: "support@example.test", publicUrl: "https://club.example.test/" },
    });
    expect(JSON.stringify(connection)).not.toContain("4321");
    expect(h.prisma.emailMessageSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ supportEmail: "support@example.test", publicUrl: "https://club.example.test" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Delivery policies and officers' alerts
// ---------------------------------------------------------------------------

describe("delivery policies", () => {
  const editable = EMAIL_TEMPLATE_DEFINITIONS.find(
    (definition) => isAdminSystemTemplate(definition.key) && definition.deliveryEditable,
  )!;

  it("list_notification_delivery_policies sends each policy without who saved it", async () => {
    h.listPolicies.mockResolvedValue({
      policies: [
        {
          templateName: editable.key,
          label: editable.label,
          mode: "content_only",
          defaultMode: "always",
          deliveryEditable: true,
          updatedAt: STAMP.toISOString(),
          updatedByMemberId: "officer-9",
        },
      ],
      stalePolicyCount: 0,
      stalePolicies: [],
    });
    const { connection } = await expectActionContract({
      actionId: "list_notification_delivery_policies",
      handler: listPolicies,
    });
    expect(JSON.stringify(connection)).not.toContain("officer-9");
  });

  it("set_notification_delivery_policy saves the mode for an editable template", async () => {
    h.prisma.notificationDeliveryPolicy.findUnique.mockResolvedValue(null);
    h.prisma.notificationDeliveryPolicy.upsert.mockResolvedValue({
      templateName: editable.key, mode: "DISABLED", updatedAt: STAMP, updatedByMemberId: "officer-1",
    });
    const { connection } = await expectActionContract({
      actionId: "set_notification_delivery_policy",
      handler: putPolicy,
      args: { templateName: editable.key, mode: "disabled" },
    });
    expect(connection).toEqual({ policy: { templateName: editable.key, mode: "DISABLED", updatedAt: STAMP.toISOString() } });
  });
});

describe("update_officer_alerts", () => {
  it("changes another officer's alerts and answers what they will be sent", async () => {
    h.prisma.member.findUnique.mockResolvedValue({
      id: "officer-2",
      firstName: "Rua",
      lastName: "Tane",
      canLogin: true,
      accessRoles: [{ role: "ADMIN" }],
      notificationPreference: null,
    });
    h.prisma.notificationPreference.upsert.mockResolvedValue({ adminDailyDigest: false });
    const { connection } = await expectActionContract({
      actionId: "update_officer_alerts",
      handler: putAlerts,
      args: { memberId: "officer-2", preferences: { adminDailyDigest: false } },
    });
    expect(connection).toMatchObject({ memberId: "officer-2", preferences: { adminDailyDigest: false } });
    expect(h.prisma.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { memberId: "officer-2" }, update: { adminDailyDigest: false } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Stopped addresses and failed emails
// ---------------------------------------------------------------------------

describe("stopped addresses", () => {
  it("list_email_suppressions sends each address without its provider message id", async () => {
    h.telemetry.mockResolvedValue({
      summary: { activeCount: 1, bounceCount: 1, complaintCount: 0, eventsLast24h: 1 },
      suppressions: [
        {
          id: "suppression-1",
          email: "bounced@example.test",
          reason: "BOUNCE",
          eventCount: 2,
          suppressedAt: STAMP.toISOString(),
          lastEventAt: STAMP.toISOString(),
          lastEventType: "Bounce",
          lastBounceType: "Permanent",
          lastBounceSubType: "General",
          lastComplaintFeedbackType: null,
          lastSesMessageId: "ses-message-1",
        },
      ],
    });
    const { connection, browser } = await expectActionContract({
      actionId: "list_email_suppressions",
      handler: listSuppressions,
    });
    expect(JSON.stringify(connection)).not.toContain("ses-message-1");
    expect(JSON.stringify(browser)).toContain("ses-message-1");
  });

  it("clear_email_suppression clears the address with the officer's reason", async () => {
    h.clearSuppression.mockResolvedValue({ id: "suppression-1", email: "bounced@example.test", clearedAt: STAMP });
    const { connection } = await expectActionContract({
      actionId: "clear_email_suppression",
      handler: clearSuppression,
      args: { id: "suppression-1", reason: "Mailbox fixed" },
    });
    expect(connection).toEqual({
      success: true,
      suppression: { id: "suppression-1", email: "bounced@example.test", clearedAt: STAMP.toISOString() },
    });
    expect(h.clearSuppression).toHaveBeenCalledWith({
      id: "suppression-1", clearedById: "officer-1", clearReason: "Mailbox fixed",
    });
  });
});

describe("failed emails", () => {
  it("retry_failed_email hands the email back to the retry job", async () => {
    h.requeue.mockResolvedValue({ id: "email-1", requeued: true });
    const { connection } = await expectActionContract({
      actionId: "retry_failed_email",
      handler: retryFailure,
      args: { id: "email-1" },
    });
    expect(connection).toEqual({ id: "email-1", requeued: true });
    expect(h.requeue).toHaveBeenCalledWith("email-1", { requestedByMemberId: "officer-1" });
  });

  it("dismiss_failed_email marks it reviewed with the reason", async () => {
    h.markReviewed.mockResolvedValue({ id: "email-1", reviewed: true, reason: "Sent by hand" });
    const { connection } = await expectActionContract({
      actionId: "dismiss_failed_email",
      handler: reviewFailure,
      args: { id: "email-1", reason: "Sent by hand" },
    });
    expect(connection).toEqual({ id: "email-1", reviewed: true, reason: "Sent by hand" });
    expect(h.markReviewed).toHaveBeenCalledWith("email-1", { reviewedByMemberId: "officer-1", reason: "Sent by hand" });
  });
});
