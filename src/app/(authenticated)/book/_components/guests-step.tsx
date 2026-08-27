"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MemberGuestFindPanel } from "@/components/book/member-guest-find-panel";
import { GuestForm, type GuestData } from "@/components/guest-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getFamilyMemberBookingActionLabel,
  getFamilyMemberBookingBlockMessage,
} from "@/lib/family-booking";
import { describeMemberGuestConsentBadge } from "@/lib/member-guest-consent-card";
import type { MemberGuestCandidate } from "@/lib/member-guest-find";
import { formatClubDate, requireCalendarDate } from "@/lib/club-time";
import {
  describeMemberGuestWizardHelper,
  memberGuestConsentPreviewColumns,
} from "./member-guest-preview";
import {
  PROFILE_FAMILY_GROUP_RETURN_TO_BOOK,
  type FamilyMember,
  type GroupPaymentMode,
  type PriceQuote,
} from "./types";

interface GuestsStepProps {
  // NZ date-only lodge nights (#2474).
  checkIn: string | null;
  checkOut: string | null;
  nights: number;
  familyMembers: FamilyMember[];
  guests: GuestData[];
  lodgeCapacity: number;
  addFamilyMemberAsGuest: (fm: FamilyMember) => void;
  showInviteFamilyGroupMembersLink: boolean;
  handleGuestsChange: (nextGuests: GuestData[]) => void;
  perGuestDatesEnabled: boolean;
  handlePerGuestDatesEnabledChange: (enabled: boolean) => void;
  multiDateRangesEnabled: boolean;
  handleMultiDateRangesEnabledChange: (enabled: boolean) => void;
  priceQuote: PriceQuote | null;
  groupBookingsEnabled: boolean;
  groupTrip: boolean;
  setGroupTrip: (value: boolean) => void;
  groupPaymentMode: GroupPaymentMode;
  setGroupPaymentMode: (mode: GroupPaymentMode) => void;
  setStep: (step: "dates" | "guests" | "review" | "pay") => void;
  handleGuestsDone: () => void | Promise<void>;
  priceLoading: boolean;
  // "+ Add Member Guest" (MG3 #2308). `memberGuestEnabled` is the server's
  // answer, not the browser's guess — see `MemberGuestConfig` in the wizard hook.
  memberGuestEnabled: boolean;
  memberGuestOpenSearchEnabled: boolean;
  addMemberGuest: (candidate: MemberGuestCandidate) => void;
  memberGuestAddError: string | null;
}

