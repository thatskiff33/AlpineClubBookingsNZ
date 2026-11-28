/**
 * What `GET /api/admin/health` redacts for an AI app connection (ALP-724).
 * The officer's screen shows provider and transport errors whole; a
 * connection is read by a model, so it gets them through the redactor the
 * backup run errors use.
 */
import type { getExhaustedEmailFailureReviewQueue } from "@/lib/email-failure-review";
import type { DetailedHealthReport } from "@/lib/health-check";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";

/**
 * A failed check's error can be a provider or driver message naming a host,
 * an account or a key fragment. The officer's screen shows it whole; an AI app
 * gets it through the redactor the backup run errors use (ALP-724).
 */
export function withRedactedCheckErrors(report: DetailedHealthReport): DetailedHealthReport {
  const checks = Object.fromEntries(
    Object.entries(report.checks).map(([name, check]) => [
      name,
      check?.error ? { ...check, error: redactSensitiveText(check.error) } : check,
    ]),
  ) as DetailedHealthReport["checks"];
  return { ...report, checks };
}

type EmailFailureQueue = Awaited<ReturnType<typeof getExhaustedEmailFailureReviewQueue>>;

/** A failed email's `errorMessage` is the raw transport error: redacted as above. */
export function withRedactedFailureErrors(queue: EmailFailureQueue): EmailFailureQueue {
  return {
    ...queue,
    failures: queue.failures.map((failure) =>
      failure.errorMessage ? { ...failure, errorMessage: redactSensitiveText(failure.errorMessage) } : failure,
    ),
  };
}
