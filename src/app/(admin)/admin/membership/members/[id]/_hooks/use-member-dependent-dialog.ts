"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import {
  memberUsesSamePostalAddress,
  shouldDefaultLinkSideEffects,
} from "@/lib/admin-member-detail-helpers";
import { useDebouncedMemberSearch } from "@/hooks/use-debounced-member-search";
import {
  NZ_COUNTRY_NAME,
  withDefaultNzCountry,
  type MemberAddressValues,
} from "@/lib/member-address";
import { formatValidationErrorResponse } from "@/lib/format-validation-errors";
import type {
  DependentDialogMode,
  DependentForm,
  LinkDependentIneligibleMatch,
  LinkDependentSearchResult,
  MemberDetail,
} from "../_types";

const defaultDependentForm: DependentForm = {
  title: "",
  gender: "",
  firstName: "",
  lastName: "",
  email: "",
  dateOfBirth: "",
  phoneCountryCode: "",
  phoneAreaCode: "",
  phoneNumber: "",
  streetAddressLine1: "",
  streetAddressLine2: "",
  streetCity: "",
  streetRegion: "",
  streetPostalCode: "",
  streetCountry: NZ_COUNTRY_NAME,
  postalAddressLine1: "",
  postalAddressLine2: "",
  postalCity: "",
  postalRegion: "",
  postalPostalCode: "",
  postalCountry: NZ_COUNTRY_NAME,
};

// Stable identity so the masked-off state below doesn't churn consumers' memos.
const NO_INELIGIBLE_MATCHES: LinkDependentIneligibleMatch[] = [];

interface UseMemberDependentDialogParams {
  member: MemberDetail | null;
  fetchMember: () => Promise<void>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}

