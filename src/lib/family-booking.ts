export interface BookingFamilyMember {
  relationship: "self" | "partner" | "dependent";
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  confirmationMode?: "self" | "delegated" | "not_allowed" | string | null;
  canLogin?: boolean | null;
  canBeBooked?: boolean | null;
  missingFields?: string[];
  needsOwnLoginConfirmation?: boolean | null;
  canCurrentUserConfirmDetails?: boolean | null;
  pendingRequestStatus?: string | null;
  pendingRequests?: Array<{
    id: string;
    type: string;
    status: string;
    familyGroupId: string;
  }>;
  pendingRequestFamilyGroupIds?: string[];
  bookableFamilyGroupIds?: string[];
  action?: string | null;
}

export function shouldShowInviteFamilyGroupMembersLink(
  familyMembers: BookingFamilyMember[]
): boolean {
  return !familyMembers.some((member) => member.relationship !== "self");
}

function getMemberName(member: BookingFamilyMember) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || "This member";
}

function isConfirmationExemptAccount(member: BookingFamilyMember) {
  return member.confirmationMode === "not_allowed";
}

// Whether the non-member provisional hold would apply if this person were added
// as a non-member guest instead (#1942):
//   "applies"     — a non-member is already in the party and the live quote says
//                   the stay is outside the hold window: the hold WILL apply.
//   "conditional" — the party has no non-member yet, so the quote can't yet say
//                   whether the hold applies. The FIRST non-member added would
//                   otherwise get no warning at all, so warn conditionally.
//   "none"        — the quote says the hold does not apply to this stay (e.g.
//                   check-in is inside the hold window): a bed is held
//                   immediately, so no provisional warning.
export type NonMemberHoldPolicyState = "applies" | "conditional" | "none";

// Standalone consequence sentence spelling out what "add them as a non-member
// guest" actually means, so the choice is informed rather than a surprise at
// check-in. Used by messages that do NOT already mention adding as a non-member
// guest (so the phrase appears exactly once).
//
// EXPORTED for #2721's own-dependant panel, which asks the same question about
// the same consequence. It stated the provisional hold as unconditional fact,
// which is wrong in both directions: the hold is a per-period, per-deployment
// setting, so the panel asserted the consequence where it does not apply — and
// the conditioned version was already here, returning "" for exactly that case.
// A panel designed to avoid pressure toward the wrong answer must not overstate
// what the other answer costs.
export function provisionalHoldConsequence(
  state: NonMemberHoldPolicyState,
): string {
  if (state === "applies") {
    return " If you add them as a non-member guest, they'll be held provisionally — no bed is reserved for them until the booking is confirmed and paid closer to your stay, and members have priority if the lodge fills up.";
  }
  if (state === "conditional") {
    return " If you add them as a non-member guest, they may be held provisionally depending on how far out your booking is — if held, no bed is reserved for them until the booking is confirmed and paid closer to your stay, and members have priority if the lodge fills up.";
  }
  return "";
}

/**
 * The same consequence, said to an OFFICER booking on a member's behalf (#2721,
 * owner decision 15 Sep 2026). Kept here beside the member's wording so the two
 * statements of what the non-member hold costs cannot drift apart.
 *
 * Fixed at the CONDITIONAL strength on purpose. The tri-state above resolves
 * "applies" from a live quote's `nonMemberHoldDecision`, and the admin booking
 * screen's quote does not carry that field — so an officer panel claiming the
 * hold as fact would be asserting a per-period, per-deployment setting it has
 * not read, which is the overstatement the member panel was already corrected
 * for. Conditional is what this screen can honestly say.
 */
export const PROVISIONAL_HOLD_CONSEQUENCE_ON_BEHALF =
  " Booked as a non-member guest they may be held provisionally depending on how far out the stay is — if held, no bed is reserved for them until the booking is confirmed and paid, members have priority if the lodge fills up, and their share is invoiced separately at non-member rates.";

// Continuation clause for a message that already ends with "...add them as a
// non-member guest ...". Reads as one sentence with that lead-in so the phrase
// is not repeated verbatim (#1942 doubled-phrase fix).
function provisionalHoldContinuation(state: NonMemberHoldPolicyState): string {
  if (state === "applies") {
    return " — if you do, they'll be held provisionally: no bed is reserved for them until the booking is confirmed and paid closer to your stay, and members have priority if the lodge fills up.";
  }
  if (state === "conditional") {
    return " — if you do, they may be held provisionally depending on how far out your booking is: no bed is reserved for them until the booking is confirmed and paid closer to your stay, and members have priority if the lodge fills up.";
  }
  return "";
}

export function getFamilyMemberBookingBlockMessage(
  member: BookingFamilyMember,
  options?: { holdPolicy?: NonMemberHoldPolicyState }
): string | null {
  if (member.canBeBooked !== false) {
    return null;
  }

  const name = getMemberName(member);
  const holdPolicy = options?.holdPolicy ?? "none";
  const consequence = provisionalHoldConsequence(holdPolicy);

  if (member.pendingRequestStatus) {
    // This branch already ends with "...add them as a non-member guest until
    // approved", so use the continuation form (no repeated phrase).
    const base =
      "This family change is awaiting admin approval. You can add them as a non-member guest until approved";
    return holdPolicy === "none"
      ? `${base}.`
      : `${base}${provisionalHoldContinuation(holdPolicy)}`;
  }

  if (isConfirmationExemptAccount(member)) {
    return `${name} does not need member detail confirmation and cannot be added as a member guest.`;
  }

  if (member.canLogin) {
    return `${name} has their own login and needs to sign in and confirm their details before they can be booked as a member.${consequence}`;
  }

  if (member.canCurrentUserConfirmDetails) {
    return `Complete ${name}'s details before booking them as a member. Because ${name} does not have their own login, any adult in this family group can do this.${consequence}`;
  }

  return `${name}'s member details need to be completed or confirmed before they can be booked as a member.${consequence}`;
}

export function getFamilyMemberBookingActionLabel(
  member: BookingFamilyMember
): string | null {
  if (member.canBeBooked !== false) {
    return null;
  }

  if (member.pendingRequestStatus || member.action === "pending_admin_approval") {
    return "Pending admin approval";
  }

  if (isConfirmationExemptAccount(member)) {
    return null;
  }

  if (member.action === "complete_details") {
    return "Complete details";
  }

  if (member.action === "own_login_required") {
    return "Ask them to sign in and confirm";
  }

  if (member.action === "contact_admin") {
    return "Contact admin";
  }

  return null;
}
