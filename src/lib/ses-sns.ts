import { createVerify } from "crypto";

export type SnsWebhookEnvelope = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};

export type SnsVerificationResult =
  | { ok: true; topicArnConfigured: boolean }
  | { ok: false; error: string };

const SNS_CERT_HOST_REGEX = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const UNSAFE_MISSING_TOPIC_OVERRIDE = "SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN";
// Issue #815: SNS SignatureVersion 1 uses SHA1, which is no longer acceptable.
// AWS supports SignatureVersion 2 (SHA256) and it can be enabled per topic. We
// require v2 by default and only fall back to SHA1 when an operator explicitly
// opts in during a topic migration.
const ALLOW_LEGACY_SHA1_OVERRIDE = "SES_SNS_ALLOW_SIGNATURE_V1";

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseSnsWebhookEnvelope(payload: unknown): SnsWebhookEnvelope | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Partial<SnsWebhookEnvelope>;
  const required = [
    candidate.Type,
    candidate.MessageId,
    candidate.TopicArn,
    candidate.Message,
    candidate.Timestamp,
    candidate.SignatureVersion,
    candidate.Signature,
    candidate.SigningCertURL,
  ];

  if (!required.every(isString)) {
    return null;
  }

  return {
    Type: candidate.Type!,
    MessageId: candidate.MessageId!,
    TopicArn: candidate.TopicArn!,
    Message: candidate.Message!,
    Timestamp: candidate.Timestamp!,
    SignatureVersion: candidate.SignatureVersion!,
    Signature: candidate.Signature!,
    SigningCertURL: candidate.SigningCertURL!,
    Subject: candidate.Subject,
    SubscribeURL: candidate.SubscribeURL,
    Token: candidate.Token,
  };
}

function isTrustedSnsCertificateUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      SNS_CERT_HOST_REGEX.test(url.hostname) &&
      url.pathname.endsWith(".pem")
    );
  } catch {
    return false;
  }
}

function appendSigningField(
  lines: string[],
  key: string,
  value: string | undefined
) {
  if (value === undefined) {
    return;
  }
  lines.push(key, value);
}

export function buildSnsSigningString(envelope: SnsWebhookEnvelope) {
  const lines: string[] = [];

  if (envelope.Type === "Notification") {
    appendSigningField(lines, "Message", envelope.Message);
    appendSigningField(lines, "MessageId", envelope.MessageId);
    appendSigningField(lines, "Subject", envelope.Subject);
    appendSigningField(lines, "Timestamp", envelope.Timestamp);
    appendSigningField(lines, "TopicArn", envelope.TopicArn);
    appendSigningField(lines, "Type", envelope.Type);
  } else {
    appendSigningField(lines, "Message", envelope.Message);
    appendSigningField(lines, "MessageId", envelope.MessageId);
    appendSigningField(lines, "SubscribeURL", envelope.SubscribeURL);
    appendSigningField(lines, "Timestamp", envelope.Timestamp);
    appendSigningField(lines, "Token", envelope.Token);
    appendSigningField(lines, "TopicArn", envelope.TopicArn);
    appendSigningField(lines, "Type", envelope.Type);
  }

  return `${lines.join("\n")}\n`;
}

async function fetchCertificate(
  signingCertUrl: string,
  fetchImpl: typeof fetch
) {
  const response = await fetchImpl(signingCertUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`SNS signing certificate fetch failed: ${response.status}`);
  }
  return response.text();
}

function allowsUnsafeMissingTopicArn() {
  const value = process.env[UNSAFE_MISSING_TOPIC_OVERRIDE]?.trim().toLowerCase();
  return (
    process.env.NODE_ENV !== "production" &&
    (value === "1" || value === "true" || value === "yes")
  );
}

function allowsLegacySha1Signature() {
  const value = process.env[ALLOW_LEGACY_SHA1_OVERRIDE]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export async function verifySnsWebhookMessage(
  envelope: SnsWebhookEnvelope,
  fetchImpl: typeof fetch = fetch
): Promise<SnsVerificationResult> {
  const expectedTopicArn = process.env.SES_SNS_TOPIC_ARN?.trim();
  if (!expectedTopicArn && !allowsUnsafeMissingTopicArn()) {
    return { ok: false, error: "SES_SNS_TOPIC_ARN is required" };
  }

  if (expectedTopicArn && envelope.TopicArn !== expectedTopicArn) {
    return { ok: false, error: "SNS topic ARN is not allowed" };
  }

  if (!isTrustedSnsCertificateUrl(envelope.SigningCertURL)) {
    return { ok: false, error: "Untrusted SNS signing certificate URL" };
  }

  const algorithm =
    envelope.SignatureVersion === "2"
      ? "RSA-SHA256"
      : envelope.SignatureVersion === "1" && allowsLegacySha1Signature()
        ? "RSA-SHA1"
        : null;

  if (!algorithm) {
    return {
      ok: false,
      error:
        envelope.SignatureVersion === "1"
          ? "SNS SignatureVersion 1 (SHA1) is rejected; enable SignatureVersion 2 on the SNS topic, or set SES_SNS_ALLOW_SIGNATURE_V1 to permit legacy SHA1 during migration"
          : "Unsupported SNS signature version",
    };
  }

  try {
    const certificate = await fetchCertificate(envelope.SigningCertURL, fetchImpl);
    const verifier = createVerify(algorithm);
    verifier.update(buildSnsSigningString(envelope), "utf8");

    if (!verifier.verify(certificate, envelope.Signature, "base64")) {
      return { ok: false, error: "SNS signature verification failed" };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "SNS verification failed",
    };
  }

  return { ok: true, topicArnConfigured: Boolean(expectedTopicArn) };
}
