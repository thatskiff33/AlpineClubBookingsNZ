/**
 * The erased-member Xero contact review (#3058, `INV-INT-024`). The engine is
 * `src/lib/xero-erased-member-contact-review.ts` and its shape is
 * `src/lib/xero-erased-member-contact-review-shape.ts`.
 *
 * **`GET` computes the review from local state and asks Xero nothing.** The
 * engine writes nothing at all — no `Member` row, no operation, no outbox
 * entry, no audit row — and makes no provider call.
 *
 * **`POST` asks Xero about the contacts the review is listing, and only that.**
 * It exists because without it the list can never shrink: the bulk contact sync
 * fetches changed contacts with `includeArchived: false`, and the erasure
 * deleted the contact's cache row, so a contact the treasurer archives becomes
 * permanently invisible here. The check is `getContacts` with archived
 * included, one field of the answer kept, and the observation stamped on the
 * retired `CONTACT` link. It changes NOTHING in Xero and imports no detail
 * about a person; `xero-erased-member-contact-status-check.ts` sets out why it
 * writes no contact-cache row.
 *
 * The contract on #3058 is that erasure performs no Xero mutation, and this
 * surface holds to it on both verbs: no contact is created, updated, archived
 * or deleted, and nothing is queued that would. Whatever an officer decides to
 * do about a contact, they do in Xero.
 *
 * `finance:view` is the audience gate on both, matching the sibling
 * missing-contact census: this is treasurer-facing accounting-identity work and
 * the same officers read both screens. It stays a `view` permission on the
 * `POST` because the `POST` edits nothing an officer could be said to own — it
 * refreshes what this screen knows about somebody else's system.
 */
import { NextRequest, NextResponse } from "next/server";

import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import {
  DEFAULT_ERASED_CONTACT_ROW_LIMIT,
  getErasedMemberXeroContactReview,
} from "@/lib/xero-erased-member-contact-review";
import { checkErasedMemberContactStatuses } from "@/lib/xero-erased-member-contact-status-check";
import { XeroResyncUnavailableError } from "@/lib/xero-mismatch-resync";

function resolveLimit(raw: string | null): number {
  const parsed = raw === null ? DEFAULT_ERASED_CONTACT_ROW_LIMIT : Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000
    ? parsed
    : DEFAULT_ERASED_CONTACT_ROW_LIMIT;
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const review = await getErasedMemberXeroContactReview({
    limit: resolveLimit(request.nextUrl.searchParams.get("limit")),
  });
  return NextResponse.json({ review });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const limit = resolveLimit(request.nextUrl.searchParams.get("limit"));

  try {
    /*
      Asked about EXACTLY the ids this screen is listing, and never a wider set.
      The review is recomputed after the check, so a contact Xero now holds as
      archived leaves the list in the same response that observed it.
    */
    const before = await getErasedMemberXeroContactReview({ limit });
    const check = await checkErasedMemberContactStatuses(
      before.rows.map((row) => row.xeroContactId),
    );
    const review = await getErasedMemberXeroContactReview({ limit });
    return NextResponse.json({ review, check });
  } catch (error) {
    if (error instanceof XeroResyncUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof XeroDailyLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    logger.error(
      { err: error },
      "Failed to check erased-member Xero contact statuses",
    );
    return NextResponse.json(
      { error: "Could not check these contacts in Xero." },
      { status: 500 },
    );
  }
}
