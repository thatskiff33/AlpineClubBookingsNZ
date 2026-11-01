import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The ONE check that a request came from the Alpine Central Server (INV-INT,
 * INV-SSOT): HMAC-SHA256 with the secret this install was issued when it
 * registered its push target, over `${timestamp}.${signedText}`, compared in
 * constant time, with the timestamp held to a window so a captured request is
 * useless the same afternoon.
 *
 * Two routes call it, and each chooses its own `signedText`:
 *
 *  - the shared-post doorbell (`/api/webhooks/servernz-posts`) signs the raw
 *    request BODY, which is JSON and so always begins with `{`;
 *  - the availability question (`/api/webhooks/servernz-availability`, #62)
 *    signs `availability` + the lodge id and dates, one per line — a value
 *    built from the parsed query rather than the URL, so a proxy re-encoding
 *    the address cannot break it.
 *
 * The two texts can never be equal (one starts `{`, the other `availability`),
 * so a signature captured on one route is refused by the other.
 */

/**
 * Clock skew allowed between the central server and this install. Five
 * minutes, the conventional webhook tolerance: enough for real clock drift,
 * small enough that a captured request is useless the same afternoon.
 */
export const SERVERNZ_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/** The request headers the central server signs with. */
export const SERVERNZ_TIMESTAMP_HEADER = "x-acs-timestamp";
export const SERVERNZ_SIGNATURE_HEADER = "x-acs-signature";

/**
 * What the central server signs when it asks about availability (#62): built
 * from the parsed query, one value per line after the `availability` domain
 * prefix. The central server builds exactly this string.
 */
export function centralAvailabilitySignedText(query: {
  lodgeId: string;
  from: string;
  to: string;
}): string {
  return `availability\n${query.lodgeId}\n${query.from}\n${query.to}`;
}

export type ServerNzSignatureResult =
  | { ok: true }
  | { ok: false; error: "Invalid timestamp" | "Timestamp out of range" | "Invalid signature" };

export function verifyServerNzSignature(input: {
  secret: string;
  /** The `x-acs-timestamp` header as received ("" when absent). */
  timestamp: string;
  /** The `x-acs-signature` header as received ("" when absent). */
  signature: string;
  /** What the route says was signed (see the module comment). */
  signedText: string;
  now?: number;
}): ServerNzSignatureResult {
  // Exactly the push receiver's original rule: a missing header reads as 0,
  // which is finite and then fails the window below.
  const sentAt = Number(input.timestamp);
  if (!Number.isFinite(sentAt)) {
    return { ok: false, error: "Invalid timestamp" };
  }
  if (Math.abs((input.now ?? Date.now()) - sentAt) > SERVERNZ_SIGNATURE_TOLERANCE_MS) {
    // Replay protection. The signature covers the timestamp, so an attacker
    // cannot refresh a captured request without the secret.
    return { ok: false, error: "Timestamp out of range" };
  }

  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.signedText}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signature, "utf8");
  // The length guard first: timingSafeEqual throws on unequal lengths.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "Invalid signature" };
  }
  return { ok: true };
}
