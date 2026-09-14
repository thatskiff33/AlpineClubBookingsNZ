/**
 * The erased-member Xero contact review (#3058, `INV-INT-024`). The engine is
 * `src/lib/xero-erased-member-contact-review.ts` and its shape is
 * `src/lib/xero-erased-member-contact-review-shape.ts`.
 *
 * **A `GET`, and deliberately nothing else.** There is no `POST`, `PATCH` or
 * `DELETE` here and there is not meant to be one: the settled contract on
 * #3058 is that this application performs no Xero mutation as part of member
 * erasure, and the honest way to hold that is to write no route that could.
 * The engine it calls writes nothing at all — no `Member` row, no operation, no
 * outbox entry, no audit row — and makes no provider call. Whatever an officer
 * decides to do about a contact, they do in Xero.
 *
 * `finance:view` is the audience gate, matching the sibling missing-contact
 * census: this is treasurer-facing accounting-identity work, and the same
 * officers read both screens. It is a `view` rather than an `edit` permission
 * because there is nothing here to edit.
 */
import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import {
  DEFAULT_ERASED_CONTACT_ROW_LIMIT,
  getErasedMemberXeroContactReview,
} from "@/lib/xero-erased-member-contact-review";

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const rawLimit = request.nextUrl.searchParams.get("limit");
  const parsedLimit =
    rawLimit === null ? DEFAULT_ERASED_CONTACT_ROW_LIMIT : Number(rawLimit);
  const limit =
    Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 1000
      ? parsedLimit
      : DEFAULT_ERASED_CONTACT_ROW_LIMIT;

  const review = await getErasedMemberXeroContactReview({ limit });
  return NextResponse.json({ review });
}
