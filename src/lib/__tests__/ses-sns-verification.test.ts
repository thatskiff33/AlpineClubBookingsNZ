import { createSign, generateKeyPairSync } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSnsSigningString,
  type SnsWebhookEnvelope,
  verifySnsWebhookMessage,
} from "@/lib/ses-sns";

const TOPIC_ARN = "arn:aws:sns:ap-southeast-2:123456789012:ses-feedback";
const OTHER_TOPIC_ARN =
  "arn:aws:sns:ap-southeast-2:123456789012:other-topic";

function signedEnvelope(topicArn = TOPIC_ARN) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const envelope: SnsWebhookEnvelope = {
    Type: "Notification",
    MessageId: "sns-message-1",
    TopicArn: topicArn,
    Message: JSON.stringify({
      notificationType: "Bounce",
      mail: { messageId: "ses-message-1" },
      bounce: { bouncedRecipients: [{ emailAddress: "member@example.com" }] },
    }),
    Timestamp: "2026-05-09T00:00:00.000Z",
    SignatureVersion: "2",
    Signature: "",
    SigningCertURL:
      "https://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-test.pem",
  };

  const signer = createSign("RSA-SHA256");
  signer.update(buildSnsSigningString(envelope), "utf8");
  envelope.Signature = signer.sign(privateKey, "base64");

  return {
    envelope,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

describe("verifySnsWebhookMessage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects signed SNS messages when SES_SNS_TOPIC_ARN is missing", async () => {
    vi.stubEnv("SES_SNS_TOPIC_ARN", "");
    const { envelope } = signedEnvelope();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await verifySnsWebhookMessage(envelope, fetchImpl);

    expect(result).toEqual({
      ok: false,
      error: "SES_SNS_TOPIC_ARN is required",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects signed SNS messages from an unapproved topic ARN", async () => {
    vi.stubEnv("SES_SNS_TOPIC_ARN", TOPIC_ARN);
    const { envelope } = signedEnvelope(OTHER_TOPIC_ARN);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await verifySnsWebhookMessage(envelope, fetchImpl);

    expect(result).toEqual({
      ok: false,
      error: "SNS topic ARN is not allowed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a valid signature from the configured topic ARN", async () => {
    vi.stubEnv("SES_SNS_TOPIC_ARN", TOPIC_ARN);
    const { envelope, publicKeyPem } = signedEnvelope();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => publicKeyPem,
    }) as unknown as typeof fetch;

    const result = await verifySnsWebhookMessage(envelope, fetchImpl);

    expect(result).toEqual({ ok: true, topicArnConfigured: true });
    expect(fetchImpl).toHaveBeenCalledWith(envelope.SigningCertURL, {
      cache: "no-store",
    });
  });
});
