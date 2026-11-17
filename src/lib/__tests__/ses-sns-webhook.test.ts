import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockProcessedWebhookCreate,
  mockProcessedWebhookDeleteMany,
  mockProcessedWebhookFindFirst,
  mockProcessedWebhookUpdateMany,
  mockVerifySnsWebhookMessage,
  mockIngestSesSnsEmailFeedback,
  mockRecordWebhookLog,
} = vi.hoisted(() => ({
  mockProcessedWebhookCreate: vi.fn(),
  mockProcessedWebhookDeleteMany: vi.fn(),
  mockProcessedWebhookFindFirst: vi.fn(),
  mockProcessedWebhookUpdateMany: vi.fn(),
  mockVerifySnsWebhookMessage: vi.fn(),
  mockIngestSesSnsEmailFeedback: vi.fn(),
  mockRecordWebhookLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    processedWebhookEvent: {
      create: (...args: unknown[]) => mockProcessedWebhookCreate(...args),
      deleteMany: (...args: unknown[]) => mockProcessedWebhookDeleteMany(...args),
      findFirst: (...args: unknown[]) => mockProcessedWebhookFindFirst(...args),
      updateMany: (...args: unknown[]) => mockProcessedWebhookUpdateMany(...args),
    },
  },
}));

vi.mock("@/lib/ses-sns", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/ses-sns");
  return {
    ...actual,
    verifySnsWebhookMessage: (...args: unknown[]) =>
      mockVerifySnsWebhookMessage(...args),
  };
});

vi.mock("@/lib/email", () => ({
  ingestSesSnsEmailFeedback: (...args: unknown[]) =>
    mockIngestSesSnsEmailFeedback(...args),
}));

