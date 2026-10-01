"use client";

import { AdminDependantIdentityResolution } from "@/app/(admin)/admin/book/_components/dependant-identity-resolution";
import { DependantIdentityResolution } from "@/app/(authenticated)/book/_components/dependant-identity-resolution";
import { buildProfilePathWithReturnTo } from "@/lib/internal-return-path";
import type { FamilyMember } from "@/components/edit-booking/types";
import type { useEditDependantIdentity } from "@/components/edit-booking/hooks/use-edit-dependant-identity";

/**
 * The own-dependant question on the booking EDIT panel (#3451,
 * `INV-GUEST-019`), drawn with the create screens' OWN components rather than a
 * third copy of them: the member's wizard panel for a member, and the officer's
 * on-behalf panel for an officer editing for the member. The same two answers,
 * the same per-dependant shape, the same declaration the server accepts.
 *
 * What differs from create is where the "fix the family group first" step
 * returns to: THIS booking, rather than a new one. The hold consequence is
 * stated at the CONDITIONAL strength on both: an edit re-applies the club's
 * non-member hold rule, and this panel has not read whether it bites here.
 */
type QuestionProps = {
  bookingId: string;
  /**
   * An officer acting for the member — `dependantIdentitySpeaksOnBehalf`, the
   * server's own ownership test, so an officer on their OWN booking is asked in
   * the member's words.
   */
  speaksOnBehalf: boolean;
  /** The panel's answer state, from `useEditDependantIdentity`. */
  answers: ReturnType<typeof useEditDependantIdentity>;
  familyMembers: FamilyMember[];
  /** Everyone on the proposed party, so a dependant on it is not offered twice. */
  party: ReadonlyArray<{ memberId?: string | null }>;
};

export function EditDependantIdentityQuestion(props: QuestionProps) {
  // A live region that is ALWAYS mounted (#3451 review), so the question is
  // announced when it appears beside the guest that caused it, not only found by
  // somebody who happens to tab past it.
  return (
    <div role="status" aria-live="polite">
      {props.answers.collisions.length > 0 ? <Question {...props} /> : null}
    </div>
  );
}

function Question({
  bookingId,
  speaksOnBehalf,
  answers,
  familyMembers,
  party,
}: QuestionProps) {
  const {
    collisions,
    declaredDependantMemberIds,
    bookAsDependant: onBookAsDependant,
    declareDifferentPerson: onDeclareDifferentPerson,
    withdrawDeclaration: onWithdrawDeclaration,
  } = answers;
  const partyMemberIds = party.flatMap((guest) =>
    guest.memberId ? [guest.memberId] : [],
  );

  if (speaksOnBehalf) {
    // The owner is the "self" row of their own family list, which is the list an
    // officer's panel reads (`eligible-family` resolves the booking's owner).
    const ownerFirstName =
      familyMembers.find((member) => member.relationship === "self")
        ?.firstName ?? "this member";
    return (
      <AdminDependantIdentityResolution
        collisions={collisions}
        declaredDependantMemberIds={declaredDependantMemberIds}
        bookingForFirstName={ownerFirstName}
        familyMembers={familyMembers}
        partyMemberIds={partyMemberIds}
        afterFamilyGroupFix="come back to this booking"
        onBookAsDependant={(normalizedName, member) => {
          const familyMember = familyMembers.find(
            (candidate) => candidate.id === member.id,
          );
          if (familyMember) onBookAsDependant(normalizedName, familyMember);
        }}
        onDeclareDifferentPerson={onDeclareDifferentPerson}
        onWithdrawDeclaration={onWithdrawDeclaration}
      />
    );
  }

  return (
    <DependantIdentityResolution
      collisions={collisions}
      declaredDependantMemberIds={declaredDependantMemberIds}
      familyMembers={familyMembers}
      partyMemberIds={partyMemberIds}
      // "conditional": an edit re-applies the club's non-member hold rule, but
      // the panel has not read whether it applies to this booking's dates.
      holdPolicy="conditional"
      familyGroupHref={buildProfilePathWithReturnTo(
        `/bookings/${bookingId}`,
        "family-group",
      )}
      onBookAsDependant={onBookAsDependant}
      onDeclareDifferentPerson={onDeclareDifferentPerson}
      onWithdrawDeclaration={onWithdrawDeclaration}
    />
  );
}
