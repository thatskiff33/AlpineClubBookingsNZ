/**
 * What an officer sends to the Finance area's Xero contact reviews: the
 * contact-group and contact-link mismatch panels, the erased-member contact
 * review and the missing-contact census and run (`/api/admin/xero/...`). The
 * routes and their AI app actions read these (ALP-721, `INV-SSOT`). Pure: no
 * server imports, so the catalogue can import it.
 */
import { z } from "zod";

import { CONTACT_GROUP_MISMATCH_LIMIT } from "@/lib/xero-contact-group-mismatch-summary";

/** `GET .../contact-group-mismatches` and `GET .../contact-link-mismatches`: rows listed, 1 to 500. */
export const xeroContactMismatchQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** `POST .../contact-group-mismatches`: how many flagged contacts the Refresh re-reads from Xero. */
export const xeroContactGroupMismatchResyncBodySchema = z.object({
  limit: z.number().int().min(1).max(500).default(CONTACT_GROUP_MISMATCH_LIMIT),
});

/** `POST .../contact-link-mismatches`: how many flagged contacts the Refresh re-reads from Xero. */
export const xeroContactLinkMismatchResyncBodySchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

/** Rows the erased-member contact review lists when no valid `limit` is sent. */
export const DEFAULT_ERASED_CONTACT_ROW_LIMIT = 200;

/** `GET` and `POST .../erased-member-contacts`: rows listed (and checked), 1 to 1000. */
export const erasedMemberContactReviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/**
 * Rows listed per bucket of the missing-contact census when no valid `limit`
 * is sent. The counts are always the full population.
 */
const DEFAULT_MISSING_CONTACT_ROW_LIMIT = 500;

/** `GET .../missing-contacts`: rows listed per bucket, 1 to 2000. */
export const xeroMissingContactCensusQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

/**
 * The two review screens read `limit` leniently, and always have: a value
 * outside the range, or not a whole number, lists the default rather than
 * refusing. The schema is what an app is told; an app that sends a bad value
 * is refused by the dispatcher before the route sees it.
 */
function lenientLimit(
  schema: typeof erasedMemberContactReviewQuerySchema | typeof xeroMissingContactCensusQuerySchema,
  searchParams: URLSearchParams,
  fallback: number,
): number {
  const parsed = schema.safeParse({ limit: searchParams.get("limit") ?? undefined });
  return parsed.success ? (parsed.data.limit ?? fallback) : fallback;
}

export function erasedMemberContactReviewLimit(searchParams: URLSearchParams): number {
  return lenientLimit(erasedMemberContactReviewQuerySchema, searchParams, DEFAULT_ERASED_CONTACT_ROW_LIMIT);
}

export function xeroMissingContactCensusLimit(searchParams: URLSearchParams): number {
  return lenientLimit(xeroMissingContactCensusQuerySchema, searchParams, DEFAULT_MISSING_CONTACT_ROW_LIMIT);
}

/**
 * `POST .../missing-contacts`: the run, for the members the officer reviewed.
 *
 * `memberIds` is NOT the authority for what gets pushed: the engine
 * recomputes the pushable set and processes the intersection, so a forged id
 * buys nothing. Posting the set means a member who became eligible between the
 * review and the run is absent from it, and so never touched by a confirmation
 * nobody gave for them.
 *
 * `plannedDigest` is the digest of the plan those ids were reviewed against.
 * A member can stay pushable while what would happen to them changes (the
 * operator approves "link Jane to the contact Xero already has", the contact
 * sync archives it, and the member is now a create). Required, because a
 * client that omitted it would be asking for the unguarded run it prevents.
 *
 * `limit` is capped low: each member costs two to four Xero calls depending on
 * whether contact grouping is on, and a small chunk lets an operator stop a
 * run that is going wrong. Omitted, the engine derives it from that cost.
 */
export const xeroMissingContactRunBodySchema = z.object({
  confirmReviewed: z.literal(true),
  memberIds: z.array(z.string().min(1)).min(1).max(5000),
  plannedDigest: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
});
