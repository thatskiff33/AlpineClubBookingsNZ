"use client";

import type { AgeTier } from "@prisma/client";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GuestNightGrid } from "@/components/guest-night-grid";
import { EditMemberGuestFinder } from "@/components/booking/edit-member-guest-section";
import { AddedGuestRow } from "@/components/edit-booking/added-guest-row";
import { ExistingGuestRow } from "@/components/edit-booking/existing-guest-row";
import { OtherLodgeRateControl } from "@/components/edit-booking/other-lodge-rate-control";
import { eachNightKey } from "@/components/edit-booking/stay-nights";
import type {
  BookingData,
  FamilyMember,
  Guest,
  NewGuest,
  PartnerSharingCandidate,
} from "@/components/edit-booking/types";
import { getAgeTierLabel, type AgeTierOption } from "@/lib/use-age-tier-options";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";

/** Which edit mode the panel is in, and what that mode allows on this card. */
export interface GuestsCardMode {
  overrideEnabled: boolean;
  isInProgressEdit: boolean;
  minEditableDate: string;
  checkIn: string;
  checkOut: string;
  nonMemberGuestNamesEditable: boolean;
  /** #2337: the admin/member-whole-lodge fence on the placeholder→member link. */
  memberLinkEnabled: boolean;
}

/** The party as this edit currently proposes it. */
export interface GuestsCardParty {
  remainingGuests: Guest[];
  addedGuests: NewGuest[];
  removedGuestIds: Set<string>;
  totalGuestCount: number;
}

/** MG3/MG4's member-guest finder, opened from the card header. */
export interface GuestsCardMemberGuest {
  finderOpen: boolean;
  addError: string | null;
  lastAttempt: MemberGuestCandidate | null;
  onToggleFinder: () => void;
  onAdd: (candidate: MemberGuestCandidate) => void;
  onCancel: () => void;
}

/** #2337: the same finder, reused to link a placeholder row to a real member. */
export interface GuestsCardMemberLink {
  linkFinderGuestId: string | null;
  linkedGuestMembers: Record<string, MemberGuestCandidate>;
  onStartLink: (guestId: string) => void;
  onLink: (guestId: string, candidate: MemberGuestCandidate) => void;
  onUnlink: (guestId: string) => void;
  onCancelLink: () => void;
}

/** The two quick-add strips: the owner's family, and partner-shared doubles. */
export interface GuestsCardQuickAdd {
  familyMembers: FamilyMember[];
  partnerCandidates: PartnerSharingCandidate[];
  onAddFamilyMember: (member: FamilyMember) => void;
  onAddPartnerCandidate: (candidate: PartnerSharingCandidate) => void;
}

/**
 * The reciprocal "other club member" rate (Other Lodges epic, follow-up to
 * #2749): one partner lodge for the booking, then a tick per non-member guest.
 */
export interface GuestsCardOtherLodge {
  /**
   * Whether this viewer is offered the control at all — true when the server
   * shipped the partner-lodge registry, which it does for admins/officers only.
   */
  available: boolean;
  lodges: Array<{ id: string; name: string }>;
  enabled: boolean;
  lodgeId: string | null;
  flaggedGuestIds: ReadonlySet<string>;
  /**
   * #2978: the guests the server will accept a tick for - those currently
   * priced at the club's non-member rate. Decided server-side because it needs
   * membership types and subscription standing, neither of which the client
   * holds; empty for a viewer who was shipped none, so nobody is offered a tick
   * they could not save.
   */
  eligibleGuestIds: ReadonlySet<string>;
  /** False until a lodge is named, which is what disables every guest tick. */
  guestTicksEnabled: boolean;
  /**
   * The fee the pending edit would write for each existing guest, from the
   * quote. Empty until a quote lands; the rows then show their stored fee.
   */
  quotedGuestPriceCents: ReadonlyMap<string, number>;
  onEnabledChange: (enabled: boolean) => void;
  onLodgeIdChange: (lodgeId: string | null) => void;
  onGuestToggle: (guestId: string, flagged: boolean) => void;
}