export function GuestsStep({
  checkIn,
  checkOut,
  nights,
  familyMembers,
  guests,
  lodgeCapacity,
  addFamilyMemberAsGuest,
  showInviteFamilyGroupMembersLink,
  handleGuestsChange,
  perGuestDatesEnabled,
  handlePerGuestDatesEnabledChange,
  multiDateRangesEnabled,
  handleMultiDateRangesEnabledChange,
  priceQuote,
  groupBookingsEnabled,
  groupTrip,
  setGroupTrip,
  groupPaymentMode,
  setGroupPaymentMode,
  setStep,
  handleGuestsDone,
  priceLoading,
  memberGuestEnabled,
  memberGuestOpenSearchEnabled,
  addMemberGuest,
  memberGuestAddError,
}: GuestsStepProps) {
  // The find panel opens INLINE, underneath the Guests heading (owner sign-off
  // answer 3) — never a dialog.
  const [findPanelOpen, setFindPanelOpen] = useState(false);
  // Who the last add was about, so a refusal can be shown beneath a chip naming
  // them (mockup panel 13) instead of floating above a blank search box. The
  // panel closes on add and the server answers on the quote that follows, so by
  // the time the refusal arrives the panel's own selection is gone (F9).
  const [lastAddAttempt, setLastAddAttempt] = useState<MemberGuestCandidate | null>(
    null,
  );
  // Focus has to go somewhere when the panel unmounts, or Escape drops it on the
  // document body and a keyboard user is stranded at the top of the page (F5).
  const findTriggerRef = useRef<HTMLButtonElement>(null);
  const closeFindPanel = () => {
    setFindPanelOpen(false);
    findTriggerRef.current?.focus();
  };
  // A D-8 refusal comes back AFTER the panel has closed (the add is optimistic;
  // the server answers on the quote that follows). Re-opening puts the one
  // neutral sentence beside the person the booker was adding, which is where the
  // signed-off mockup draws it — and is why the wizard clears its page-level
  // banner for this one code instead of saying the same thing twice.
  useEffect(() => {
    if (memberGuestAddError) setFindPanelOpen(true);
  }, [memberGuestAddError]);
  // Tri-state for the "add as a non-member guest" fallback warning (#1942). The
  // live quote only computes nonMemberHoldDecision once a non-member is already
  // in the party, so the FIRST non-member add has no decision yet — warn
  // conditionally in that case rather than omitting the consequence entirely:
  //   - a non-member already in the party + quote says hold applies → "applies"
  //   - a non-member already in the party + quote says it does not    → "none"
  //   - no non-member in the party yet (decision unavailable)          → "conditional"
  const partyHasNonMember = guests.some((g) => !g.isMember);
  const holdPolicy: "applies" | "conditional" | "none" = !partyHasNonMember
    ? "conditional"
    : priceQuote?.nonMemberHoldDecision?.shouldBePending === true
      ? "applies"
      : "none";

  // Active steer (#1942): a typed-in non-member guest whose first+last name
  // matches one of THIS member's own family group members who can be booked as a
  // linked member guest. Matching is case-insensitive and scoped strictly to the
  // member's own family list. We suggest switching them to the member guest (bed
  // held, member rate, no split) — a suggestion only, never a forced switch.
  //
  // THE NO-ENUMERATION RULE, STATED PRECISELY (rewritten by MG3, #2308). This
  // comment used to assert as a repo-wide invariant that this screen shows
  // "never other members' data — no enumeration". That became conditionally
  // false the moment a club could turn open member search on, and a comment the
  // code no longer honours is worse than no comment. The rule that actually
  // holds is three separate statements:
  //
  //   1. NO ENUMERATION BY DEFAULT. Every club ships with the member-guest
  //      module off; with it on, the finder resolves an EXACT email address the
  //      booker already possesses and nothing else. Neither state lists members.
  //   2. THE #1942 STEER BELOW IS ALWAYS FAMILY-ONLY, whatever any setting says.
  //      It matches against `familyMembers` — this member's own family group,
  //      already sent to this page for the quick-add row — and never against any
  //      wider set. That is unconditional and must stay so.
  //   3. THE MEMBER-GUEST FINDER ENUMERATES ONLY WHEN A CLUB HAS DELIBERATELY
  //      TURNED OPEN SEARCH ON (`openMemberSearchEnabled`, default off). When it
  //      is on the membership name list is browsable BY DESIGN — that is the
  //      setting's whole purpose, the admin toggle says so in those words, and
  //      the rate limits and audit trail make it slow and recorded rather than
  //      impossible.
  const memberSwitchSuggestions = guests
    .map((guest, index) => ({ guest, index }))
    .filter(({ guest }) => {
      if (guest.isMember || guest.memberId) return false;
      const first = guest.firstName.trim().toLowerCase();
      const last = guest.lastName.trim().toLowerCase();
      if (!first || !last) return false;
      return true;
    })
    .map(({ guest, index }) => {
      const first = guest.firstName.trim().toLowerCase();
      const last = guest.lastName.trim().toLowerCase();
      const match = familyMembers.find(
        (fm) =>
          fm.canBeBooked !== false &&
          !guests.some((g) => g.memberId === fm.id) &&
          fm.firstName.trim().toLowerCase() === first &&
          fm.lastName.trim().toLowerCase() === last,
      );
      return match ? { index, guest, match } : null;
    })
    .filter(
      (entry): entry is { index: number; guest: GuestData; match: FamilyMember } =>
        entry !== null,
    );

  function switchGuestToMember(index: number, fm: FamilyMember) {
    if (guests.some((g) => g.memberId === fm.id)) return;
    const next = guests.map((g, i) =>
      i === index
        ? {
            firstName: fm.firstName,
            lastName: fm.lastName,
            ageTier: fm.ageTier,
            isMember: true,
            memberId: fm.id,
            // Preserve any per-guest stay range the member already set.
            ...(perGuestDatesEnabled && g.stayStart && g.stayEnd
              ? { stayStart: g.stayStart, stayEnd: g.stayEnd }
              : {}),
            // Preserve the guest's per-night selection (multi-date-range mode,
            // #713) — switching to a member guest must not silently drop the
            // nights they picked.
            ...(g.nights ? { nights: g.nights } : {}),
          }
        : g,
    );
    handleGuestsChange(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Add Guests
          {checkIn && checkOut && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {/* Lodge nights are CALENDAR DATES and take no zone (CT-4,
                  #2870): the wizard carries `yyyy-MM-dd` end to end (#2474) and
                  the kernel's formatter pins `UTC` over the encoding, so the
                  projection is the identity for every club rather than only for
                  one east of Greenwich. */}
              {formatClubDate(requireCalendarDate(checkIn))} -{" "}
              {formatClubDate(requireCalendarDate(checkOut))} ({nights} night{nights !== 1 ? "s" : ""})
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {familyMembers.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Quick add family members</p>
            <div className="grid gap-2">
              {familyMembers.map((fm) => {
                const alreadyAdded = guests.some((g) => g.memberId === fm.id);
                const blocked = fm.canBeBooked === false;
                const label = fm.relationship === "self"
                  ? `${fm.firstName} ${fm.lastName} (You)`
                  : `${fm.firstName} ${fm.lastName} (${fm.ageTier})`;
                const blockMessage = getFamilyMemberBookingBlockMessage(fm, {
                  holdPolicy,
                });
                const actionLabel = getFamilyMemberBookingActionLabel(fm);
                return (
                  <div
                    key={fm.id}
                    className={blocked ? "rounded-md border border-warning-6 bg-warning-3 p-3" : ""}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant={alreadyAdded ? "secondary" : fm.relationship === "self" ? "default" : "outline"}
                        size="sm"
                        disabled={alreadyAdded || guests.length >= lodgeCapacity || blocked}
                        onClick={() => addFamilyMemberAsGuest(fm)}
                      >
                        {alreadyAdded ? "\u2713 " : "+ "}
                        {label}
                      </Button>
                      {blocked && actionLabel && (
                        actionLabel === "Complete details" ? (
                          <Button asChild variant="outline" size="sm">
                            <Link href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}>
                              {actionLabel}
                            </Link>
                          </Button>
                        ) : (
                          <span className="text-xs font-medium text-warning-11">
                            {actionLabel}
                          </span>
                        )
                      )}
                    </div>
                    {blocked && blockMessage && (
                      <p className="mt-2 text-sm text-warning-11">{blockMessage}</p>
                    )}
                    {blocked && fm.missingFields && fm.missingFields.length > 0 && (
                      <p className="mt-1 text-xs text-warning-11">
                        Missing: {fm.missingFields.join(", ")}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {(showInviteFamilyGroupMembersLink || familyMembers.length > 0) && (
          <div className="rounded-lg border border-dashed border-cat3-6 bg-cat3-3/50 p-4">
            <p className="text-sm text-muted-foreground dark:text-muted-foreground">
              Family member missing? Add or invite them in your User Profile &gt;
              Family Group, then return here to quick add them at member rates.{" "}
              <Link
                href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}
                className="font-medium text-cat3-11 underline underline-offset-4 hover:text-cat3-11"
              >
                Open Family Group in your profile
              </Link>
              .
            </p>
          </div>
        )}
        <GuestForm
          guests={guests}
          onGuestsChange={handleGuestsChange}
          maxGuests={lodgeCapacity}
          headerActions={
            memberGuestEnabled ? (
              <Button
                ref={findTriggerRef}
                type="button"
                variant={findPanelOpen ? "secondary" : "outline"}
                size="sm"
                disabled={guests.length >= lodgeCapacity}
                onClick={() => setFindPanelOpen((open) => !open)}
              >
                + Add Member Guest
              </Button>
            ) : null
          }
          belowHeader={
            memberGuestEnabled && findPanelOpen ? (
              <MemberGuestFindPanel
                openSearchEnabled={memberGuestOpenSearchEnabled}
                existingMemberIds={guests
                  .map((g) => g.memberId)
                  .filter((id): id is string => Boolean(id))}
                atCapacity={guests.length >= lodgeCapacity}
                addError={memberGuestAddError}
                refusedCandidate={memberGuestAddError ? lastAddAttempt : null}
                onAdd={(candidate) => {
                  setLastAddAttempt(candidate);
                  addMemberGuest(candidate);
                  closeFindPanel();
                }}
                onCancel={closeFindPanel}
              />
            ) : null
          }
          renderGuestHelper={(guest) => describeMemberGuestWizardHelper(guest)}
          renderGuestBadge={(guest) => {
            const columns = memberGuestConsentPreviewColumns(guest);
            if (!columns) return null;
            const badge = describeMemberGuestConsentBadge({
              guest: { memberId: guest.memberId ?? null, ...columns },
              // The booking WIZARD's warmer, name-bearing vocabulary — owner
              // sign-off answer 1, produced by the shared badge function's third
              // audience rather than by a copy of its wording here.
              audience: "WIZARD",
              targetFirstName: guest.firstName,
            });
            if (!badge) return null;
            return (
              <span
                className={
                  badge.tone === "pending"
                    ? "rounded-md border border-warning-6 bg-warning-3 px-2 py-0.5 text-xs font-semibold text-warning-11"
                    : badge.tone === "ok"
                      ? "rounded-md border border-success-6 bg-success-3 px-2 py-0.5 text-xs font-semibold text-success-11"
                      : "rounded-md border border-danger-6 bg-danger-3 px-2 py-0.5 text-xs font-semibold text-danger-11"
                }
              >
                {badge.label}
              </span>
            );
          }}
          bookingCheckIn={checkIn ?? undefined}
          bookingCheckOut={checkOut ?? undefined}
          perGuestDatesEnabled={perGuestDatesEnabled}
          onPerGuestDatesEnabledChange={handlePerGuestDatesEnabledChange}
          multiDateRangesEnabled={multiDateRangesEnabled}
          onMultiDateRangesEnabledChange={handleMultiDateRangesEnabledChange}
          nightlyPriceForGuest={(guestIndex, nightKey) => {
            const g = priceQuote?.guests[guestIndex];
            if (!g?.perNightCents || !g?.nightDates) return null;
            const idx = g.nightDates.findIndex(
              (d) => d.slice(0, 10) === nightKey,
            );
            return idx >= 0 ? g.perNightCents[idx] : null;
          }}
        />
        {memberSwitchSuggestions.length > 0 && (
          <div className="space-y-2 rounded-md border border-cat3-6 bg-cat3-3/60 p-4">
            <p className="text-sm font-medium text-cat3-11">
              Add these as member guests instead?
            </p>
            {memberSwitchSuggestions.map(({ index, match }) => (
              <div
                key={`${match.id}-${index}`}
                className="flex flex-col gap-2 text-sm text-cat3-11 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  <strong>
                    {match.firstName} {match.lastName}
                  </strong>{" "}
                  is in your family group. Adding them as a linked member guest
                  holds a bed at member rates now — no provisional hold.
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => switchGuestToMember(index, match)}
                >
                  Add as member guest
                </Button>
              </div>
            ))}
          </div>
        )}
        {groupBookingsEnabled && (
          <div className="space-y-3 rounded-md border border-border p-4">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={groupTrip}
                onChange={(e) => setGroupTrip(e.target.checked)}
                className="rounded border-border"
              />
              Make this a group trip
            </label>
            <p className="text-sm text-muted-foreground">
              Others can join this trip with their own booking via a link
              you share after you confirm.
            </p>
            {groupTrip && (
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="groupPaymentMode"
                    checked={groupPaymentMode === "EACH_PAYS_OWN"}
                    onChange={() => setGroupPaymentMode("EACH_PAYS_OWN")}
                  />
                  Each person pays their own beds
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="groupPaymentMode"
                    checked={groupPaymentMode === "ORGANISER_PAYS"}
                    onChange={() => setGroupPaymentMode("ORGANISER_PAYS")}
                  />
                  You pay for everyone (settle one combined bill)
                </label>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-between pt-4">
          <Button variant="outline" onClick={() => setStep("dates")}>
            Back
          </Button>
          <Button onClick={handleGuestsDone} disabled={priceLoading || guests.length === 0}>
            {priceLoading ? "Calculating price..." : "Continue"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
