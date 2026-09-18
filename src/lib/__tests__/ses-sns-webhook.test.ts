import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockProcessedWebhookCreate,
  mockProcessedWebhookDeleteMany,
  mockVerifySnsWebhookMessage,
  mockIngestSesSnsEmailFeedback,
  mockRecordWebhookLog,
} = vi.hoisted(() => ({
  mockProcessedWebhookCreate: vi.fn(),
  mockProcessedWebhookDeleteMany: vi.fn(),
  mockVerifySnsWebhookMessage: vi.fn(),
  mockIngestSesSnsEmailFeedback: vi.fn(),
  mockRecordWebhookLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    processedWebhookEvent: {
      create: (...args: unknown[]) => mockProcessedWebhookCreate(...args),
      deleteMany: (...args: unknown[]) => mockProcessedWebhookDeleteMany(...args),
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
      },
    });
    expect(mockIngestSesSnsEmailFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ MessageId: "sns-message-1" })
    );
    expect(mockRecordWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "ses-sns",
        eventType: "ses.complaint",
        eventId: "sns-message-1",
        status: "success",
      })
    );
  });

  it("deduplicates repeated SNS notifications", async () => {
    mockProcessedWebhookCreate.mockRejectedValueOnce({ code: "P2002" });

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
      where: { eventId: "sns-message-1", source: "ses-sns" },
    });
  });
});