export function useMemberDependentDialog({
  member,
  fetchMember,
  setLoading,
}: UseMemberDependentDialogParams) {
  const memberId = member?.id;

  const [dependentOpen, setDependentOpen] = useState(false);
  const [dependentForm, setDependentForm] =
    useState<DependentForm>(defaultDependentForm);
  const [dependentPostalSameAsPhysical, setDependentPostalSameAsPhysical] =
    useState(false);
  const [dependentSaving, setDependentSaving] = useState(false);
  const [dependentFormError, setDependentFormError] = useState("");
  const [dependentMode, setDependentMode] =
    useState<DependentDialogMode>("create");
  const [linkDependentSearch, setLinkDependentSearch] = useState("");
  // #2254: matches the search found but could not offer, each with the reason,
  // so the empty state can name them instead of saying nothing. Fed by the
  // shared search hook's `onResponse` seam (#2264): the server reports these
  // ALONGSIDE the rows, so they cannot be recovered from the rows themselves.
  const [
    linkDependentIneligibleMatches,
    setLinkDependentIneligibleMatches,
  ] = useState<LinkDependentIneligibleMatch[]>([]);
  // #2254: set only when the server tells us the text search matched no member
  // at all. The rendered results list is NOT that signal — it is filtered
  // client-side — so the empty state must not infer "nobody matched" from it.
  const [linkDependentMatchedNobody, setLinkDependentMatchedNobody] =
    useState(false);
  const [selectedLinkDependent, setSelectedLinkDependent] =
    useState<LinkDependentSearchResult | null>(null);
  const [linkDependentInheritEmail, setLinkDependentInheritEmail] =
    useState(false);
  const [
    linkDependentNotificationParentId,
    setLinkDependentNotificationParentId,
  ] = useState("");
  const [linkDependentDisableLogin, setLinkDependentDisableLogin] =
    useState(false);
  const [linkDependentFamilyGroupIds, setLinkDependentFamilyGroupIds] =
    useState<string[]>([]);

  // #2264: the type-2-characters / wait-300ms / discard-stale-responses
  // machinery is the shared admin member search, used here exactly as the
  // parent-link dialog uses it. One behaviour improves in passing: choosing a
  // candidate used to be a search-effect dependency, so every selection fired a
  // fresh request purely to drop one row. The self-filter is now a render-time
  // memo, so selecting somebody re-filters the rows already in hand.
  const {
    results: linkDependentSearchRows,
    searching: linkDependentSearching,
    error: linkDependentSearchError,
    active: linkDependentSearchActive,
  } = useDebouncedMemberSearch<LinkDependentSearchResult>({
    query: linkDependentSearch,
    enabled: dependentOpen && dependentMode === "link" && Boolean(memberId),
    params: { pageSize: "8", dependentLinkEligibleFor: memberId ?? "" },
    errorFallback: "Failed to search members",
    // #2254: the two empty-state signals live beside `members` in the response,
    // and neither may be inferred from the rendered list (it is filtered
    // client-side below). `onResponse` hands over the whole body for exactly
    // this case.
    onResponse: (payload) => {
      const body = payload as {
        dependentLinkIneligible?: LinkDependentIneligibleMatch[];
        dependentLinkSearchMatchedNobody?: boolean;
      };
      setLinkDependentIneligibleMatches(body.dependentLinkIneligible ?? []);
      setLinkDependentMatchedNobody(
        body.dependentLinkSearchMatchedNobody === true,
      );
    },
  });

  const linkDependentSearchResults = useMemo(
    () =>
      linkDependentSearchRows
        .map((candidate) => ({
          id: candidate.id,
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          email: candidate.email,
          ageTier: candidate.ageTier,
          active: candidate.active,
          canLogin: candidate.canLogin,
          dateOfBirth: candidate.dateOfBirth,
          parentLinks: candidate.parentLinks ?? [],
        }))
        .filter((candidate) => candidate.id !== selectedLinkDependent?.id),
    [linkDependentSearchRows, selectedLinkDependent?.id],
  );

  // The two #2254 signals are masked the same way the hook masks its own
  // results: a closed dialog, a too-short query or a failed search must never
  // render the previous search's leftovers. Clearing them on failure is what
  // the old hand-rolled catch block did, and for the same reason — a stale
  // "nobody matched" would contradict the error message shown beside it.
  const showLinkDependentSignals =
    linkDependentSearchActive && !linkDependentSearchError;

  const openDependentDialog = () => {
    if (!member) return;

    // #2282: the mailbox a dependant of this member actually inherits, resolved
    // by the SERVER with the same walk the create route uses. The old one-hop
    // `inheritEmailFrom?.email || member.email` was right only while the parent
    // was guaranteed to be a usable adult source — with parentage recordable at
    // any age it would prefill a young parent's own address, which the create
    // route then refuses. Falls back to the member's own address only when
    // nothing is reachable, and the dialog says so in that case.
    const inheritedEmailAddress =
      member.dependentEmailSource?.email || member.email;

    setDependentForm({
      title: "",
      gender: "",
      firstName: "",
      lastName: member.lastName,
      email: inheritedEmailAddress,
      dateOfBirth: "",
      phoneCountryCode: member.phoneCountryCode || "",
      phoneAreaCode: member.phoneAreaCode || "",
      phoneNumber: member.phoneNumber || "",
      streetAddressLine1: member.streetAddressLine1 || "",
      streetAddressLine2: member.streetAddressLine2 || "",
      streetCity: member.streetCity || "",
      streetRegion: member.streetRegion || "",
      streetPostalCode: member.streetPostalCode || "",
      streetCountry: withDefaultNzCountry(member.streetCountry),
      postalAddressLine1: member.postalAddressLine1 || "",
      postalAddressLine2: member.postalAddressLine2 || "",
      postalCity: member.postalCity || "",
      postalRegion: member.postalRegion || "",
      postalPostalCode: member.postalPostalCode || "",
      postalCountry: withDefaultNzCountry(member.postalCountry),
    });
    setDependentPostalSameAsPhysical(
      memberUsesSamePostalAddress({
        streetAddressLine1: member.streetAddressLine1,
        streetAddressLine2: member.streetAddressLine2,
        streetCity: member.streetCity,
        streetRegion: member.streetRegion,
        streetPostalCode: member.streetPostalCode,
        streetCountry: member.streetCountry,
        postalAddressLine1: member.postalAddressLine1,
        postalAddressLine2: member.postalAddressLine2,
        postalCity: member.postalCity,
        postalRegion: member.postalRegion,
        postalPostalCode: member.postalPostalCode,
        postalCountry: member.postalCountry,
      }),
    );
    setDependentFormError("");
    setDependentMode("create");
    setLinkDependentSearch("");
    setLinkDependentIneligibleMatches([]);
    setLinkDependentMatchedNobody(false);
    setSelectedLinkDependent(null);
    setLinkDependentInheritEmail(false);
    setLinkDependentNotificationParentId("");
    setLinkDependentDisableLogin(false);
    setLinkDependentFamilyGroupIds(
      member.familyGroups.map((group) => group.id),
    );
    setDependentOpen(true);
  };

  const handleCreateDependent = async () => {
    if (!member) return;

    setDependentSaving(true);
    setDependentFormError("");

    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: dependentForm.title || null,
          gender: dependentForm.gender || null,
          firstName: dependentForm.firstName,
          lastName: dependentForm.lastName,
          email: dependentForm.email,
          dateOfBirth: dependentForm.dateOfBirth || null,
          phoneCountryCode: dependentForm.phoneCountryCode || null,
          phoneAreaCode: dependentForm.phoneAreaCode || null,
          phoneNumber: dependentForm.phoneNumber || null,
          role: "USER",
          active: true,
          canLogin: false,
          parentMemberId: member.id,
          inheritParentEmail: true,
          // #2282: no explicit `inheritEmailFromId`. Sending one pinned the
          // source to a CLIENT-side one-hop read of the parent, which bypassed
          // the server's transitive resolver (#2255) — the very walk that finds
          // the nearest adult when the parent is a young or address-less middle
          // generation. Leaving it out lets the route resolve and validate the
          // source itself, so the created dependant inherits the same mailbox
          // the dialog just told the admin about.
          familyGroupIds: member.familyGroups.map((group) => group.id),
          streetAddressLine1: dependentForm.streetAddressLine1 || null,
          streetAddressLine2: dependentForm.streetAddressLine2 || null,
          streetCity: dependentForm.streetCity || null,
          streetRegion: dependentForm.streetRegion || null,
          streetPostalCode: dependentForm.streetPostalCode || null,
          streetCountry: dependentForm.streetCountry || null,
          postalAddressLine1: dependentForm.postalAddressLine1 || null,
          postalAddressLine2: dependentForm.postalAddressLine2 || null,
          postalCity: dependentForm.postalCity || null,
          postalRegion: dependentForm.postalRegion || null,
          postalPostalCode: dependentForm.postalPostalCode || null,
          postalCountry: dependentForm.postalCountry || null,
          postalSameAsPhysical: dependentPostalSameAsPhysical,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Surface per-field zod errors (one line each) instead of a bare
        // "Validation failed"; the dialog renders them with `whitespace-pre-line`.
        throw new Error(
          formatValidationErrorResponse(data, {
            defaultMessage: "Failed to create dependent",
          }).join("\n"),
        );
      }

      setDependentOpen(false);
      toast.success("Dependent created successfully");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setDependentFormError(
        err instanceof Error ? err.message : "Failed to create dependent",
      );
    } finally {
      setDependentSaving(false);
    }
  };

  const selectLinkDependent = (candidate: LinkDependentSearchResult) => {
    const defaultSideEffects = shouldDefaultLinkSideEffects(candidate.ageTier);
    setSelectedLinkDependent(candidate);
    setLinkDependentInheritEmail(defaultSideEffects);
    setLinkDependentNotificationParentId(
      defaultSideEffects ? (member?.id ?? "") : "",
    );
    setLinkDependentDisableLogin(defaultSideEffects);
    setLinkDependentFamilyGroupIds(
      member?.familyGroups.map((group) => group.id) ?? [],
    );
    setLinkDependentSearch("");
    setLinkDependentIneligibleMatches([]);
    setLinkDependentMatchedNobody(false);
    setDependentFormError("");
  };

  const clearLinkDependent = () => {
    setSelectedLinkDependent(null);
    setLinkDependentInheritEmail(false);
    setLinkDependentNotificationParentId("");
    setLinkDependentDisableLogin(false);
    setLinkDependentFamilyGroupIds(
      member?.familyGroups.map((group) => group.id) ?? [],
    );
    setLinkDependentSearch("");
    setLinkDependentIneligibleMatches([]);
    setLinkDependentMatchedNobody(false);
    setDependentFormError("");
  };

  const toggleLinkFamilyGroup = (familyGroupId: string, checked: boolean) => {
    setLinkDependentFamilyGroupIds((current) =>
      checked
        ? Array.from(new Set([...current, familyGroupId]))
        : current.filter((idValue) => idValue !== familyGroupId),
    );
  };

  const handleLinkDependent = async () => {
    if (!member || !selectedLinkDependent) return;

    setDependentSaving(true);
    setDependentFormError("");

    try {
      const res = await fetch(
        `/api/admin/members/${member.id}/dependents/link`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            memberId: selectedLinkDependent.id,
            inheritEmail:
              Boolean(linkDependentNotificationParentId) ||
              linkDependentInheritEmail,
            inheritEmailFromId: linkDependentNotificationParentId || null,
            disableLogin: linkDependentDisableLogin,
            addToFamilyGroupIds: linkDependentFamilyGroupIds,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Failed to link dependent");
      }

      setDependentOpen(false);
      toast.success("Dependent linked successfully");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setDependentFormError(
        err instanceof Error ? err.message : "Failed to link dependent",
      );
    } finally {
      setDependentSaving(false);
    }
  };

  const updateDependentAddressFields = (
    patch: Partial<MemberAddressValues>,
  ) => {
    setDependentForm((current) => ({ ...current, ...patch }));
  };

  // Suppress unused-variable warnings for state that is still wired into other
  // computations via the closure (inherit flags participate in the inheritEmail
  // request body construction even though they're read inline above).
  void linkDependentInheritEmail;

  return {
    dependentOpen,
    dependentForm,
    dependentPostalSameAsPhysical,
    dependentSaving,
    // A failed search reports through the dialog's own error line, exactly as
    // the parent-link dialog does it (#2264). Derived rather than written into
    // state, so the message clears itself when the next search succeeds.
    dependentFormError: dependentFormError || linkDependentSearchError,
    dependentMode,
    linkDependentSearch,
    linkDependentSearchResults,
    linkDependentIneligibleMatches: showLinkDependentSignals
      ? linkDependentIneligibleMatches
      : NO_INELIGIBLE_MATCHES,
    linkDependentMatchedNobody: showLinkDependentSignals
      ? linkDependentMatchedNobody
      : false,
    linkDependentSearching,
    selectedLinkDependent,
    linkDependentNotificationParentId,
    linkDependentDisableLogin,
    linkDependentFamilyGroupIds,
    setDependentOpen,
    setDependentForm,
    setDependentPostalSameAsPhysical,
    setDependentFormError,
    setDependentMode,
    setLinkDependentSearch,
    setSelectedLinkDependent,
    setLinkDependentInheritEmail,
    setLinkDependentNotificationParentId,
    setLinkDependentDisableLogin,
    openDependentDialog,
    handleCreateDependent,
    selectLinkDependent,
    clearLinkDependent,
    toggleLinkFamilyGroup,
    handleLinkDependent,
    updateDependentAddressFields,
  };
}
