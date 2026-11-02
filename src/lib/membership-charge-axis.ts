/**
 * The single place allowed to read a `MembershipSubscriptionCharge`'s billing
 * axis columns (`membershipTypeId`/`Key`/`Name` vs
 * `subscriptionCategoryId`/`Key`/`Name`) to build a family-dedup key or a
 * display name (INV-SSOT-007, INV-MONEY-045).
 *
 * Both axes widened/added to nullable across a windowed migration pair
 * (20261128010000/20261128020000) precisely because the currently-deployed
 * app's own un-null-checked reads of these columns are the hazard this
 * module exists to close: TypeScript does not flag a `null` interpolated
 * into a template literal (`` `${x}` `` typechecks for any `x`), so a raw
 * `` `${charge.membershipTypeId}` `` silently stringifies a category charge's
 * null type id to the literal text "null" — collapsing every category
 * charge for a family onto the SAME dedup key regardless of which category
 * it actually is. `src/lib/__tests__/membership-charge-axis-census.test.ts`
 * fails the build if a new direct read of that shape appears anywhere
 * outside this file.
 */

export type ChargeAxisKeyInput = {
  seasonYear: number;
  familyGroupId: string | null;
  membershipTypeId: string | null;
  subscriptionCategoryId: string | null;
};

/**
 * The family-dedup key for the closed-family reversal machinery (#4110):
 * `billedFamilyTypes`, `decisionReasonByFamilyKey`, `settledCoveredByFamilyKey`
 * and friends in `membership-subscription-billing.ts`, plus
 * `invoicingWarningEntryKey` in `subscription-charge-already-paid.ts`. A type
 * charge and a category charge for the SAME family must resolve to different
 * keys (they bill independently — `MIXED_AXIS_FAMILY_BILLING`), while two
 * charges on the SAME axis for the same family in the same season must
 * collide onto the same key (that collision is what the dedup/reversal logic
 * is for). Exactly one of `membershipTypeId`/`subscriptionCategoryId` is ever
 * populated per charge (DB CHECK `MembershipCharge_type_xor_category`).
 */
export function chargeFamilyAxisKey(input: ChargeAxisKeyInput): string {
  if (!input.membershipTypeId && !input.subscriptionCategoryId) {
    // Billing review fix: a caller that forgot to pass the category id for
    // a category-axis charge/warning used to fall through to
    // `category:${null}` — collapsing every such call for a family onto
    // ONE key regardless of which category, silently. Refusing here turns
    // that mistake into an immediate, loud failure at the call site instead
    // of a quiet cross-category collision discovered later.
    throw new Error("chargeFamilyAxisKey: neither membershipTypeId nor subscriptionCategoryId is set.");
  }
  const axis = input.membershipTypeId
    ? `type:${input.membershipTypeId}`
    : `category:${input.subscriptionCategoryId}`;
  return `${input.seasonYear}:${axis}:family:${input.familyGroupId}`;
}

/**
 * The display name for whichever axis actually billed a charge/entry — never
 * both, since a charge bills on exactly one. Falls back to a generic label
 * only for a row from before either axis was ever recorded (should not occur
 * for a confirmed charge this app wrote, but a `null`/`null` pair must still
 * resolve to a string, never `"null"`).
 */
export function chargeAxisDisplayName(input: {
  membershipTypeName: string | null;
  subscriptionCategoryName: string | null;
}): string {
  return input.membershipTypeName ?? input.subscriptionCategoryName ?? "Subscription";
}
