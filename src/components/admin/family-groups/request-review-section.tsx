"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useClubTime } from "@/components/club-time-provider";
import { FamilyGroupRequestReviewCard } from "@/components/admin/family-groups/request-review-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildInitialRequestNotificationParents,
  buildInitialRequestSelections,
  getFamilyGroupRequestSubjectName,
  mapFamilyGroupRequestSearchResults,
  type FamilyGroupRequest,
  type RequestMemberMatch,
} from "@/lib/admin-family-group-ui-helpers";

// #1789: only the CHILD_REQUEST and GROUP_CREATE decisions email the requester
// (approve and reject alike), so only those actions open the notify-choice
// dialog. ADULT_REQUEST / JOIN_REQUEST / REMOVAL_REQUEST send no requester
// decision email, so they submit directly without asking.
function requestActionEmailsMember(type: FamilyGroupRequest["type"]): boolean {
  return type === "CHILD_REQUEST" || type === "GROUP_CREATE";
}

export interface FamilyGroupRequestReviewSectionProps {
  requests: FamilyGroupRequest[];
  /** Refresh callback fired after a request is approved or rejected. */
  onReviewed: () => void | Promise<void>;
  idPrefix?: string;
  /** Whether the actor may approve/reject requests (membership edit, #1997). */
  // Tri-state (#2065): `undefined` while the session resolves (neutral disabled).
  canEdit: boolean | undefined;
  showSearchGuidance?: boolean;
  /**
   * Noun used in the "create a new non-login <noun>" guard message. The admin
   * list phrases this as "member"; the per-group editor phrases it as "adult".
   */
  createMemberNoun?: "member" | "adult";
}

/**
 * Shared request-review list rendered on both the family-groups admin page and
 * inside the family-group editor. Owns the per-request review state (selections,
 * search terms/results, notes, notification parents, errors, and in-flight ids)
 * and the approve/reject/search handlers so neither call site re-implements it.
 * Renders a fragment of cards so the caller's list spacing stays intact.
 */
