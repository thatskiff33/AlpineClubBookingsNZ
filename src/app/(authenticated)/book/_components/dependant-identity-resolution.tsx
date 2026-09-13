"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getFamilyMemberBookingBlockMessage } from "@/lib/family-booking";
import type { OwnDependantCollision } from "@/lib/booking-dependant-identity";
import {
  PROFILE_FAMILY_GROUP_RETURN_TO_BOOK,
  type FamilyMember,
} from "./types";

/**
 * "You have typed a name the club records as your own dependant — which person
 * do you mean?" (#2721, `INV-GUEST-019`).
 *
 * ## Why this is a stop rather than a suggestion
 *
 * The #1942 steer below it in the guests step is a SUGGESTION: a typed name that
 * matches somebody in the booker's family group, offered as "add them as a
 * member guest instead". This is not that. A recorded dependant on the
 * non-member guest path is the wrong path outright — a provisional, bumpable,
 * separately-invoiced row for a person who is a member of this club — so the
 * wizard will not go on to the split with the question unanswered.
 *
 * The two affordances must never both appear for the same name; the guests step
 * filters the softer one out, and the test pins that.
 *
 * ## The two answers, and why one of them can be unavailable
 *
 * "This is my dependant" needs somewhere to put them, and that somewhere is the
 * member path — which needs the dependant to be bookable as a member from this
 * screen. A parent link is recorded independently of family-group membership and
 * of a completed profile, so a dependant can be recorded and still not be
 * addable here. In that case the answer is not hidden and it is not a dead
 * button: it says what has to happen first and links to the place it happens.
 * Hiding it would leave the booker looking at a question with one answer, which
 * reads as the app pushing them toward the declaration.
 *
 * "This is a different person with the same name" is always available and is
 * always per-dependant. Two dependants whose names normalise alike are two
 * people, and answering for one says nothing about the other.
 *
 * ## Nothing here is positional
 *
 * Every callback takes the collision's normalised name and a member id. The
 * party array underneath is reordered and deleted from while this is on screen,
 * and an index captured at render would answer for whoever ends up in that slot.
 */
export interface DependantIdentityResolutionProps {
  /** Every live collision, answered or not. */
  collisions: OwnDependantCollision[];
  /** Dependant ids the booker has already called a different person. */
  declaredDependantMemberIds: string[];
  /** The booker's family list, for deciding whether the member path is open. */
  familyMembers: FamilyMember[];
  /** Member ids already on the party, so an added dependant is not offered twice. */
  partyMemberIds: string[];
  onBookAsDependant: (
    normalizedName: string,
    familyMember: FamilyMember,
  ) => void;
  onDeclareDifferentPerson: (
    collision: OwnDependantCollision,
    dependantMemberId: string,
  ) => void;
  onWithdrawDeclaration: (
    collision: OwnDependantCollision,
    dependantMemberId: string,
  ) => void;
}

export function DependantIdentityResolution({
  collisions,
  declaredDependantMemberIds,
  familyMembers,
  partyMemberIds,
  onBookAsDependant,
  onDeclareDifferentPerson,
  onWithdrawDeclaration,
}: DependantIdentityResolutionProps) {
  if (collisions.length === 0) return null;

  return (
    <div className="space-y-4 rounded-md border border-warning-6 bg-warning-3 p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-warning-11">
          Is this your own family member?
        </p>
        <p className="text-sm text-warning-11">
          A guest you have typed has exactly the same name as somebody the club
          records as your dependant. We will not guess which person you mean, so
          please say. Booking your own dependant as a guest would hold no bed for
          them until the booking is confirmed and paid, and could see them bumped
          if the lodge fills up.
        </p>
      </div>

      {collisions.map((collision) => (
        <div
          key={collision.normalizedName}
          className="space-y-3 rounded-md border border-warning-6 bg-background p-3"
        >
          <p className="text-sm text-foreground">
            You typed{" "}
            <strong>
              {collision.typedFirstName} {collision.typedLastName}
            </strong>
            .
          </p>

          {collision.dependants.map((dependant) => {
            const declared = declaredDependantMemberIds.includes(dependant.id);
            const familyMember = familyMembers.find(
              (candidate) => candidate.id === dependant.id,
            );
            const alreadyOnParty = partyMemberIds.includes(dependant.id);
            const bookable =
              familyMember !== undefined &&
              familyMember.canBeBooked !== false &&
              !alreadyOnParty;

            return (
              <div
                key={dependant.id}
                className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
              >
                <p className="text-sm text-muted-foreground">
                  {dependant.firstName} {dependant.lastName} is recorded as your
                  dependant.
                </p>

                {declared ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      You have said this is a different person with the same
                      name.
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onWithdrawDeclaration(collision, dependant.id)
                      }
                    >
                      Change my answer
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {bookable ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          onBookAsDependant(
                            collision.normalizedName,
                            familyMember,
                          )
                        }
                      >
                        This is my dependant — book them as a member
                      </Button>
                    ) : (
                      <div className="space-y-1 text-sm text-muted-foreground">
                        <p className="font-medium text-foreground">
                          This is my dependant
                        </p>
                        <p>
                          {alreadyOnParty
                            ? `${dependant.firstName} is already on this booking as a member, so the guest you have typed must be somebody else.`
                            : (familyMember
                                ? getFamilyMemberBookingBlockMessage(
                                    familyMember,
                                  )
                                : null) ??
                              `${dependant.firstName} cannot be added from this screen yet. Add them to your family group in your profile, then come back.`}
                        </p>
                        <Link
                          href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}
                          className="font-medium underline underline-offset-4"
                        >
                          Open Family Group in your profile
                        </Link>
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onDeclareDifferentPerson(collision, dependant.id)
                      }
                    >
                      This is a different person with the same name
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