/** The two ways guests can be given different nights from each other (#713). */
export interface GuestsCardDateModes {
  canEditPerGuestDates: boolean;
  perGuestDatesEnabled: boolean;
  multiDateRangesEnabled: boolean;
  existingGuestNights: Record<string, string[]>;
  onPerGuestDatesChange: (enabled: boolean) => void;
  onMultiDateRangesChange: (enabled: boolean) => void;
  onToggleNight: (rowIndex: number, nightKey: string) => void;
  getExistingGuestRange: (guest: Guest) => { stayStart: string; stayEnd: string };
  onUpdateExistingGuestRange: (
    guestId: string,
    field: "stayStart" | "stayEnd",
    value: string,
  ) => void;
  onUpdateAddedGuestRange: (
    key: string,
    field: "stayStart" | "stayEnd",
    value: string,
  ) => void;
}

/** Editing an existing non-member guest's free-text name (#1386). */
export interface GuestsCardGuestEdits {
  getGuestNameEdit: (guest: Guest) => { firstName: string; lastName: string };
  onUpdateGuestName: (
    guestId: string,
    field: "firstName" | "lastName",
    value: string,
  ) => void;
  onRemoveGuest: (guestId: string) => void;
  onUndoRemoveGuest: (guestId: string) => void;
  onRemoveAddedGuest: (key: string) => void;
}

/** The inline "type in a non-member" form. */
export interface GuestsCardAddForm {
  open: boolean;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  onOpen: () => void;
  onFirstNameChange: (value: string) => void;
  onLastNameChange: (value: string) => void;
  onAgeTierChange: (value: AgeTier) => void;
  onAdd: () => void;
  onCancel: () => void;
}

/**
 * Who is on this booking, and every way this edit can change that.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690). The props arrive in named
 * groups rather than as forty loose values, because the card really does span
 * six sub-surfaces — the member-guest finder, the member link, the two quick-add
 * strips, the night grid, the rows themselves and the inline add form — and a
 * flat list would hide which value belongs to which.
 *
 * Every gate is the one that was here before, including the ones that read
 * oddly: the member-guest button is ABSENT rather than disabled when the module
 * is off, the finder is never capacity-disabled (see the `atCapacity` note), and
 * the finder has NO `isInProgressEdit` gate because an in-progress edit can
 * still add a future guest.
 */
