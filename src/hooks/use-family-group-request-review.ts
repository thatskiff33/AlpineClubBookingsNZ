"use client";

import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  buildInitialRequestNotificationParents,
  buildInitialRequestSelections,
  getFamilyGroupRequestSubjectName,
  mapFamilyGroupRequestSearchResults,
  type FamilyGroupRequest,
  type RequestMemberMatch,
} from "@/lib/admin-family-group-ui-helpers";
import type { FamilyGroupRequestReviewCardProps } from "@/components/admin/family-groups/request-review-card";

export type FamilyGroupRequestAction = "approve" | "reject";

export interface UseFamilyGroupRequestReviewOptions {
  /** Refetch the surface's data after a request is approved or rejected. */
  onRefresh: () => void | Promise<unknown>;
  /**
   * Validation copy shown when an approve action still needs a member record to
   * be chosen. The admin list and the editor word this slightly differently
   * ("non-login member" vs "non-login adult"), so each caller supplies its own.
   */
  missingSelectionError: string;
}

/**
 * Props shared by every `FamilyGroupRequestReviewCard` rendered from this hook.
 * Callers spread these and add the surface-specific `idPrefix` /
 * `showSearchGuidance` bits themselves.
 */
export type FamilyGroupRequestReviewCardBaseProps = Omit<
  FamilyGroupRequestReviewCardProps,
  "idPrefix" | "showSearchGuidance"
>;

export interface FamilyGroupRequestReview {
  requestSelections: Record<string, string>;
  requestSearchTerms: Record<string, string>;
  requestSearchResults: Record<string, RequestMemberMatch[]>;
  requestSearchFeedback: Record<string, string>;
  requestNotes: Record<string, string>;
  requestNotificationParents: Record<string, string>;
  requestErrors: Record<string, string>;
  requestSearchingId: string | null;
  requestSubmittingId: string | null;
  setRequestSelections: Dispatch<SetStateAction<Record<string, string>>>;
  setRequestNotificationParents: Dispatch<SetStateAction<Record<string, string>>>;
  /** Seed selections/notification-parent defaults from a freshly fetched list. */
  initializeRequestState: (requests: FamilyGroupRequest[]) => void;
  clearRequestError: (requestId: string) => void;
  clearRequestSearchFeedback: (requestId: string) => void;
  searchRequestMembers: (request: FamilyGroupRequest) => Promise<void>;
  handleRequest: (
    request: FamilyGroupRequest,
    action: FamilyGroupRequestAction
  ) => Promise<void>;
  /** Build the wiring shared by both review-card surfaces for one request. */
  getRequestReviewCardProps: (
    request: FamilyGroupRequest
  ) => FamilyGroupRequestReviewCardBaseProps;
}

/**
 * Owns the shared "review a pending family-group request" state and handlers used
 * by both the admin family-groups list page and the family-group editor. Keeping
 * this in one place removes the large member-search / approve-reject clones that
 * previously lived in both components.
 */
export function useFamilyGroupRequestReview(
  options: UseFamilyGroupRequestReviewOptions
): FamilyGroupRequestReview {
  const { onRefresh, missingSelectionError } = options;

  const [requestSelections, setRequestSelections] = useState<Record<string, string>>({});
  const [requestSearchTerms, setRequestSearchTerms] = useState<Record<string, string>>({});
  const [requestSearchResults, setRequestSearchResults] = useState<
    Record<string, RequestMemberMatch[]>
  >({});
  const [requestSearchFeedback, setRequestSearchFeedback] = useState<Record<string, string>>({});
  const [requestNotes, setRequestNotes] = useState<Record<string, string>>({});
  const [requestNotificationParents, setRequestNotificationParents] = useState<
    Record<string, string>
  >({});
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [requestSearchingId, setRequestSearchingId] = useState<string | null>(null);
  const [requestSubmittingId, setRequestSubmittingId] = useState<string | null>(null);

  // Stable identity so callers can safely list it in fetch-callback dependency
  // arrays without re-triggering their mount effects each render.
  const initializeRequestState = useCallback((requests: FamilyGroupRequest[]) => {
    setRequestSelections((current) => buildInitialRequestSelections(requests, current));
    setRequestNotificationParents((current) =>
      buildInitialRequestNotificationParents(requests, current)
    );
  }, []);

  function clearRequestError(requestId: string) {
    setRequestErrors((current) => {
      if (!current[requestId]) return current;
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }

  function clearRequestSearchFeedback(requestId: string) {
    setRequestSearchFeedback((current) => {
      if (!current[requestId]) return current;
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
      const res = await fetch(
        `/api/admin/members?q=${encodeURIComponent(query)}&active=true&pageSize=10${ageTierSearchFilter}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRequestErrors((current) => ({
          ...current,
          [request.id]: data.error || "Failed to search member records.",
        }));
        return;
      }

      const foundMembers = mapFamilyGroupRequestSearchResults(request, data.members ?? []);

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

  async function handleRequest(
    request: FamilyGroupRequest,
    action: FamilyGroupRequestAction
  ) {
    clearRequestError(request.id);
    const linkedMemberId = requestSelections[request.id];
    const needsMemberSelection =
      request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST";

    if (action === "approve" && needsMemberSelection && !linkedMemberId) {
      setRequestErrors((current) => ({
        ...current,
        [request.id]: missingSelectionError,
      }));
      return;
    }

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

      await onRefresh();
    } finally {
      setRequestSubmittingId((current) => (current === request.id ? null : current));
    }
  }

  function getRequestReviewCardProps(
    request: FamilyGroupRequest
  ): FamilyGroupRequestReviewCardBaseProps {
    return {
      request,
      requestSelection: requestSelections[request.id],
      requestSearchTerm: requestSearchTerms[request.id],
      searchedMembers: requestSearchResults[request.id] ?? [],
      requestSearchMessage: requestSearchFeedback[request.id],
      requestNote: requestNotes[request.id],
      requestNotificationParentId: requestNotificationParents[request.id],
      requestError: requestErrors[request.id],
      searching: requestSearchingId === request.id,
      submitting: requestSubmittingId === request.id,
      showRemovalDetails: true,
      onClearRequestFeedback: () => {
        clearRequestError(request.id);
        clearRequestSearchFeedback(request.id);
      },
      onSearchMembers: () => searchRequestMembers(request),
      onSelectMember: (memberId) =>
        setRequestSelections((current) => ({
          ...current,
          [request.id]: memberId,
        })),
      onSearchTermChange: (value) =>
        setRequestSearchTerms((current) => ({
          ...current,
          [request.id]: value,
        })),
      onNotificationParentChange: (memberId) =>
        setRequestNotificationParents((current) => ({
          ...current,
          [request.id]: memberId,
        })),
      onNoteChange: (value) =>
        setRequestNotes((current) => ({
          ...current,
          [request.id]: value,
        })),
      onApprove: () => handleRequest(request, "approve"),
      onReject: () => handleRequest(request, "reject"),
    };
  }

  return {
    requestSelections,
    requestSearchTerms,
    requestSearchResults,
    requestSearchFeedback,
    requestNotes,
    requestNotificationParents,
    requestErrors,
    requestSearchingId,
    requestSubmittingId,
    setRequestSelections,
    setRequestNotificationParents,
    initializeRequestState,
    clearRequestError,
    clearRequestSearchFeedback,
    searchRequestMembers,
    handleRequest,
    getRequestReviewCardProps,
  };
}
