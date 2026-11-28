import { describe, expect, it, vi } from "vitest";

// #5469: the SES adapter turns a notification into the one neutral event the
// rule acts on. Pure: nothing here touches the database.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { sesNotificationToDeliveryFeedback } from "@/lib/email/ses-feedback";

const MAIL = {
  messageId: " 0100018C-SES-ASSIGNED-000000 ",
  destination: ["fallback@example.test"],
  headers: [
    { name: "From", value: "Club <club@example.test>" },
    { name: "message-id", value: "<sent-1@club.example.test>" },
  ],
  commonHeaders: { messageId: " <sent-1@club.example.test>" },
};

const bounce = (bounceType: string | undefined) => ({
  notificationType: "Bounce",
  mail: MAIL,
  bounce: {
    ...(bounceType === undefined ? {} : { bounceType }),
    bounceSubType: "General",
    bouncedRecipients: [{ emailAddress: "Member@Example.test" }],
    feedbackId: " fb-1 ",
  },
});

describe("the SES adapter's neutral event (#5469)", () => {
  it("MUTATION: a Permanent bounce is a permanent bounce, with every id the rule can match", () => {
    expect(sesNotificationToDeliveryFeedback(bounce("Permanent"))).toEqual({
      service: "aws-ses",
      kind: "permanent-bounce",
      recipients: ["Member@Example.test"],
      providerMessageId: "0100018c-ses-assigned-000000",
      sentMessageIds: [" <sent-1@club.example.test>", "<sent-1@club.example.test>"],
      reportId: "fb-1",
      providerDetail: { bounceType: "Permanent", bounceSubType: "General", complaintFeedbackType: null },
    });
  });

  it.each([["Transient"], ["Undetermined"], [undefined]])(
    "MUTATION: a bounce of type %s is a temporary bounce, as the suppression rule has always read it",
    (bounceType) => {
      expect(sesNotificationToDeliveryFeedback(bounce(bounceType))).toMatchObject({
        kind: "temporary-bounce",
        providerDetail: { bounceType: bounceType ?? null },
      });
    },
  );

  it("a complaint carries its own feedback id and labels", () => {
    expect(
      sesNotificationToDeliveryFeedback({
        notificationType: "Complaint",
        mail: { messageId: "0100-c-000000", destination: ["member@example.test"] },
        complaint: { complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: "member@example.test" }], feedbackId: "fb-c" },
      }),
    ).toEqual({
      service: "aws-ses",
      kind: "complaint",
      complaintType: "abuse",
      recipients: ["member@example.test"],
      providerMessageId: "0100-c-000000",
      sentMessageIds: [],
      reportId: "fb-c",
      providerDetail: { bounceType: null, bounceSubType: null, complaintFeedbackType: "abuse" },
    });
  });

  it("MUTATION: a 'not spam' report is its own kind, not a complaint (D5)", () => {
    expect(
      sesNotificationToDeliveryFeedback({
        notificationType: "Complaint",
        mail: { messageId: "0100-c-000000" },
        complaint: { complaintFeedbackType: "Not-Spam", complainedRecipients: [{ emailAddress: "member@example.test" }] },
      }),
    ).toEqual(expect.objectContaining({ kind: "not-spam-report" }));
    expect(
      sesNotificationToDeliveryFeedback({
        notificationType: "Complaint",
        complaint: { complaintFeedbackType: "not-spam", complainedRecipients: [{ emailAddress: "member@example.test" }] },
      }),
    ).not.toHaveProperty("complaintType");
  });

  it.each([
    ["fraud", "fraud"],
    ["virus", "virus"],
    ["auth-failure", "auth-failure"],
    ["other", "other"],
    ["something-new", "unrecognised"],
    [undefined, "not-given"],
    ["  ", "not-given"],
  ])("MUTATION: a complaint of type %s is a complaint of type %s", (feedbackType, complaintType) => {
    expect(
      sesNotificationToDeliveryFeedback({
        notificationType: "Complaint",
        mail: { messageId: "0100-c-000000" },
        complaint: { ...(feedbackType ? { complaintFeedbackType: feedbackType } : {}), complainedRecipients: [{ emailAddress: "m@example.test" }] },
      }),
    ).toMatchObject({ kind: "complaint", complaintType });
  });

  it("reads a notification wrapped in an SNS envelope, and falls back to the destination for recipients", () => {
    const event = sesNotificationToDeliveryFeedback({
      Type: "Notification",
      Message: JSON.stringify({ notificationType: "Complaint", mail: { destination: ["only@example.test"] }, complaint: {} }),
    });
    expect(event).toMatchObject({ kind: "complaint", recipients: ["only@example.test"], providerMessageId: null, reportId: null });
  });

  it.each([
    ["a delivery notification", { notificationType: "Delivery", mail: MAIL }],
    ["no recipients", { notificationType: "Bounce", mail: { messageId: "x" }, bounce: { bounceType: "Permanent" } }],
    ["a malformed envelope", { Type: "Notification", Message: "{not json" }],
    ["not an object", "Bounce"],
  ])("returns null for %s", (_label, payload) => {
    expect(sesNotificationToDeliveryFeedback(payload)).toBeNull();
  });
});
