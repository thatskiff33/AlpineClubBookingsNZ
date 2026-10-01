/**
 * The own-dependant rule's PER-DOOR helpers (#3451, `INV-GUEST-019`): what each
 * door says, in whose voice, and which party rows and answers it puts to the
 * guard. Split out of `booking-dependant-identity.ts`, which keeps the rule, the
 * guard and its single server entry point; nothing here decides a collision.
 * Pure and type-only on its imports, so the edit panel can import it.
 */

import {
  DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_MESSAGE,
  type DependantIdentityDeclaration,
  type DependantIdentityPartyMember,
  type DependantIdentityRefusal,
} from "@/lib/booking-dependant-identity";
import { normalizePersonFullName } from "@/lib/person-name-normalization";

/**
 * The same refusal, said to an OFFICER EDITING an existing booking on a member's
 * behalf (#3451). The create wording names "the guest step", which the edit panel
 * does not have: there the question is drawn in the guests section, above the
 * save. Same code, so one client handler still covers every screen.
 */
export const DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_EDIT_MESSAGE =
  "One of the guests added to this booking has the same name as somebody recorded as this member's own dependant. Say in the guests section whether that is the dependant or a different person with the same name before saving.";

/**
 * The member's own wording on the EDIT panel (#3451 review): the create
 * sentences say "before continuing" and "go back to the guest list", neither of
 * which the edit panel has. Same codes, so the one client handler still keys on
 * them.
 */
export const DEPENDANT_IDENTITY_UNRESOLVED_EDIT_MESSAGE =
  "One of the guests on this change has the same name as somebody recorded as your dependant. Say in the guests section whether that is your dependant or a different person with the same name before saving.";
export const DEPENDANT_IDENTITY_DECLARATION_INVALID_EDIT_MESSAGE =
  "The answer about a guest sharing a dependant's name no longer matches this change. Answer the question in the guests section again, then save.";

/**
 * Is the reader of a refusal somebody OTHER than the member whose dependants it
 * is about — an officer acting for them? The ONE spelling of that decision
 * (#3451 review), used by every door and the edit panel: it is ownership, not
 * role, so an officer editing their own booking is spoken to as the member.
 */
export function dependantIdentitySpeaksOnBehalf(params: {
  actorIsAdmin: boolean;
  actorId: string | null | undefined;
  ownerMemberId: string | null | undefined;
}): boolean {
  return params.actorIsAdmin && params.ownerMemberId !== params.actorId;
}

/**
 * What the STANDALONE add-guests route says instead of asking (#3451, owner
 * decision 1 Oct 2026, option C).
 *
 * `POST /api/bookings/[id]/guests` has no screen behind it and no way to carry
 * an answer, so it refuses — but names the dependant as somebody the club
 * already knows, and points at the place the question can be answered: the
 * booking's edit panel, which adds them on the member path or takes the
 * "different person" answer. The names are the BOOKER'S OWN dependants whose
 * names were just typed, so nothing is said about anybody outside that set.
 */
export function standaloneAddGuestDependantRefusalMessage(
  refusal: DependantIdentityRefusal,
  options: { onBehalf: boolean },
): string {
  const names = [
    ...new Set(
      refusal.collisions.flatMap((collision) =>
        collision.dependants.map(
          (dependant) => `${dependant.firstName} ${dependant.lastName}`,
        ),
      ),
    ),
  ];
  const named = names.length > 0 ? names.join(" and ") : "A guest you added";
  const whose = options.onBehalf ? "this member's" : "your";
  const verb = names.length > 1 ? "are" : "is";
  return `${named} ${verb} already known to the club as ${whose} dependant, so they cannot be added here as a non-member guest. Open the booking and choose Edit Booking: there they can be added as a member, or you can say the guest is a different person with the same name.`;
}

/**
 * The HTTP body every door that ASKS the question answers a refusal with — the
 * create route and the edit panel's two doors (#3451).
 *
 * The CODE is the same everywhere, so each client keys on it to put the question
 * back on screen; the SENTENCE depends on who is reading. "Your dependant" is
 * wrong in both halves when the reader is an officer acting for the member, so
 * that reader is told whose dependant it is and where on THEIR screen the answer
 * lives. The collisions are deliberately not echoed (#2721 review): a client that
 * meets this refusal re-derives the question from the family list it reads for
 * itself, so names and ids in the body would travel to no consumer.
 */