export function FamilyGroupRequestReviewSection({
  requests,
  onReviewed,
  idPrefix,
  canEdit,
  showSearchGuidance = false,
  createMemberNoun = "member",
}: FamilyGroupRequestReviewSectionProps) {
  /*
    The club's PERSISTED zone, read ONCE for the whole list (CT-4, #2870;
    `INV-CONFIG-002`).

    This is the only place in this feature that reads the provider. The card
    below takes the binding as a prop instead of calling the hook itself, so a
    queue of forty requests constructs one binding rather than forty — and the
    card stays a presentational component with no directive of its own. Its
    prop docblock carries the full reasoning.
  */
  const clubTime = useClubTime();
  // Seed the default selections/notification parents from the initial request
  // list so the first paint already shows the auto-selected records (the caller
  // only mounts this section once `requests` is non-empty).
  const [requestSelections, setRequestSelections] = useState<Record<string, string>>(() =>
    buildInitialRequestSelections(requests, {})
  );
  const [requestSearchTerms, setRequestSearchTerms] = useState<Record<string, string>>({});
  const [requestSearchResults, setRequestSearchResults] = useState<Record<string, RequestMemberMatch[]>>({});
  const [requestSearchFeedback, setRequestSearchFeedback] = useState<Record<string, string>>({});
  const [requestNotes, setRequestNotes] = useState<Record<string, string>>({});
  const [requestNotificationParents, setRequestNotificationParents] = useState<Record<string, string>>(() =>
    buildInitialRequestNotificationParents(requests, {})
  );
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [requestSearchingId, setRequestSearchingId] = useState<string | null>(null);
  const [requestSubmittingId, setRequestSubmittingId] = useState<string | null>(null);
  // #1789: the approve/reject action whose member-email choice is pending, and
  // whether the choice dialog is open. Only emailing decisions (CHILD_REQUEST /
  // GROUP_CREATE) populate this; the choice is kept set while the dialog fades
  // out so the copy never flickers to a stale action's wording.
  const [notifyChoice, setNotifyChoice] = useState<{
    request: FamilyGroupRequest;
    action: "approve" | "reject";
  } | null>(null);
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);

  // Re-seed defaults whenever the request list is (re)loaded. Merging with the
  // current maps preserves any in-flight edits for requests that are still
  // present.
  useEffect(() => {
    setRequestSelections((current) => buildInitialRequestSelections(requests, current));
    setRequestNotificationParents((current) =>
      buildInitialRequestNotificationParents(requests, current)
    );
  }, [requests]);

  function clearRequestError(requestId: string) {
    setRequestErrors((current) => {
      if (!current[requestId]) {
        return current;
      }
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }

  function clearRequestSearchFeedback(requestId: string) {
    setRequestSearchFeedback((current) => {
      if (!current[requestId]) {
        return current;
      }
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }

  async function searchRequestMembers(request: FamilyGroupRequest) {
    const query =
      requestSearchTerms[request.id]?.trim() ||
      getFamilyGroupRequestSubjectName(request);

    if (query.length < 2) {
      setRequestErrors((current) => ({
        ...current,
        [request.id]: "Enter at least 2 characters to search for an existing member record.",
      }));
      return;
    }

    clearRequestError(request.id);
    clearRequestSearchFeedback(request.id);
    setRequestSearchingId(request.id);

    try {
      const ageTierSearchFilter =
        request.type === "CHILD_REQUEST" ? "&ageTierIn=INFANT,CHILD,YOUTH" : "";
      // #2568: the family-group lookup, not the members admin search. It answers
      // with each candidate's CALCULATED AGE and no date of birth, and restricts
      // itself to active, non-archived members capped at ten rows — the filters
      // the members endpoint had to be told about in the query string.
      const res = await fetch(
        `/api/admin/family-groups/member-search?q=${encodeURIComponent(query)}${ageTierSearchFilter}`
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setRequestErrors((current) => ({
          ...current,
          [request.id]: data.error || "Failed to search member records.",
        }));
        return;
      }

      const foundMembers = mapFamilyGroupRequestSearchResults(
        request,
        data.members ?? []
      );

      setRequestSearchResults((current) => ({
        ...current,
        [request.id]: foundMembers,
      }));

      if (foundMembers.length === 1) {
        setRequestSelections((current) => ({
          ...current,
          [request.id]: foundMembers[0].id,
        }));
      }

      setRequestSearchFeedback((current) => ({
        ...current,
        [request.id]:
          foundMembers.length === 0
            ? `No eligible member records found for "${query}".`
            : foundMembers.length === 1
              ? `Found and selected ${foundMembers[0].firstName} ${foundMembers[0].lastName}.`
              : `Found ${foundMembers.length} member records.`,
      }));
    } finally {
      setRequestSearchingId((current) => (current === request.id ? null : current));
    }
  }

  // Validate the action, then either open the member-email choice dialog (for
  // emailing decisions) or submit straight away (#1789). Non-emailing decisions
  // never carry a notifyMember flag.
  function handleRequest(request: FamilyGroupRequest, action: "approve" | "reject") {
    clearRequestError(request.id);

    const linkedMemberId = requestSelections[request.id];
    const needsMemberSelection =
      request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST";

    if (action === "approve" && needsMemberSelection && !linkedMemberId) {
      setRequestErrors((current) => ({
        ...current,
        [request.id]: `Choose the member record to link, or create a new non-login ${createMemberNoun} where available.`,
      }));
      return;
    }

    if (requestActionEmailsMember(request.type)) {
      setNotifyChoice({ request, action });
      setNotifyDialogOpen(true);
      return;
    }

    void submitRequest(request, action);
  }

  // #1789: dispatch the pending notify choice. Close the dialog without clearing
  // the choice so the content keeps its wording while it fades out.
  function confirmNotify(notifyMember: boolean) {
    const choice = notifyChoice;
    setNotifyDialogOpen(false);
    if (!choice) return;
    void submitRequest(choice.request, choice.action, notifyMember);
  }

  async function submitRequest(
    request: FamilyGroupRequest,
    action: "approve" | "reject",
    notifyMember?: boolean
  ) {
    const linkedMemberId = requestSelections[request.id];
    const needsMemberSelection =
      request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST";

    setRequestSubmittingId(request.id);

    try {
      const res = await fetch("/api/admin/family-groups/requests", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: request.id,
          action,
          ...(action === "approve" && needsMemberSelection && linkedMemberId
            ? linkedMemberId === "__create__"
              ? { createNewMember: true }
              : {
                  linkedMemberId,
                  ...(request.type === "CHILD_REQUEST"
                    ? { inheritEmailFromId: requestNotificationParents[request.id] ?? request.requester.id }
                    : {}),
                }
            : {}),
          ...(action === "reject" && requestNotes[request.id]?.trim()
            ? { rejectionReason: requestNotes[request.id].trim() }
            : {}),
          // Only carry the flag when a choice was made (emailing decisions); an
          // omitted flag threads as undefined and the server defaults to notify.
          ...(notifyMember !== undefined ? { notifyMember } : {}),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRequestErrors((current) => ({
          ...current,
          [request.id]: data.error || `Failed to ${action} request.`,
        }));
        return;
      }

      setRequestSearchResults((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setRequestSearchTerms((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setRequestSearchFeedback((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setRequestNotes((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });

      // #1789: reflect the email choice after an emailing decision. On a
      // GROUP_CREATE approval the requester notice is the only email the choice
      // suppresses — the token-bearing partner invitation is never gated by it
      // (it is sent when the partner is still eligible, skipped otherwise). Word
      // the note so it states the invariant (unaffected by this choice) rather
      // than asserting an invite definitely went out, since the client does not
      // know whether approval-time eligibility skipped it.
      if (notifyMember === false) {
        const partnerNote =
          request.type === "GROUP_CREATE" && action === "approve" && request.invitedMemberId
            ? " Any partner invitation is unaffected by this choice."
            : "";
        toast.success(
          `Request ${action === "approve" ? "approved" : "rejected"} — the member was not emailed.${partnerNote}`
        );
      } else if (notifyMember === true) {
        toast.success(
          `Request ${action === "approve" ? "approved" : "rejected"} and the member was emailed.`
        );
      }

      await onReviewed();
    } finally {
      setRequestSubmittingId((current) => (current === request.id ? null : current));
    }
  }

  return (
    <>
      {requests.map((request) => (
        <FamilyGroupRequestReviewCard
          key={request.id}
          idPrefix={idPrefix}
          request={request}
          clubTime={clubTime}
          requestSelection={requestSelections[request.id]}
          requestSearchTerm={requestSearchTerms[request.id]}
          searchedMembers={requestSearchResults[request.id] ?? []}
          requestSearchMessage={requestSearchFeedback[request.id]}
          requestNote={requestNotes[request.id]}
          requestNotificationParentId={requestNotificationParents[request.id]}
          requestError={requestErrors[request.id]}
          searching={requestSearchingId === request.id}
          submitting={requestSubmittingId === request.id}
          canEdit={canEdit}
          showSearchGuidance={showSearchGuidance}
          showRemovalDetails
          onClearRequestFeedback={() => {
            clearRequestError(request.id);
            clearRequestSearchFeedback(request.id);
          }}
          onSearchMembers={() => searchRequestMembers(request)}
          onSelectMember={(memberId) =>
            setRequestSelections((current) => ({
              ...current,
              [request.id]: memberId,
            }))
          }
          onSearchTermChange={(value) =>
            setRequestSearchTerms((current) => ({
              ...current,
              [request.id]: value,
            }))
          }
          onNotificationParentChange={(memberId) =>
            setRequestNotificationParents((current) => ({
              ...current,
              [request.id]: memberId,
            }))
          }
          onNoteChange={(value) =>
            setRequestNotes((current) => ({
              ...current,
              [request.id]: value,
            }))
          }
          onApprove={() => handleRequest(request, "approve")}
          onReject={() => handleRequest(request, "reject")}
        />
      ))}

      {/* #1789: per-decision member-email choice, mirroring the #1705/#1769a
          pattern. Shown only when the decision would email the requester
          (CHILD_REQUEST / GROUP_CREATE). Both choices complete the decision; the
          choice itself is recorded in the audit log. On a GROUP_CREATE approval
          the token-bearing partner invitation is always sent regardless. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => {
          if (!open && requestSubmittingId === null) setNotifyDialogOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {notifyChoice?.action === "reject"
                ? "Email the member about this rejection?"
                : "Email the member about this approval?"}
            </DialogTitle>
            <DialogDescription>
              {notifyChoice?.request.type === "GROUP_CREATE" &&
              notifyChoice?.action === "approve"
                ? "The family group is created either way. Choose whether the requester receives the standard approval email. Any pending partner invitation is always sent so the invited partner can join — your choice is recorded in the audit log."
                : notifyChoice?.action === "reject"
                  ? "The request is rejected either way. Choose whether the member receives the standard rejection email — your choice is recorded in the audit log."
                  : "The request is approved either way. Choose whether the member receives the standard approval email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={requestSubmittingId !== null}
              onClick={() => confirmNotify(false)}
            >
              {notifyChoice?.action === "reject"
                ? "Reject without emailing"
                : "Approve without emailing"}
            </Button>
            <Button
              disabled={requestSubmittingId !== null}
              onClick={() => confirmNotify(true)}
            >
              {notifyChoice?.action === "reject"
                ? "Reject and email member"
                : "Approve and email member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
