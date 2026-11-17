import { beforeEach, describe, expect, it, vi } from "vitest";

// INV-INT-039 (#4921): SNS may redeliver a notification whose first attempt
// recorded the feedback but died before completing its claim. The replay must
// not count the same SES feedback twice toward the transient-bounce threshold.
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailSuppression: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      create: mocks.create,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { recordSesEmailFeedback, type SesEmailFeedbackEvent } from "@/lib/email-suppression";

const transientBounce: SesEmailFeedbackEvent = {
  email: "Member@Example.com",
  reason: "BOUNCE",
  eventType: "bounce",
  sesMessageId: "ses-message-1",
  bounceType: "Transient",
  bounceSubType: "MailboxFull",
};

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sup_1",
    email: "member@example.com",
    reason: "BOUNCE",
    eventCount: 1,
    suppressedAt: null,
    clearedAt: null,
    clearedById: null,
    clearReason: null,
    lastEventType: "bounce",
    lastSesMessageId: "ses-message-1",
    ...overrides,
  };
}

describe("recordSesEmailFeedback replay safety", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("MUTATION: a replay of the transient bounce already recorded neither counts nor suppresses", async () => {
    mocks.findUnique.mockResolvedValue(existingRow());

    await expect(recordSesEmailFeedback([transientBounce])).resolves.toEqual({
      processed: 1,
      suppressed: 0,
    });

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("a second transient bounce from a different SES message still suppresses at the threshold", async () => {
    mocks.findUnique.mockResolvedValue(existingRow({ lastSesMessageId: "ses-message-0" }));

    await expect(recordSesEmailFeedback([transientBounce])).resolves.toEqual({
      processed: 1,
      suppressed: 1,
    });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { email: "member@example.com" },
      data: expect.objectContaining({
        eventCount: 2,
        suppressedAt: expect.any(Date),
        lastSesMessageId: "ses-message-1",
      }),
    });
  });

  it("feedback without an SES message id cannot be told apart, so it is counted", async () => {
    mocks.findUnique.mockResolvedValue(existingRow({ lastSesMessageId: null }));

    await recordSesEmailFeedback([{ ...transientBounce, sesMessageId: null }]);

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventCount: 2 }) }),
    );
  });

  it("a complaint on the message that already bounced is a new event", async () => {
    mocks.findUnique.mockResolvedValue(existingRow());

    await recordSesEmailFeedback([
      { email: "member@example.com", reason: "COMPLAINT", eventType: "complaint", sesMessageId: "ses-message-1" },
    ]);

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventCount: 2, reason: "COMPLAINT" }),
      }),
    );
  });

  it("a replay against an address already suppressed still reports it suppressed", async () => {
    mocks.findUnique.mockResolvedValue(
      existingRow({ eventCount: 2, suppressedAt: new Date("2026-06-30T00:00:00.000Z") }),
    );

    await expect(recordSesEmailFeedback([transientBounce])).resolves.toEqual({
      processed: 1,
      suppressed: 1,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
