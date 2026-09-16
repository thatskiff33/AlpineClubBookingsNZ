"use client";

import { Button } from "@/components/ui/button";
import { PROVISIONAL_HOLD_CONSEQUENCE_ON_BEHALF } from "@/lib/family-booking";
import type { OwnDependantCollision } from "@/lib/booking-dependant-identity";
import type { AgeTier } from "@prisma/client";

/**
 * "You have typed a name the club records as this member's own dependant —
 * which person do you mean?", asked of an OFFICER booking on the member's
 * behalf (#2721, `INV-GUEST-019`; owner decision on D1, 15 Sep 2026).
 *
 * ## Why this screen has the control at all
 *
 * The guard used to skip the authorised on-behalf create entirely. The owner
 * removed that exemption because the two checks beside each other are not the
 * same class: the member-guest boundary check gates the OFFICER'S OWN
 * AUTHORITY, which the officer can see in front of them, while this one protects
 * A THIRD PARTY'S BED — a real child on a provisional, bumpable, separately
 * invoiced guest row at non-member prices, with the parent not at the screen to
 * notice.
 *
 * Removing the exemption without this panel would have been strictly worse than
 * the silence it replaces: the officer would be refused by the server with
 * nowhere to answer, which blocks the booking instead of redirecting it. So the
 * control ships with the rule, which is what the decision says.
 *
 * ## The same two answers, in the officer's voice
 *
 * Deliberately the member wizard's vocabulary, not a second one: the same two
 * answers, the same per-dependant shape, the same declaration the server
 * accepts. What changes is person — the dependant is the MEMBER'S, and the
 * officer is not the person who can know from memory which human was meant, so
 * the copy says whose family it is and what each answer does.
 *
 * "This is the member's dependant" needs the dependant to be addable from this
 * screen, and this screen adds members from the on-behalf family picker — a
 * family-group list, which is a different column from the parent link that makes
 * somebody a dependant. Divergence is ordinary rather than an edge case, so when
 * the dependant is not in that list the answer is not hidden and is not a dead
 * button: it says what the officer has to do first. An officer CAN do that one,
 * which is the difference from the member-facing version of the same case.
 *
 * ## Nothing here is positional
 *
 * Every callback takes the collision's normalised name and a member id. The
 * party underneath is an array the officer reorders, deletes from and adds to
 * while this is on screen, and an index captured at render would answer for
 * whoever ends up in that slot.
 */
export interface AdminDependantIdentityResolutionProps {
  /** Every live collision on the proposed party, answered or not. */
  collisions: OwnDependantCollision[];
  /** Dependant ids the officer has already called a different person. */
  declaredDependantMemberIds: string[];
  /** The member this booking is FOR — the owner of these dependants. */
  bookingForFirstName: string;
  /** The on-behalf family picker's list, for deciding whether "yes" is open. */
  familyMembers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
  }>;
  /** Member ids already on the party, so a dependant is not offered twice. */
  partyMemberIds: string[];
  onBookAsDependant: (
    normalizedName: string,
    familyMember: {
      id: string;
      firstName: string;
      lastName: string;
      ageTier: AgeTier;
    },
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

export function AdminDependantIdentityResolution({
  collisions,
  declaredDependantMemberIds,
  bookingForFirstName,
  familyMembers,
  partyMemberIds,
  onBookAsDependant,
  onDeclareDifferentPerson,
  onWithdrawDeclaration,
}: AdminDependantIdentityResolutionProps) {
  if (collisions.length === 0) return null;

  return (
    <div className="space-y-4 rounded-md border border-warning-6 bg-warning-3 p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-warning-11">
          Is this {bookingForFirstName}&apos;s own family member?
        </p>
        <p className="text-sm text-warning-11">
          A guest typed on this booking has exactly the same name as somebody the
          club records as {bookingForFirstName}&apos;s dependant. The club does
          not guess which person is meant, so please say.
          {PROVISIONAL_HOLD_CONSEQUENCE_ON_BEHALF}
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
            const bookable = familyMember !== undefined && !alreadyOnParty;

            return (
              <div
                key={dependant.id}
                className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
              >
                <p className="text-sm text-muted-foreground">
                  {dependant.firstName} {dependant.lastName} is recorded as{" "}
                  {bookingForFirstName}&apos;s dependant.
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
                      Change this answer
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
                        This is {bookingForFirstName}&apos;s dependant — book
                        them as a member
                      </Button>
                    ) : (
                      <div className="space-y-1 text-sm text-muted-foreground">
                        <p className="font-medium text-foreground">
                          This is {bookingForFirstName}&apos;s dependant
                        </p>
                        <p>
                          {alreadyOnParty
                            ? `${dependant.firstName} is already on this booking as a member, so the guest typed must be somebody else.`
                            : `${dependant.firstName} is recorded as ${bookingForFirstName}'s dependant but is not in their family group, so they cannot be added from this screen. Put them in the family group under Membership, then start this booking again.`}
                        </p>
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