export function dependantIdentityRefusalBody(
  refusal: DependantIdentityRefusal,
  options: { onBehalf: boolean; surface: "create" | "edit" },
): { code: DependantIdentityRefusal["code"]; error: string } {
  const edit = options.surface === "edit";
  if (refusal.code === DEPENDANT_IDENTITY_UNRESOLVED_CODE) {
    if (options.onBehalf) {
      return {
        code: refusal.code,
        error: edit
          ? DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_EDIT_MESSAGE
          : DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_MESSAGE,
      };
    }
    if (edit) {
      return { code: refusal.code, error: DEPENDANT_IDENTITY_UNRESOLVED_EDIT_MESSAGE };
    }
  }
  if (edit && refusal.code === DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE) {
    return {
      code: refusal.code,
      error: DEPENDANT_IDENTITY_DECLARATION_INVALID_EDIT_MESSAGE,
    };
  }
  return { code: refusal.code, error: refusal.error };
}

/**
 * The answers that may travel with a proposal carrying only ADDED guests (#3451
 * review): an edit's policy-exception request carries the added guests but not
 * renames, so an answer about a renamed row would describe no collision there
 * and be refused as tampering — a dead end. Kept: answers whose name is one of
 * the added free-text guests'. Pure, for the panel's payload builder.
 */
export function declarationsForAddedGuests(
  declarations: ReadonlyArray<DependantIdentityDeclaration>,
  addedGuests: ReadonlyArray<DependantIdentityPartyMember>,
): DependantIdentityDeclaration[] {
  const names = new Set(
    addedGuests
      .filter((guest) => !guest.memberId?.trim())
      .map((guest) => normalizePersonFullName(guest.firstName, guest.lastName))
      .filter((name): name is string => Boolean(name)),
  );
  return declarations.filter((declaration) =>
    names.has(declaration.normalizedName),
  );
}

/**
 * The existing free-text guests an edit RENAMES onto a new name (#3451) — the
 * same split as adding a guest, reached by retyping one already on the booking.
 * Each is checked as if it were added: a rename onto one of the owner's recorded
 * dependants' names gets the same question.
 *
 * Only a rename that changes the NORMALISED name counts. A casing or spacing fix
 * leaves the person the row always was, and that row was admitted under whatever
 * its own door asked then, so it is not re-asked. Member-linked rows cannot be
 * renamed at all (`resolveGuestNameUpdates` refuses them), and are skipped here.
 *
 * Pure, so the edit panel and both server doors derive the same rows from the
 * same rule. Each row carries its `guestId` so the panel can act on it.
 */
export function renamedGuestsForDependantCheck(
  existingGuests: ReadonlyArray<{
    id: string;
    firstName: string;
    lastName: string;
    isMember?: boolean | null;
    memberId?: string | null;
  }>,
  guestUpdates: ReadonlyArray<{
    guestId: string;
    firstName: string;
    lastName: string;
  }> | null | undefined,
  /** Rows the same change removes: a removed row books nobody, renamed or not. */
  removeGuestIds?: ReadonlyArray<string> | null,
): Array<DependantIdentityPartyMember & { guestId: string; memberId: null }> {
  if (!guestUpdates?.length) return [];
  const removed = new Set(removeGuestIds ?? []);
  const byId = new Map(existingGuests.map((guest) => [guest.id, guest]));
  const renamed: Array<
    DependantIdentityPartyMember & { guestId: string; memberId: null }
  > = [];
  for (const update of guestUpdates) {
    const guest = byId.get(update.guestId);
    if (!guest || removed.has(guest.id) || guest.isMember || guest.memberId?.trim()) {
      continue;
    }
    const before = normalizePersonFullName(guest.firstName, guest.lastName);
    const after = normalizePersonFullName(update.firstName, update.lastName);
    if (!after || after === before) continue;
    renamed.push({
      guestId: guest.id,
      firstName: update.firstName,
      lastName: update.lastName,
      memberId: null,
    });
  }
  return renamed;
}
