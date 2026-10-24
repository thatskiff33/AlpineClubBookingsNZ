import { after, NextRequest, NextResponse } from "next/server";

import { runMirrorSync, SERVERNZ_PUSH_SECRET_KEY } from "@/lib/club-post-mirror";
import { getIntegrationCredentialValue } from "@/lib/integration-credentials";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { SERVER_VERSION_MISMATCH_CODE } from "@/lib/servernz-api-version";
import {
  SERVERNZ_SIGNATURE_HEADER,
  SERVERNZ_TIMESTAMP_HEADER,
  verifyServerNzSignature,
} from "@/lib/servernz-signature";
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
 * to close the replay window — `verifyServerNzSignature`, shared with the
 * availability route (#62).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

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

  // A push body is a JSON object. The free-beds question signs a newline-
  // separated text with the same secret, so a captured, still-fresh question
  // would verify here and ring the doorbell once; refusing anything that is
  // not an object BEFORE the signature closes that replay in both directions.
  if (!body.trimStart().startsWith("{")) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const verified = verifyServerNzSignature({
    secret,
    timestamp: request.headers.get(SERVERNZ_TIMESTAMP_HEADER) ?? "",
    signature: request.headers.get(SERVERNZ_SIGNATURE_HEADER) ?? "",
    // The raw body: JSON, so it can never equal another route's signed text.
    signedText: body,
  });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }

  // Verified. The body's content is deliberately NOT parsed for instructions —
  // whatever it says, the action is the same: pull the authenticated feed.
  // Scheduled after the response so the server's delivery worker gets its 200
  // without waiting for a full sync pass; the pass's single-flight claim makes
  // a doorbell ringing during a poll harmless.
  //
  // A version pause (#49) changes nothing here on purpose: the signature is
  // still verified, the answer is still a plain 200 (the server retries a
  // failure with backoff, and a club mid-upgrade should not be hammered), and
  // the pull inside `runMirrorSync` is what declines - logged at info, since it
  // is expected rather than a fault. Nothing in the body is acted on either way.
  after(async () => {
    try {
      const result = await runMirrorSync();
      if (!result.skipped) {
        logger.info({ ...result }, "Mirror sync triggered by push");
      } else if (result.skipped === SERVER_VERSION_MISMATCH_CODE) {
        logger.info(
          { skipped: result.skipped },
          "Push received but the mirror sync is paused: central server API version differs",
        );
      }
    } catch (error) {
      // Polling carries the change regardless; the push only bought latency.
      logger.error({ err: error }, "Push-triggered mirror sync failed");
    }
  });

  return NextResponse.json({ ok: true });
}
