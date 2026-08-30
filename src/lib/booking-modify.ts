// Booking modification boundary (issue #1138). The former single-file module
// was split into three cohesive modules and this file is now a pure barrel,
// so everything importable from "@/lib/booking-modify" is unchanged:
// - booking-modify-validation: edit-eligibility validation + shared loaded types
// - booking-modify-plan: the in-transaction modify pipeline (guest plan,
//   repricing, promo changes, change fee, guest/chore writes)
// - booking-modify-settlement: settlement handoff and lifecycle transitions

export {
  assertBookingModifiable,
  assertBookingNotQuotePriced,
  EDIT_FINANCIAL_REVIEW_QUOTE_NOTICE,
  BookingModifyReviewJustificationRequiredError,
  GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE,
  hasOutstandingAdditionalPayment,
  isBookingFullyPaidForGuestNameEdits,
  isMemberWholeLodgeBooking,
  isQuotePricedBooking,
  QUOTE_PRICED_EDIT_BLOCK_MESSAGE,
  resolveTargetDates,
  type BatchModifyInput,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
  type LoadedPromoRedemption,
  type ResolvedTargetDates,
} from "@/lib/booking-modify-validation";
export {
  applyChoreCleanup,
  applyGuestChanges,
  applyPromoCodeChanges,
  calculateModificationChangeFee,
  calculateModifiedPricing,
  GUEST_MEMBER_LINK_ADMIN_ONLY_MESSAGE,
  GUEST_MEMBER_LINK_ALREADY_ON_BOOKING_MESSAGE,
  GUEST_MEMBER_LINK_PLACEHOLDER_ONLY_MESSAGE,
  GUEST_MEMBER_LINK_WHOLE_LODGE_ONLY_MESSAGE,
  loadActiveSeasonRates,
  parkedPriceBreakdown,
  lockedNightPricesForGuest,
  PAID_NAME_TYPO_ONLY_MESSAGE,
  prepareGuestPlan,
  rateSnapshotUpdateForRepricedGuest,
  resolveGuestMemberLinks,
  resolveGuestNameUpdates,
  resolvePartnerSharedCapacity,
  resolvePromoBeneficiarySelection,
  type GuestPlan,
  type PricingResult,
  type PromoChangeResult,
  type ResolvedGuestMemberLink,
  type ResolvedGuestNameUpdate,
} from "@/lib/booking-modify-plan";
export {
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  calculateModificationSettlementOptions,
  BookingModificationSettlementMethodRequiredError,
  SETTLEMENT_METHOD_REQUIRED_CODE,
  SETTLEMENT_METHOD_REQUIRED_MESSAGE,
  type BookingModificationSettlementOptions,
  type LifecycleTransitionResult,
  type PaymentAdjustmentResult,
} from "@/lib/booking-modify-settlement";
