import { Check, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  dedupeParentOptions,
  formatFamilyGroupCalendarDay,
  formatFamilyGroupInstantDate,
  getFamilyGroupRequestBadgeClass,
  getFamilyGroupRequestSubjectName,
  getFamilyGroupRequestSummary,
  getFamilyGroupRequestTypeLabel,
  getMemberName,
  mergeFamilyGroupRequestCandidates,
  type FamilyGroupRequest,
  type ParentLinkSummary,
  type RequestMemberMatch,
} from "@/lib/admin-family-group-ui-helpers";
import type { BoundClubTime } from "@/lib/club-time";
import { AgeTierBadge } from "@/components/admin/family-groups/age-tier-badge";
import {
  MemberAgeChip,
  MemberAgeLine,
} from "@/components/admin/family-groups/member-age-display";

export interface FamilyGroupRequestReviewCardProps {
  request: FamilyGroupRequest;
  /*
    The club's PERSISTED timezone, bound (CT-4, #2870; `INV-CONFIG-002`).

    A PROP RATHER THAN A HOOK, deliberately. This card is a presentational
    component with no state and no `"use client"` directive of its own — the
    house shape in this folder — and `useClubTime` would make it a hook consumer
    and pull the directive in behind it. Its only parent,
    `request-review-section.tsx`, is already a client component and reads the
    provider once for the whole list.

    It dates ONE value: the request's `createdAt`. Every other date on this card
    is a calendar day, which takes no zone at all.
  */
  clubTime: BoundClubTime;
  idPrefix?: string;
  requestSelection?: string;
  requestSearchTerm?: string;
  searchedMembers: RequestMemberMatch[];
  requestSearchMessage?: string;
  requestNote?: string;
  requestNotificationParentId?: string;
  requestError?: string;
  searching: boolean;
  submitting: boolean;
  /** Whether the actor may act on the request (membership edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined;
  showSearchGuidance?: boolean;
  showRemovalDetails?: boolean;
  onSelectMember: (memberId: string) => void;
  onSearchTermChange: (value: string) => void;
  onSearchMembers: () => void;
  onNotificationParentChange: (memberId: string) => void;
  onNoteChange: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onClearRequestFeedback: () => void;
}

export function FamilyGroupRequestReviewCard({
  request,
  clubTime,
  idPrefix = "",
  requestSelection,
  requestSearchTerm = "",
  searchedMembers,
  requestSearchMessage,
  requestNote = "",
  requestNotificationParentId,
  requestError,
  searching,
  submitting,
  canEdit,
  showSearchGuidance = false,
  showRemovalDetails = false,
  onSelectMember,
  onSearchTermChange,
  onSearchMembers,
  onNotificationParentChange,
  onNoteChange,
  onApprove,
  onReject,
  onClearRequestFeedback,
}: FamilyGroupRequestReviewCardProps) {
  const candidateMembers = mergeFamilyGroupRequestCandidates(request, searchedMembers);
  const selectedCandidate = candidateMembers.find(
    (candidate) => candidate.id === requestSelection
  );
  const requiresMemberChoice =
    request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST";
  const selectedCreateNew = requestSelection === "__create__";
  const canCreateChildMember =
    request.type === "CHILD_REQUEST" &&
    request.matchingMembers.length === 0 &&
    request.canCreateMemberFromRequest === true;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={getFamilyGroupRequestBadgeClass(request)}>
              {getFamilyGroupRequestTypeLabel(request)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {/* A real INSTANT, in the club's persisted zone — the same
                  authority the family-groups page beside this card reads the
                  GROUP's own "Created" stamp under (CT-4, #2870). */}
              Requested {formatFamilyGroupInstantDate(clubTime, request.createdAt)}
            </span>
          </div>
          <p className="text-sm font-semibold text-foreground">
            {getFamilyGroupRequestSummary(request)}
          </p>
        </div>
        {/* #2568: the person MAKING the request, named as such and carrying
            their own age — on a join request they are also the person being
            added, so this is an identity check, not decoration. `min-w-0` plus
            `break-words` keeps a long name inside the panel on a narrow screen
            instead of stretching the row. */}
        <div className="min-w-0 rounded-lg bg-muted px-3 py-2 text-sm">
          <p className="font-medium text-foreground">Requester</p>
          <p className="break-words text-muted-foreground">
            {getMemberName(request.requester)}
          </p>
          <p className="break-words text-xs text-muted-foreground">
            {request.requester.email}
          </p>
          <MemberAgeLine
            ageLabel={request.requester.ageLabel}
            className="text-xs text-muted-foreground"
          />
        </div>
      </div>

      {request.type === "GROUP_CREATE" ? (
        <div className="mt-4 space-y-1 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
          <p>
            Proposed group name:{" "}
            <span className="font-medium text-foreground">
              {request.familyGroup.name || "Unnamed Group"}
            </span>
          </p>
          <p>
            {getMemberName(request.requester)} will become the group admin.
          </p>
          {request.invitedMember ? (
            <>
              <p>
                Partner to invite on approval:{" "}
                <span className="font-medium text-foreground">
                  {getMemberName(request.invitedMember)}
                </span>{" "}
                ({request.invitedMember.email})
              </p>
              {/* #2568: approving this creates a real invitation for that
                  specific member record, so the admin confirms who it is. */}
              <MemberAgeLine ageLabel={request.invitedMember.ageLabel} />
            </>
          ) : (
            <p>No partner invitation requested.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Bundled infant/child/youth requests appear as separate cards for this
            group — approve this group creation first.
          </p>
        </div>
      ) : requiresMemberChoice ? (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            <p>
              Person to add ({request.type === "ADULT_REQUEST" ? "adult" : "member"}):{" "}
              <span className="break-words font-medium text-foreground">
                {getFamilyGroupRequestSubjectName(request)}
              </span>
            </p>
            <p>
              {/* A `@db.Date` CALENDAR DAY, rendered with no zone. Projecting
                  it is `INV-DATE-019`; for a club behind UTC this screen dated
                  a child a day early, and the day decides their age tier
                  (CT-4, #2870). */}
              Date of birth:{" "}
              {formatFamilyGroupCalendarDay(
                request.type === "ADULT_REQUEST"
                  ? request.requestedDateOfBirth
                  : request.childDateOfBirth
              )}
            </p>
            {/* #2568: the same declared date of birth as an age, so it can be
                compared with a candidate record's age without arithmetic. */}
            <MemberAgeLine
              ageLabel={
                request.type === "ADULT_REQUEST"
                  ? request.requestedAgeLabel
                  : request.childAgeLabel
              }
            />
            {request.type === "ADULT_REQUEST" && (
              <p>Shared email: {request.requestedEmail || request.requester.email}</p>
            )}
            {request.type === "CHILD_REQUEST" && (
              request.requestedAgeTier ? (
                <p>
                  {/* #2568: the age above and this tier answer DIFFERENT
                      questions, and the tier label carries numeric ranges, so
                      the basis is stated rather than left to be inferred. Age is
                      as at today; an age tier is fixed at the season start
                      (1 April by default) and holds until the next rollover — so
                      a child who has had a birthday since then legitimately
                      reads "5 years" beside "Infant (0-4)". Unlabelled, that
                      pairing looks like a corrupt record and invites an admin to
                      "correct" a tier that is right by club policy. */}
                  Requested age tier{" "}
                  <span className="whitespace-nowrap">(as at season start)</span>:{" "}
                  <span className="font-medium text-foreground">
                    {request.requestedAgeTierLabel ?? request.requestedAgeTier}
                  </span>
                </p>
              ) : (
                <p>Requested age tier: Not available without DOB</p>
              )
            )}
          </div>

          <div>
            <Label htmlFor={`${idPrefix}request-member-${request.id}`}>
              {request.type === "ADULT_REQUEST"
                ? "Adult member record"
                : canCreateChildMember
                  ? "Dependant member record"
                  : "Suggested matches"}
            </Label>
            <select
              id={`${idPrefix}request-member-${request.id}`}
              value={requestSelection ?? ""}
              onChange={(event) => {
                onClearRequestFeedback();
                onSelectMember(event.target.value);
              }}
              className="mt-2 flex h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
            >
              <option value="">Select a member record</option>
              {request.type === "ADULT_REQUEST" && (
                <option value="__create__">Create new non-login adult from request</option>
              )}
              {canCreateChildMember && (
                <option value="__create__">Create new non-login dependant from request</option>
              )}
              {candidateMembers.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {getMemberName(candidate)}
                  {" - "}
                  {candidate.ageTier}
                  {/* #2568: an <option> cannot hold markup, so the age goes in
                      as plain text — the picker is where two same-named records
                      are actually told apart. */}
                  {candidate.ageLabel ? ` - ${candidate.ageLabel}` : ""}
                  {candidate.canLogin ? " - has login" : " - no login"}
                  {candidate.alreadyInGroup ? " - already in group" : ""}
                  {!candidate.active ? " - inactive" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={requestSearchTerm}
              onChange={(event) => {
                onClearRequestFeedback();
                onSearchTermChange(event.target.value);
              }}
              placeholder="Search members by name or email..."
            />
            <Button
              type="button"
              variant="outline"
              onClick={onSearchMembers}
              disabled={searching}
            >
              <Search className="mr-2 h-4 w-4" />
              {searching ? "Searching..." : "Search"}
            </Button>
          </div>

          {showSearchGuidance && (
            <p className="text-xs text-muted-foreground">
              {request.type === "ADULT_REQUEST"
                ? "Same-email adult approvals can link an existing non-login adult or create a new non-login adult."
                : canCreateChildMember
                  ? "No suggested match was found. Create a non-login dependant only if this is a missing member record."
                  : request.childDateOfBirth
                    ? "This requested tier is link-only. Link an existing member record or reject the request."
                    : "Legacy child requests without DOB are link-only. Link an existing member record or reject the request."}
            </p>
          )}

          {requestSearchMessage && (
            <p className="text-xs font-medium text-muted-foreground">{requestSearchMessage}</p>
          )}

          {searchedMembers.length > 0 && (
            <div className="space-y-2 rounded-md border border-border bg-card p-2">
              {searchedMembers.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => {
                    onClearRequestFeedback();
                    onSelectMember(candidate.id);
                  }}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                    requestSelection === candidate.id
                      ? "border-warning-6 bg-warning-3"
                      : "border-border bg-card hover:bg-accent"
                  }`}
                >
                  {/* #2568: age sits next to the name and the age tier, where
                      the admin is looking — a suggested match is where the wrong
                      generation gets picked. The row wraps, so a long name
                      pushes the badges down rather than off the card. */}
                  <span className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                    <span className="break-words">{getMemberName(candidate)}</span>
                    <AgeTierBadge tier={candidate.ageTier} />
                    <MemberAgeChip ageLabel={candidate.ageLabel} />
                    {requestSelection === candidate.id && (
                      <Badge variant="secondary" className="bg-warning-3 text-warning-11 border-warning-6">
                        Selected
                      </Badge>
                    )}
                  </span>
                  <span className="mt-1 block break-words text-xs text-muted-foreground">
                    {candidate.email}
                    {candidate.canLogin ? " - has login" : " - no login"}
                    {candidate.alreadyInGroup ? " - already in this group" : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {request.type === "REMOVAL_REQUEST"
            ? "Approving removes the selected member from this family group only. Rejection leaves membership unchanged."
            : "Rejecting leaves the family group unchanged. Approving adds the requester to this group immediately."}
        </p>
      )}

      {showRemovalDetails && request.type === "REMOVAL_REQUEST" && (
        <div className="mt-4 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
          <p>
            Member to remove:{" "}
            <span className="break-words font-medium text-foreground">
              {request.subjectMember ? getMemberName(request.subjectMember) : "Unknown member"}
            </span>
          </p>
          {request.subjectMember && (
            <>
              <p className="break-words">
                {request.subjectMember.email} - {request.subjectMember.ageTier}
              </p>
              {/* #2568: removal is the action hardest to notice going wrong, so
                  the age is stated on the confirmation itself. */}
              <MemberAgeLine ageLabel={request.subjectMember.ageLabel} />
            </>
          )}
          {request.requestNotes && <p>Notes: {request.requestNotes}</p>}
        </div>
      )}

      {requiresMemberChoice && selectedCandidate && (
        <div className="mt-4 rounded-lg border border-warning-6 bg-warning-3/60 p-3">
          <p className="text-sm font-medium text-foreground">
            Selected member record — check this is the right person
          </p>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            {getMemberName(selectedCandidate)}
          </p>
          {/* #2568: the last panel before Approve, so the age is stated on its
              own line rather than buried in the dash-separated run. */}
          <MemberAgeLine
            ageLabel={selectedCandidate.ageLabel}
            className="text-sm text-muted-foreground"
          />
          <p className="break-words text-xs text-muted-foreground">
            {selectedCandidate.email}
            {" - "}
            {selectedCandidate.ageTier}
            {selectedCandidate.canLogin ? " - has login" : " - no login"}
            {selectedCandidate.alreadyInGroup ? " - already in this group" : ""}
            {!selectedCandidate.active ? " - inactive" : ""}
          </p>
          {request.type === "CHILD_REQUEST" && (
            <div className="mt-3 space-y-2">
              <Label htmlFor={`${idPrefix}request-notification-${request.id}`}>
                Notification email recipient
              </Label>
              <select
                id={`${idPrefix}request-notification-${request.id}`}
                value={requestNotificationParentId ?? request.requester.id}
                onChange={(event) => onNotificationParentChange(event.target.value)}
                className="flex h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
              >
                <option value="">Use child&apos;s own email</option>
                {dedupeParentOptions([
                  ...(selectedCandidate.parentLinks ?? []),
                  buildFallbackParentOption(
                    request,
                    (selectedCandidate.parentLinks?.length ?? 0) === 0
                  ),
                ]).map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {getMemberName(parent)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {request.type === "ADULT_REQUEST" && selectedCreateNew && (
        <div className="mt-4 rounded-lg border border-cat1-6 bg-cat1-3/60 p-3">
          <p className="text-sm font-medium text-foreground">
            New non-login adult will be created
          </p>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            {getFamilyGroupRequestSubjectName(request)}
          </p>
          <p className="break-words text-xs text-muted-foreground">
            {request.requestedEmail || request.requester.email}
            {request.requestedDateOfBirth
              ? ` - DOB ${formatFamilyGroupCalendarDay(request.requestedDateOfBirth)}`
              : ""}
          </p>
          {/* #2568: creating a brand-new record is the decision a duplicate
              hides behind, so the age of the person about to be created is
              stated here as well. */}
          <MemberAgeLine
            ageLabel={request.requestedAgeLabel}
            className="text-xs text-muted-foreground"
          />
        </div>
      )}

      {request.type === "CHILD_REQUEST" && selectedCreateNew && (
        <div className="mt-4 rounded-lg border border-info-6 bg-info-3/60 p-3">
          <p className="text-sm font-medium text-foreground">
            New non-login dependant will be created
          </p>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            {getFamilyGroupRequestSubjectName(request)}
          </p>
          <p className="break-words text-xs text-muted-foreground">
            {request.childDateOfBirth
              ? `DOB ${formatFamilyGroupCalendarDay(request.childDateOfBirth)}`
              : "DOB not provided"}
            {/* #2568: same basis note as the tier line above — the ranged tier
                label is as at the season start, the age below it is as at
                today. */}
            {request.requestedAgeTierLabel
              ? ` - ${request.requestedAgeTierLabel} as at season start`
              : ""}
          </p>
          {/* #2568: see the adult branch above — same create-versus-link risk. */}
          <MemberAgeLine
            ageLabel={request.childAgeLabel}
            className="text-xs text-muted-foreground"
          />
        </div>
      )}

      <div className="mt-4">
        <Label htmlFor={`${idPrefix}request-note-${request.id}`}>Optional rejection note</Label>
        <Input
          id={`${idPrefix}request-note-${request.id}`}
          value={requestNote}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="Why should this request be rejected?"
          className="mt-2"
        />
      </div>

      {requestError && <p className="mt-4 text-sm text-danger-11">{requestError}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ViewOnlyActionButton
          canEdit={canEdit}
          type="button"
          onClick={onApprove}
          disabled={submitting || (requiresMemberChoice && !requestSelection)}
        >
          <Check className="mr-2 h-4 w-4" />
          {submitting
            ? "Saving..."
            : request.type === "CHILD_REQUEST"
              ? selectedCreateNew
                ? "Approve and Create Dependant"
                : "Approve and Link Member"
              : request.type === "ADULT_REQUEST"
                ? selectedCreateNew
                  ? "Approve and Create Adult"
                  : "Approve and Link Adult"
                : request.type === "REMOVAL_REQUEST"
                  ? "Approve Removal"
                  : "Approve Request"}
        </ViewOnlyActionButton>
        <ViewOnlyActionButton
          canEdit={canEdit}
          type="button"
          variant="outline"
          onClick={onReject}
          disabled={submitting}
        >
          <X className="mr-2 h-4 w-4" />
          {submitting ? "Saving..." : "Reject Request"}
        </ViewOnlyActionButton>
      </div>
    </div>
  );
}

function buildFallbackParentOption(
  request: FamilyGroupRequest,
  usePrimaryLink: boolean
): ParentLinkSummary {
  return {
    ...request.requester,
    parentLinkType: usePrimaryLink ? "PRIMARY" : "SECONDARY",
  };
}
