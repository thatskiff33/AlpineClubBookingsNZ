/**
 * N-12: Post-Stay Feedback Request
 * This feature is intentionally disabled. Keep the no-op in place so the
 * scheduled job can continue to run without sending any user emails.
 */
import logger from "@/lib/logger";

export async function sendFeedbackRequests(): Promise<{
  sent: number;
  skippedPreference: number;
  failed: number;
}> {
  logger.info("Post-stay feedback requests are disabled; skipping send");
  return { sent: 0, skippedPreference: 0, failed: 0 };
}