vi.mock("@/lib/webhook-log", () => ({
  recordWebhookLog: (...args: unknown[]) => mockRecordWebhookLog(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function snsEnvelope(message: Record<string, unknown> = {}) {
  return {
    Type: "Notification",
    MessageId: "sns-message-1",
    TopicArn: "arn:aws:sns:ap-southeast-2:123456789012:ses-feedback",
    Message: JSON.stringify({
      notificationType: "Complaint",
      mail: { messageId: "ses-message-1" },
      complaint: {
        complainedRecipients: [{ emailAddress: "member@example.com" }],
      },
      ...message,
    }),
    Timestamp: "2026-05-09T00:00:00.000Z",
    SignatureVersion: "2",
    Signature: "test-signature",
    SigningCertURL:
      "https://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-test.pem",
  };
}

function makeRequest(payload: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/webhooks/ses-sns", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

describe("SES/SNS webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 1 });
    mockProcessedWebhookFindFirst.mockResolvedValue(null);
    mockProcessedWebhookUpdateMany.mockResolvedValue({ count: 1 });
    mockVerifySnsWebhookMessage.mockResolvedValue({
      ok: true,
      topicArnConfigured: true,
    });
    mockIngestSesSnsEmailFeedback.mockResolvedValue({
      handled: true,
      notificationType: "complaint",
      recipients: ["member@example.com"],
      suppressionsProcessed: 1,
      suppressionsActive: 1,
    });
  });

  it("rejects unauthenticated SNS payloads before ingestion", async () => {
    mockVerifySnsWebhookMessage.mockResolvedValue({
      ok: false,
      error: "SNS signature verification failed",
    });

    const { POST } = await import("@/app/api/webhooks/ses-sns/route");
    const response = await POST(makeRequest(snsEnvelope()));

    expect(response.status).toBe(401);
    expect(mockProcessedWebhookCreate).not.toHaveBeenCalled();
    expect(mockIngestSesSnsEmailFeedback).not.toHaveBeenCalled();
    expect(mockRecordWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "ses-sns",
        status: "failure",
      })
    );
  });

  it("rejects oversized SNS payloads before signature verification", async () => {
    const { POST } = await import("@/app/api/webhooks/ses-sns/route");
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/ses-sns", {
        method: "POST",
        headers: { "content-length": String(256 * 1024 + 1) },
        body: "{}",
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Webhook payload too large",
    });
    expect(mockVerifySnsWebhookMessage).not.toHaveBeenCalled();
    expect(mockIngestSesSnsEmailFeedback).not.toHaveBeenCalled();
    expect(mockRecordWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "ses-sns",
        status: "failure",
        error: "Payload too large",
      })
    );
  });

  it("claims and ingests verified SES feedback notifications", async () => {
    const payload = snsEnvelope();

    const { POST } = await import("@/app/api/webhooks/ses-sns/route");
    const response = await POST(makeRequest(payload));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      received: true,
      handled: true,
      notificationType: "complaint",
      suppressionsProcessed: 1,
    });
    expect(mockProcessedWebhookCreate).toHaveBeenCalledWith({
      data: {
        eventId: "sns-message-1",
        source: "ses-sns",
        eventType: "Notification",
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now()),
      },
    });
    expect(mockIngestSesSnsEmailFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ MessageId: "sns-message-1" })
    );
    // INV-INT-039: the claim is completed, fenced on this attempt's lease
    // token, only after the feedback was recorded.
    expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith({
      where: {
        source: "ses-sns",
        eventId: "sns-message-1",
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now()),
      },
      data: { status: "COMPLETED", processedAt: expect.any(Date) },
    });
    expect(
      mockIngestSesSnsEmailFeedback.mock.invocationCallOrder[0]
    ).toBeLessThan(mockProcessedWebhookUpdateMany.mock.invocationCallOrder[0]);
    expect(mockRecordWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "ses-sns",
        eventType: "ses.complaint",
        eventId: "sns-message-1",
        status: "success",
      })
    );
  });

  it("deduplicates repeated SNS notifications whose claim was completed", async () => {
    mockProcessedWebhookCreate.mockRejectedValueOnce({ code: "P2002" });
    mockProcessedWebhookFindFirst.mockResolvedValueOnce({
      status: "COMPLETED",
      processingStartedAt: new Date(Date.now() - 60 * 60_000),
    });

    const { POST } = await import("@/app/api/webhooks/ses-sns/route");
    const response = await POST(makeRequest(snsEnvelope()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ received: true, duplicate: true });
    expect(mockIngestSesSnsEmailFeedback).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON bodies before signature verification", async () => {
    // Malformed row of the webhook Critical matrix (issue #1133).
    const { POST } = await import("@/app/api/webhooks/ses-sns/route");
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/ses-sns", {
        method: "POST",
        body: "not-json{",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
    expect(mockVerifySnsWebhookMessage).not.toHaveBeenCalled();
    expect(mockIngestSesSnsEmailFeedback).not.toHaveBeenCalled();
  });

  it("rejects JSON payloads that are not SNS envelopes", async () => {
    const { POST } = await import("@/app/api/webhooks/ses-sns/route");
    const response = await POST(makeRequest({ hello: "world" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid SNS envelope",
    });
    expect(mockVerifySnsWebhookMessage).not.toHaveBeenCalled();
    expect(mockIngestSesSnsEmailFeedback).not.toHaveBeenCalled();
  });

  it("releases the idempotency claim when ingestion fails so SNS retries can reprocess", async () => {
    // Exactly-once recovery: a claimed event whose handler dies must release
    // the ProcessedWebhookEvent row, otherwise the SNS redelivery would be
    // treated as a duplicate and the feedback would be lost permanently.
    mockProcessedWebhookCreate.mockResolvedValueOnce({});
    mockIngestSesSnsEmailFeedback.mockRejectedValueOnce(
      new Error("ingest blew up")
    );

    const { POST } = await import("@/app/api/webhooks/ses-sns/route");
    const response = await POST(makeRequest(snsEnvelope()));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to process SES/SNS webhook",
    });
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
      where: {
        eventId: "sns-message-1",
        source: "ses-sns",
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now()),
      },
    });
    expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
  });

  describe("processing lease (INV-INT-039, #4921)", () => {
    it("MUTATION: a redelivery while a sibling's lease is live is never ACKed as a duplicate", async () => {
      mockProcessedWebhookCreate.mockRejectedValueOnce({ code: "P2002" });
      mockProcessedWebhookFindFirst.mockResolvedValueOnce({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 5 * 60_000),
      });

      const { POST } = await import("@/app/api/webhooks/ses-sns/route");
      const response = await POST(makeRequest(snsEnvelope()));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Webhook processing already in progress",
      });
      expect(mockIngestSesSnsEmailFeedback).not.toHaveBeenCalled();
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
      expect(mockProcessedWebhookDeleteMany).not.toHaveBeenCalled();
      expect(mockRecordWebhookLog).toHaveBeenCalledWith(
        expect.objectContaining({ source: "ses-sns", status: "failure" })
      );
    });

    it("takes over a crashed attempt's expired claim and records the feedback once", async () => {
      // The prior attempt claimed 16 minutes ago and died before ingesting or
      // releasing: the old marker made this redelivery a silent duplicate.
      const crashedClaim = new Date(Date.now() - 16 * 60_000);
      mockProcessedWebhookCreate.mockRejectedValueOnce({ code: "P2002" });
      mockProcessedWebhookFindFirst.mockResolvedValueOnce({
        status: "PROCESSING",
        processingStartedAt: crashedClaim,
      });

      const { POST } = await import("@/app/api/webhooks/ses-sns/route");
      const response = await POST(makeRequest(snsEnvelope()));

      expect(response.status).toBe(200);
      expect(mockIngestSesSnsEmailFeedback).toHaveBeenCalledTimes(1);
      // The guarded takeover, then the completion fenced on the new token.
      expect(mockProcessedWebhookUpdateMany).toHaveBeenNthCalledWith(1, {
        where: {
          source: "ses-sns",
          eventId: "sns-message-1",
          status: "PROCESSING",
          processingStartedAt: { lt: new Date(Date.now() - 15 * 60_000) },
        },
        data: { processingStartedAt: new Date(Date.now()), eventType: "Notification" },
      });
      expect(mockProcessedWebhookUpdateMany).toHaveBeenNthCalledWith(2, {
        where: {
          source: "ses-sns",
          eventId: "sns-message-1",
          status: "PROCESSING",
          processingStartedAt: new Date(Date.now()),
        },
        data: { status: "COMPLETED", processedAt: expect.any(Date) },
      });
    });

    it("answers 503 when a racing redelivery wins the takeover", async () => {
      mockProcessedWebhookCreate.mockRejectedValueOnce({ code: "P2002" });
      mockProcessedWebhookFindFirst.mockResolvedValueOnce({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 16 * 60_000),
      });
      mockProcessedWebhookUpdateMany.mockResolvedValueOnce({ count: 0 });

      const { POST } = await import("@/app/api/webhooks/ses-sns/route");
      const response = await POST(makeRequest(snsEnvelope()));

      expect(response.status).toBe(503);
      expect(mockIngestSesSnsEmailFeedback).not.toHaveBeenCalled();
    });
  });
});
