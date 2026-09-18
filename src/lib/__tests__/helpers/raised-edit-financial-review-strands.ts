import { expect } from "vitest";

import {
  editFinancialReviewStrandRecords,
  parseEditFinancialReviewContext,
  type EditFinancialReviewStrandRecord,
} from "@/lib/edit-financial-review-context";

/**
 * EVERY strand of a raised work item, read the way production reads one
 * (`INV-SSOT`, #3498 fix round).
 *
 * ## Why a suite may not splice this for itself
 *
 * `EditFinancialReviewOccurrence`'s own docblock says nothing may read
 * `otherStrands` directly to enumerate an edit's strands, because
 * `editFinancialReviewStrandRecords` is the one place that list is assembled —
 * and the two are free to drift on the order, on whether the lead is included,
 * and on what an absent `otherStrands` means.
 *
 * Three suites were doing exactly that, against structural types they declared
 * themselves, in order to PROVE the one-home property. A guard that measures a
 * property by bypassing the mechanism the property is about measures nothing:
 * change `editFinancialReviewStrandRecords` to drop the lead, and those three
 * would have gone on passing while every screen lost a strand.
 *
 * ## It is strictly stronger than the splice it replaces
 *
 * It parses the stored blob through the product's own parser first, so a
 * `reviewContext` a raise WROTE but the product cannot READ BACK fails here
 * instead of passing. The splice cast its way past that question entirely.
 */
export function raisedEditFinancialReviewStrands(
  reviewContext: unknown,
): readonly EditFinancialReviewStrandRecord[] {
  const context = parseEditFinancialReviewContext(reviewContext);
  expect(
    context,
    "the raised reviewContext must parse through parseEditFinancialReviewContext",
  ).not.toBeNull();
  return editFinancialReviewStrandRecords(context!.occurrence);
}
