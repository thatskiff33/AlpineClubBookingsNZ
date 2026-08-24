import { createHmac, timingSafeEqual } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";

import { runMirrorSync, SERVERNZ_PUSH_SECRET_KEY } from "@/lib/club-post-mirror";
import { getIntegrationCredentialValue } from "@/lib/integration-credentials";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  isWebhookBodyInvalidContentLengthError,
  isWebhookBodyTooLargeError,
  readBoundedWebhookText,
} from "@/lib/webhook-body";

/**
 * The central server pushes here when a shared post changes (epic #2992).
 *
 * THE PUSH IS A DOORBELL, NOT A DELIVERY. The body carries an event name and a
 * post id and is otherwise ignored: everything this install stores comes from
 * its own authenticated pull of `/api/v1/feed/sync`. That is what makes the
 * verification below sufficient rather than merely necessary — even a forged
 * request that somehow passed it could only make this install pull the feed it
 * was going to pull anyway.
 *
 * Unauthenticated by nature (the central server holds no session here), so the
 * request proves itself: an HMAC over `${timestamp}.${body}` with the secret
 * issued at registration, compared in constant time, with the timestamp bounded
 * to close the replay window.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Clock skew allowed between the central server and this install. Five
 * minutes, the conventional webhook tolerance: enough for real clock drift,
 * small enough that a captured request is useless the same afternoon.
 */
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export async function POST(request: NextRequest) {
  // 200 for "not participating" rather than 404: the central server retries
  // failures with backoff, and a club that has switched the module off since
  // registering would otherwise be hammered with retries for deliveries it has
  // no intention of acting on.
  const modules = await loadEffectiveModuleFlags();
  if (modules.commsPortal !== true) {
    return NextResponse.json({ ok: true, ignored: "module-off" });
  }

  const secret = await getIntegrationCredentialValue(
    "servernz",
    SERVERNZ_PUSH_SECRET_KEY,
  );
  if (!secret) {
    // No secret means this install never registered, so nothing can verify.
    // 401 rather than 200: an unverifiable push should read as a failure on
    // the server's side, because it IS one — its registration outlived the
    // secret here (a config transfer, a credential wipe) and its operator
    // should see the deliveries failing.
    return NextResponse.json({ error: "Not registered" }, { status: 401 });
  }

  let body: string;
  try {
    body = await readBoundedWebhookText(request, MAX_BODY_BYTES);
  } catch (error) {
    if (
      isWebhookBodyTooLargeError(error) ||
      isWebhookBodyInvalidContentLengthError(error)
    ) {
      return NextResponse.json({ error: "Body too large" }, { status: 413 });
    }
    throw error;
  }

  const timestamp = request.headers.get("x-acs-timestamp") ?? "";
  const signature = request.headers.get("x-acs-signature") ?? "";

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return NextResponse.json({ error: "Invalid timestamp" }, { status: 401 });
  }
  if (Math.abs(Date.now() - sentAt) > TIMESTAMP_TOLERANCE_MS) {
    // Replay protection. The signature covers the timestamp, so an attacker
    // cannot refresh a captured request without the secret.
    return NextResponse.json({ error: "Timestamp out of range" }, { status: 401 });
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Verified. The body's content is deliberately NOT parsed for instructions —
  // whatever it says, the action is the same: pull the authenticated feed.
  // Scheduled after the response so the server's delivery worker gets its 200
  // without waiting for a full sync pass; the pass's single-flight claim makes
  // a doorbell ringing during a poll harmless.
  after(async () => {
    try {
      const result = await runMirrorSync();
      if (!result.skipped) {
        logger.info({ ...result }, "Mirror sync triggered by push");
      }
    } catch (error) {
      // Polling carries the change regardless; the push only bought latency.
      logger.error({ err: error }, "Push-triggered mirror sync failed");
    }
  });

  return NextResponse.json({ ok: true });
}