export function EditGuestsCard({
  booking,
  ageTierOptions,
  memberGuestTriggerRef,
  mode,
  party,
  memberGuest,
  memberLink,
  otherLodge,
  quickAdd,
  dateModes,
  guestEdits,
  addForm,
}: {
  booking: BookingData;
  ageTierOptions: AgeTierOption[];
  /**
   * Kept OUT of the `memberGuest` group deliberately: `react-hooks/refs` treats
   * every property read on an object that carries a ref as a render-time ref
   * access, so grouping it made eight unrelated reads on this card lint errors.
   */
  memberGuestTriggerRef: RefObject<HTMLButtonElement | null>;
  mode: GuestsCardMode;
  party: GuestsCardParty;
  memberGuest: GuestsCardMemberGuest;
  memberLink: GuestsCardMemberLink;
  otherLodge: GuestsCardOtherLodge;
  quickAdd: GuestsCardQuickAdd;
  dateModes: GuestsCardDateModes;
  guestEdits: GuestsCardGuestEdits;
  addForm: GuestsCardAddForm;
}) {
  const { remainingGuests, addedGuests } = party;
  const existingMemberIds = [
    ...remainingGuests
      .map((guest) => guest.memberId)
      .filter((id): id is string => Boolean(id)),
    ...addedGuests
      .map((guest) => guest.memberId)
      .filter((id): id is string => Boolean(id)),
  ];

  return (
    <Card>
      <CardHeader>
        {/*
          TWO BUTTONS, member-guest first - owner sign-off, 1 Aug 2026, and the
          wizard's exact header shape (`guest-form.tsx` renders the same pair,
          with `headerActions` before its own non-member button). A member
          guest leads because it is the cheaper, better-recorded outcome and
          should be the one that catches the eye.

          MODULE OFF: the member-guest button is ABSENT - not disabled, and
          with nothing in its place - and the non-member button stays exactly
          where it was. That is what the wizard does, and it is what keeps a
          club that never adopted the feature looking untouched.
        */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Guests ({party.totalGuestCount})</CardTitle>
          <div className="flex flex-wrap gap-2">
            {booking.memberGuest?.enabled && !mode.overrideEnabled ? (
              // NOT capacity-disabled, deliberately — see the `atCapacity`
              // note on the finder below. The panel holds no capacity signal
              // that is true of the CURRENT party before a quote exists, and
              // an over-capacity add is refused by the quote with a reason
              // rather than by a silent grey button.
              <Button
                ref={memberGuestTriggerRef}
                type="button"
                variant={memberGuest.finderOpen ? "secondary" : "outline"}
                size="sm"
                onClick={memberGuest.onToggleFinder}
              >
                + Add Member Guest
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={addForm.onOpen}
              disabled={addForm.open || mode.overrideEnabled}
            >
              {mode.isInProgressEdit
                ? "+ Add Future Non-Member Guest"
                : "+ Add Non-Member Guest"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/*
          The finder, INLINE in the card content directly under the header -
          the wizard's `belowHeader` slot, in the surface that has no such
          slot. Gated on the server's module answer (never guessed here) AND
          on `!overrideEnabled`, which matches both quick-add blocks below for
          the reason they have it: an admin date-override edit is date-only by
          construction, so growing a guest surface on it would offer a change
          the override path does not carry.

          No `isInProgressEdit` gate, deliberately - an in-progress edit can
          still add a future guest, and a member guest is no different from
          any other addition there.
        */}
        {booking.memberGuest?.enabled &&
        !mode.overrideEnabled &&
        memberGuest.finderOpen ? (
          <EditMemberGuestFinder
            bookingId={booking.id}
            actingAsAdmin={booking.viewerRole === "ADMIN"}
            openSearchEnabled={booking.memberGuest.openSearchEnabled}
            approvalRequired={booking.memberGuest.approvalRequired}
            existingMemberIds={existingMemberIds}
            /*
              ALWAYS FALSE, AND THAT IS THE HONEST ANSWER HERE (MG4 #2309).
              The prop means "the party is already at the lodge's capacity, so
              do not let another person be selected", and this panel has no
              signal that answers it. `quote.capacityAvailable` is the wrong
              one twice over: it exists only once the booker has made a change
              (there is no quote on an untouched panel, which is exactly when
              the finder is first opened), and it describes the PROPOSED party
              — including the very guest just added — rather than the current
              one, so a false there would disable the control that caused it.
              Fetching lodge capacity separately would be a second source of
              truth for a rule the quote already enforces.

              WHERE THE REFUSAL SURFACES INSTEAD: the modify-quote round trip.
              An over-capacity add comes back as a quote refusal and is shown
              in the panel's error line, and the over-capacity confirm flow
              (#1668) covers the admin case. A greyed-out button with no
              explanation would be strictly worse than a clear refusal.
            */
            atCapacity={false}
            addError={memberGuest.addError}
            refusedCandidate={
              memberGuest.addError ? memberGuest.lastAttempt : null
            }
            onAdd={memberGuest.onAdd}
            onCancel={memberGuest.onCancel}
          />
        ) : null}
        {/*
          #2337: the SAME member finder, reused to link a placeholder to a
          member rather than to add a new guest. `linkFinderGuestId` names the
          placeholder row that opened it; the chosen candidate becomes that
          row's member identity, and the panel re-quotes to show the re-rate.
        */}
        {mode.memberLinkEnabled && memberLink.linkFinderGuestId ? (
          <EditMemberGuestFinder
            bookingId={booking.id}
            actingAsAdmin
            openSearchEnabled={booking.memberGuest?.openSearchEnabled ?? false}
            approvalRequired={booking.memberGuest?.approvalRequired ?? false}
            existingMemberIds={[
              ...existingMemberIds,
              ...Object.values(memberLink.linkedGuestMembers).map(
                (candidate) => candidate.memberId,
              ),
            ]}
            atCapacity={false}
            addError={null}
            refusedCandidate={null}
            onAdd={(candidate) =>
              memberLink.onLink(memberLink.linkFinderGuestId as string, candidate)
            }
            onCancel={memberLink.onCancelLink}
          />
        ) : null}
        {mode.isInProgressEdit ? (
          <p className="text-sm text-muted-foreground">
            Added guests start on {mode.minEditableDate}. Removing an existing
            guest keeps their past and NZ today occupancy and removes only
            future nights.
          </p>
        ) : null}
        {quickAdd.familyMembers.length > 0 && !mode.overrideEnabled && (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <p className="text-sm font-medium text-muted-foreground">Quick add family members</p>
            <div className="flex flex-wrap gap-2">
              {quickAdd.familyMembers.map((familyMember) => {
                const alreadyAdded = booking.guests.some((guest) => guest.memberId === familyMember.id)
                  || addedGuests.some((guest) => guest.memberId === familyMember.id);
                const label = familyMember.relationship === "self"
                  ? `${familyMember.firstName} ${familyMember.lastName}`
                  : `${familyMember.firstName} ${familyMember.lastName} (${getAgeTierLabel(ageTierOptions, familyMember.ageTier)})`;

                return (
                  <Button
                    key={familyMember.id}
                    type="button"
                    variant={alreadyAdded ? "secondary" : familyMember.relationship === "self" ? "default" : "outline"}
                    size="sm"
                    disabled={alreadyAdded}
                    onClick={() => quickAdd.onAddFamilyMember(familyMember)}
                  >
                    {alreadyAdded ? "\u2713 " : "+ "}
                    {label}
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        {quickAdd.partnerCandidates.length > 0 && !mode.overrideEnabled && (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <p className="text-sm font-medium text-muted-foreground">
              Add a partner (shares a double bed)
            </p>
            <div className="flex flex-wrap gap-2">
              {quickAdd.partnerCandidates.map((candidate) => {
                const alreadyAdded = booking.guests.some((guest) => guest.memberId === candidate.id)
                  || addedGuests.some((guest) => guest.memberId === candidate.id);
                return (
                  <Button
                    key={candidate.id}
                    type="button"
                    variant={alreadyAdded ? "secondary" : "outline"}
                    size="sm"
                    disabled={alreadyAdded}
                    onClick={() => quickAdd.onAddPartnerCandidate(candidate)}
                  >
                    {alreadyAdded ? "\u2713 " : "+ "}
                    {candidate.firstName} {candidate.lastName} — partner of {candidate.partnerOfName}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              A partner can be added even when the lodge is full by beds:
              they use a reserved double-bed slot (one per double) and must
              then be placed as the second occupant on the allocation board.
            </p>
          </div>
        )}

        {dateModes.canEditPerGuestDates && !dateModes.multiDateRangesEnabled ? (
          <label className="flex items-center gap-2 rounded-md border p-3 text-sm">
            <input
              type="checkbox"
              checked={dateModes.perGuestDatesEnabled}
              onChange={(e) => dateModes.onPerGuestDatesChange(e.target.checked)}
              className="h-4 w-4"
            />
            <span className="font-medium">Per guest booking dates</span>
          </label>
        ) : null}

        {!mode.isInProgressEdit && !mode.overrideEnabled ? (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={dateModes.multiDateRangesEnabled}
                onChange={(e) => dateModes.onMultiDateRangesChange(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="font-medium">Multiple date ranges</span>
            </label>
            {dateModes.multiDateRangesEnabled ? (
              <GuestNightGrid
                guestLabels={[
                  ...remainingGuests.map(
                    (g) => `${g.firstName} ${g.lastName}`.trim(),
                  ),
                  ...addedGuests.map(
                    (g, i) =>
                      `${g.firstName} ${g.lastName}`.trim() ||
                      `New guest ${i + 1}`,
                  ),
                ]}
                nights={eachNightKey(mode.checkIn, mode.checkOut)}
                isNightOn={(rowIndex, nightKey) => {
                  if (rowIndex < remainingGuests.length) {
                    const guest = remainingGuests[rowIndex];
                    const set = dateModes.existingGuestNights[guest.id];
                    return set ? set.includes(nightKey) : true;
                  }
                  const added = addedGuests[rowIndex - remainingGuests.length];
                  return added?.nights ? added.nights.includes(nightKey) : true;
                }}
                onToggle={dateModes.onToggleNight}
                arrivalLabel={mode.checkIn}
                departureLabel={mode.checkOut}
              />
            ) : null}
          </div>
        ) : null}

        {/*
          Other Lodges epic: the reciprocal other-club rate.

          A third tick beside "Per guest booking dates" and "Multiple date
          ranges", and deliberately in the same place: all three change how the
          guest rows below are priced or dated, so they read as one group of
          switches over the same list.

          ADMIN-ONLY BY ABSENCE, not by a disabled control — `available` is the
          presence of the server's partner-lodge registry, which a member's
          payload does not carry. A member therefore sees the card exactly as it
          was before this feature. Also hidden under an admin date override,
          which is date-only, and during an in-progress edit, whose planner
          prices future nights through a different path than the one the tick
          reprices — the same two exclusions the multi-range block above carries.
        */}
        {otherLodge.available &&
        !mode.overrideEnabled &&
        !mode.isInProgressEdit ? (
          <OtherLodgeRateControl otherLodge={otherLodge} />
        ) : null}

        {/* Existing guests */}
        {booking.guests.map((guest) => (
          <ExistingGuestRow
            key={guest.id}
            guest={guest}
            isRemoved={party.removedGuestIds.has(guest.id)}
            linkedMember={memberLink.linkedGuestMembers[guest.id]}
            memberLinkEnabled={mode.memberLinkEnabled}
            nonMemberGuestNamesEditable={mode.nonMemberGuestNamesEditable}
            canEditNonMemberGuestNames={booking.canEditNonMemberGuestNames}
            canFixNonMemberGuestNameTypos={booking.canFixNonMemberGuestNameTypos}
            overrideEnabled={mode.overrideEnabled}
            isInProgressEdit={mode.isInProgressEdit}
            perGuestDatesEnabled={dateModes.perGuestDatesEnabled}
            canRemove={
              !mode.overrideEnabled &&
              remainingGuests.length + addedGuests.length > 1
            }
            nameEdit={guestEdits.getGuestNameEdit(guest)}
            range={dateModes.getExistingGuestRange(guest)}
            checkIn={mode.checkIn}
            checkOut={mode.checkOut}
            bookingCheckIn={booking.checkIn}
            bookingCheckOut={booking.checkOut}
            ageTierOptions={ageTierOptions}
            onUpdateName={(field, value) =>
              guestEdits.onUpdateGuestName(guest.id, field, value)
            }
            onUpdateRange={(field, value) =>
              dateModes.onUpdateExistingGuestRange(guest.id, field, value)
            }
            onRemove={() => guestEdits.onRemoveGuest(guest.id)}
            onUndoRemove={() => guestEdits.onUndoRemoveGuest(guest.id)}
            onStartLink={() => memberLink.onStartLink(guest.id)}
            onUnlink={() => memberLink.onUnlink(guest.id)}
            otherLodgeRate={
              // The tick COLUMN exists only while "Member of Other Lodge" is
              // ticked. Off, the rows are exactly what they were before this
              // feature — no empty column indenting every name for a rate the
              // officer is not setting.
              otherLodge.available &&
              otherLodge.enabled &&
              !mode.overrideEnabled &&
              !mode.isInProgressEdit
                ? {
                    // #2978: offered to whoever currently prices at the club's
                    // NON-MEMBER rate, which is NOT the same as `!isMember`. A
                    // non-member contact re-added through the member-guest
                    // finder carries `isMember` while resolving to the built-in
                    // NON_MEMBER type, and they are exactly who a reciprocal
                    // rate is for.
                    //
                    // The set is resolved SERVER-side by the same helper the
                    // save fences on, rather than re-derived here from
                    // `isMember`: the client cannot see membership types or
                    // subscription standing, so deriving it here would offer
                    // ticks the save refuses. Empty for a non-admin viewer.
                    //
                    // `|| checked` IS LOAD-BEARING, and its absence made a
                    // booking uneditable. Eligibility is judged now, but the
                    // flag was stored earlier: a ticked guest whose membership
                    // type changes, or whose subscription lapses, drops out of
                    // the set. Their box would then disappear while the hook
                    // still submits their id in the complete set, so the quote
                    // AND the save both refuse, and the only escape is to retract
                    // the whole election — the lodge and every other guest with
                    // it. Showing the box for a stored tick means a stale flag
                    // can always be cleared. It cannot be used to CREATE one: an
                    // unticked ineligible guest is not `checked`, and unticking
                    // is the direction the server always allows.
                    offered:
                      otherLodge.eligibleGuestIds.has(guest.id) ||
                      otherLodge.flaggedGuestIds.has(guest.id),
                    // Live only once a lodge is named, and never on a row this
                    // edit is removing.
                    enabled:
                      otherLodge.guestTicksEnabled &&
                      !party.removedGuestIds.has(guest.id),
                    checked: otherLodge.flaggedGuestIds.has(guest.id),
                    onChange: (checked: boolean) =>
                      otherLodge.onGuestToggle(guest.id, checked),
                  }
                : undefined
            }
            quotedPriceCents={otherLodge.quotedGuestPriceCents.get(guest.id)}
          />
        ))}

        {/* Newly added guests */}
        {addedGuests.map((guest) => (
          <AddedGuestRow
            key={guest.key}
            guest={guest}
            ageTierOptions={ageTierOptions}
            perGuestDatesEnabled={dateModes.perGuestDatesEnabled}
            checkIn={mode.checkIn}
            checkOut={mode.checkOut}
            onUpdateRange={(field, value) =>
              dateModes.onUpdateAddedGuestRange(guest.key, field, value)
            }
            onRemove={() => guestEdits.onRemoveAddedGuest(guest.key)}
          />
        ))}

        {/* Add guest inline form */}
        {addForm.open && (
          <div className="border rounded-md p-3 mt-2 space-y-3 bg-card">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="new-guest-first">First Name</Label>
                <Input
                  id="new-guest-first"
                  value={addForm.firstName}
                  onChange={(e) => addForm.onFirstNameChange(e.target.value)}
                  placeholder="First name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-guest-last">Last Name</Label>
                <Input
                  id="new-guest-last"
                  value={addForm.lastName}
                  onChange={(e) => addForm.onLastNameChange(e.target.value)}
                  placeholder="Last name"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="new-guest-age">Age Category</Label>
                <select
                  id="new-guest-age"
                  value={addForm.ageTier}
                  onChange={(e) => addForm.onAgeTierChange(e.target.value as AgeTier)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  {ageTierOptions.map((option) => (
                    <option key={option.tier} value={option.tier}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Typed-in guests are always treated as non-members and charged at non-member rates.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={addForm.onAdd}
                disabled={!addForm.firstName.trim() || !addForm.lastName.trim()}
              >
                Add
              </Button>
              <Button variant="outline" size="sm" onClick={addForm.onCancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
