"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Users, X, Edit2, Search } from "lucide-react";
import { FamilyGroupEditor } from "@/components/admin/family-group-editor";
import { DatasetResetButton } from "@/components/admin/dataset-reset-button";
import { AgeTierBadge } from "@/components/admin/family-groups/age-tier-badge";
import { MemberAgeChip } from "@/components/admin/family-groups/member-age-display";
import { FamilyGroupRequestReviewSection } from "@/components/admin/family-groups/request-review-section";
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action";
import {
  ADMIN_VIEW_ONLY_ACTION_REASON,
  useAdminAreaEditAccess,
} from "@/hooks/use-admin-area-edit-access";
import {
  type FamilyGroupRequest,
  type FamilyGroupSummary,
  type MemberIdentityOption,
} from "@/lib/admin-family-group-ui-helpers";
import { useClubTime } from "@/components/club-time-provider";
import { formatPayloadInstantDate } from "../_lib/payload-instant";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";

type PartnerInvite = {
  id: string;
  invitedEmail: string;
  expiresAt: string;
  createdAt: string;
  familyGroupId: string;
  familyGroupName: string | null;
  createdBy: { id: string; name: string } | null;
};

export default function FamilyGroupsPage() {
  // A partner invite's `expiresAt` and a group's `createdAt` are real INSTANTS,
  // read in the club's PERSISTED zone (`INV-CONFIG-002`). The shared helper they
  // used to go through pinned `APP_TIME_ZONE`, so an expiry an admin abroad was
  // shown could name the wrong day — and an expiry read a day early is exactly
  // the operational hazard the comment beside the invite table already warns
  // about, only from the other direction.
  const clubTime = useClubTime();
  const searchParams = useSearchParams();
  const router = useRouter();
  // Approve/reject writes the membership-area family-groups requests route; a
  // view-only membership admin browses the queue but cannot act (#1997).
  const canEditMembership = useAdminAreaEditAccess("membership");
  const [groups, setGroups] = useState<FamilyGroupSummary[]>([]);
  const [requests, setRequests] = useState<FamilyGroupRequest[]>([]);
  const [partnerInvites, setPartnerInvites] = useState<PartnerInvite[]>([]);
  const [partnerInviteError, setPartnerInviteError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingGroup, setEditingGroup] = useState<FamilyGroupSummary | null>(null);
  const [formName, setFormName] = useState("");
  // #2257 — the example lives UNDER the field, not inside it as grey pseudo-content.
  const groupNameHint = useFieldHint();
  const [memberSearch, setMemberSearch] = useState("");
  // #2568: candidates and the pending set both carry the calculated age — the
  // new-group form is where members are LINKED, an identity-sensitive action.
  const [searchResults, setSearchResults] = useState<MemberIdentityOption[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<MemberIdentityOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // #2256: the create/edit form renders in the anchor below the filter card and
  // the two queue cards (pending changes, outstanding partner invites), while
  // its triggers sit elsewhere — New Group in the page header, Edit on a row in
  // the groups table below. With a populated queue either trigger can be
  // several screens away from the form it opens, so the page used to look like
  // it had ignored the click. Anchor the form region and move focus/viewport to
  // it whenever the form opens.
  const editorAnchorRef = useRef<HTMLDivElement>(null);
  // The control that opened the form, so focus can go back to it on close
  // rather than dropping to <body> when the form unmounts.
  const formTriggerRef = useRef<HTMLElement | null>(null);
  // Bumped on every open. Without it, re-opening the SAME group (or re-opening
  // the create form) changes no state the effect depends on, so an admin who
  // scrolled back down to the table and clicked Edit again got nothing.
  const [formOpenNonce, setFormOpenNonce] = useState(0);
  const { scrollToError } = useScrollToFeedback();

  // P3.1: Search and filter state
  const [filterQuery, setFilterQuery] = useState("");
  const [filterMinMembers, setFilterMinMembers] = useState("");
  const [filterMaxMembers, setFilterMaxMembers] = useState("");
  const [filterHasPending, setFilterHasPending] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [groupsRes, requestsRes, partnerInvitesRes] = await Promise.all([
        fetch("/api/admin/family-groups"),
        fetch("/api/admin/family-groups/requests"),
        fetch("/api/admin/family-groups/partner-invites"),
      ]);
      let fetchedGroups: FamilyGroupSummary[] = [];

      if (groupsRes.ok) {
        const data = await groupsRes.json();
        setGroups(data.familyGroups);
        fetchedGroups = data.familyGroups as FamilyGroupSummary[];
      }
      if (requestsRes.ok) {
        const data = await requestsRes.json();
        const fetchedRequests = data.requests as FamilyGroupRequest[];
        setRequests(fetchedRequests);
      }
      if (partnerInvitesRes.ok) {
        const data = await partnerInvitesRes.json();
        setPartnerInvites((data.invites ?? []) as PartnerInvite[]);
      }
      return fetchedGroups;
    } finally {
      setLoading(false);
    }
    return [] as FamilyGroupSummary[];
  }, []);

  // Debounced member search
  useEffect(() => {
    if (memberSearch.length < 2) {
      setSearchResults([]);
      return;
    }

    let cancelled = false;
    setSearching(true);

    const timer = setTimeout(async () => {
      try {
        // #2568: the family-group lookup, which answers with each candidate's
        // calculated age and no date of birth, and applies the active /
        // non-archived / ten-row limits itself.
        const res = await fetch(
          `/api/admin/family-groups/member-search?q=${encodeURIComponent(memberSearch)}`
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          // Filter out already selected members
          const selectedIds = new Set(selectedMembers.map((m) => m.id));
          setSearchResults(
            data.members
              .filter((m: MemberIdentityOption) => !selectedIds.has(m.id))
              .map((m: MemberIdentityOption) => ({
                id: m.id,
                firstName: m.firstName,
                lastName: m.lastName,
                email: m.email,
                ageLabel: m.ageLabel,
              }))
          );
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [memberSearch, selectedMembers]);

  // P3.1: Client-side filtering
  const filteredGroups = useMemo(() => {
    let result = groups;

    // Text search
    if (filterQuery.trim()) {
      const q = filterQuery.toLowerCase();
      result = result.filter((g) => {
        const nameMatch = g.name?.toLowerCase().includes(q);
        const memberNameMatch = g.members.some(
          (m) =>
            `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) ||
            m.email.toLowerCase().includes(q)
        );
        return nameMatch || memberNameMatch;
      });
    }

    // Member count range
    const min = filterMinMembers ? parseInt(filterMinMembers, 10) : null;
    const max = filterMaxMembers ? parseInt(filterMaxMembers, 10) : null;
    if (min !== null && !isNaN(min)) {
      result = result.filter((g) => g.memberCount >= min);
    }
    if (max !== null && !isNaN(max)) {
      result = result.filter((g) => g.memberCount <= max);
    }

    // Has pending requests
    if (filterHasPending) {
      result = result.filter((g) => g.pendingRequests > 0);
    }

    return result;
  }, [groups, filterQuery, filterMinMembers, filterMaxMembers, filterHasPending]);

  const hasActiveFilters =
    filterQuery.trim() !== "" ||
    filterMinMembers !== "" ||
    filterMaxMembers !== "" ||
    filterHasPending;

  function clearFilters() {
    setFilterQuery("");
    setFilterMinMembers("");
    setFilterMaxMembers("");
    setFilterHasPending(false);
  }

  function openCreateForm(event?: React.MouseEvent<HTMLElement>) {
    if (!canEditMembership) return;
    formTriggerRef.current = event?.currentTarget ?? null;
    setEditingGroup(null);
    setFormName("");
    setSelectedMembers([]);
    setMemberSearch("");
    setSearchResults([]);
    setError("");
    setShowForm(true);
    setFormOpenNonce((nonce) => nonce + 1);
  }

  const openEditForm = useCallback((group: FamilyGroupSummary) => {
    setEditingGroup(group);
    setFormName(group.name || "");
    setSelectedMembers(
      group.members
        .map((m) => ({ id: m.id, firstName: m.firstName, lastName: m.lastName, email: m.email }))
    );
    setMemberSearch("");
    setSearchResults([]);
    setError("");
    setShowForm(true);
    setFormOpenNonce((nonce) => nonce + 1);
  }, []);

  // On mount: fetch data, then auto-open edit dialog if ?edit=GROUP_ID is set.
  useEffect(() => {
    const editId = searchParams.get("edit");
    fetchData().then((fetchedGroups) => {
      if (editId && fetchedGroups) {
        const target = fetchedGroups.find((g: FamilyGroupSummary) => g.id === editId);
        if (target) openEditForm(target);
      }
    });
  }, [fetchData, openEditForm, searchParams]);

  const editingGroupId = editingGroup?.id ?? null;

  // #2256: the row the editor is currently bound to says so, so edit mode stays
  // unmistakable once the page has scrolled away from the row that was clicked.
  const isRowBeingEdited = (id: string) => showForm && editingGroupId === id;

  const formRegionLabel = editingGroup
    ? `Editing ${editingGroup.name || "Unnamed Group"}`
    : "New family group";

  // #2256: bring the form into view (and give it focus, so screen-reader and
  // keyboard users land there too) every time it is opened — create as well as
  // edit, since both triggers can be screens away from where the form renders.
  // Keyed on the open nonce rather than on `showForm`/the group id, so
  // re-opening the same group, or the create form, re-anchors the viewport
  // instead of silently doing nothing.
  useEffect(() => {
    if (!showForm) return;
    scrollToError(editorAnchorRef);
  }, [showForm, formOpenNonce, scrollToError]);

  function addMember(member: MemberIdentityOption) {
    if (!canEditMembership) return;
    setSelectedMembers((prev) => [...prev, member]);
    setMemberSearch("");
    setSearchResults([]);
  }

  function removeMember(id: string) {
    if (!canEditMembership) return;
    setSelectedMembers((prev) => prev.filter((m) => m.id !== id));
  }

  function closeForm() {
    setShowForm(false);
    // #2256: we took focus on open, so we hand it back on close. Without this
    // the form unmounts under the keyboard cursor and focus drops to <body>,
    // stranding keyboard and screen-reader users at the top of the document.
    // The trigger lives outside the form, so it is still mounted here.
    const trigger = formTriggerRef.current;
    formTriggerRef.current = null;
    if (trigger && document.contains(trigger)) trigger.focus();
    // Remove ?edit param from URL when closing
    const params = new URLSearchParams(searchParams.toString());
    params.delete("edit");
    const newSearch = params.toString();
    router.replace(newSearch ? `/admin/family-groups?${newSearch}` : "/admin/family-groups", {
      scroll: false,
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEditMembership) return;
    setError("");
    if (selectedMembers.length < 1) {
      setError("At least one member is required");
      return;
    }
    setSubmitting(true);

    try {
      const payload = {
        name: formName.trim(),
        memberIds: selectedMembers.map((m) => m.id),
      };

      const res = editingGroup
        ? await fetch(`/api/admin/family-groups/${editingGroup.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/family-groups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save");
        return;
      }

      closeForm();
      fetchData();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!canEditMembership) return;
    if (!confirm("Delete this family group? Members will be unlinked.")) return;
    const res = await fetch(`/api/admin/family-groups/${id}`, { method: "DELETE" });
    if (res.ok) {
      fetchData();
    }
  }

  async function handleRevokePartnerInvite(invite: PartnerInvite) {
    if (
      !confirm(
        `Revoke the outstanding invitation to ${invite.invitedEmail}? The link they were sent will stop working.`
      )
    )
      return;
    setPartnerInviteError("");
    try {
      const res = await fetch(
        `/api/admin/family-groups/partner-invites?id=${encodeURIComponent(invite.id)}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        fetchData();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setPartnerInviteError(
        data.error ||
          `Could not revoke the invitation to ${invite.invitedEmail}. It may have just been claimed or already revoked.`
      );
    } catch {
      setPartnerInviteError(
        `Could not revoke the invitation to ${invite.invitedEmail}. Please try again.`
      );
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEditMembership} className="mb-6">
      Your admin role can view family group requests but cannot
      approve or reject them.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Family Groups</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Link primary members together so they appear in each other&apos;s booking quick-add lists
          </p>
        </div>
        <ViewOnlyActionButton canEdit={canEditMembership} describeReason={false} onClick={openCreateForm}>
          <Plus className="h-4 w-4 mr-2" />
          New Group
        </ViewOnlyActionButton>
      </div>

      {/* P3.1: Search and filter bar */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[200px] max-w-md relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Search by group name, member name, or email..."
                className="pl-9"
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Min members</Label>
                <Input
                  type="number"
                  min="0"
                  value={filterMinMembers}
                  onChange={(e) => setFilterMinMembers(e.target.value)}
                  className="w-24"
                  placeholder="0"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Max members</Label>
                <Input
                  type="number"
                  min="0"
                  value={filterMaxMembers}
                  onChange={(e) => setFilterMaxMembers(e.target.value)}
                  className="w-24"
                  placeholder="any"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={filterHasPending}
                onChange={(e) => setFilterHasPending(e.target.checked)}
                className="rounded border-border"
              />
              Has pending requests
            </label>
            <DatasetResetButton
              disabled={!hasActiveFilters}
              onReset={clearFilters}
            />
          </div>
          {hasActiveFilters && (
            <p className="text-xs text-muted-foreground">
              Showing {filteredGroups.length} of {groups.length} group{groups.length !== 1 ? "s" : ""}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Badge className="bg-warning-3 text-warning-11 border-warning-6">
              {requests.length}
            </Badge>
            Pending Family Group Changes
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Review join, infant/child/youth, same-email adult, and removal requests before approving or rejecting.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Loading pending family group changes...
            </div>
          ) : requests.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No family group changes are awaiting review.
            </div>
          ) : (
            <>
              <FamilyGroupRequestReviewSection
                requests={requests}
                onReviewed={async () => {
                  await fetchData();
                }}
                canEdit={canEditMembership}
                showSearchGuidance
                createMemberNoun="member"
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Badge className="bg-warning-3 text-warning-11 border-warning-6">
              {partnerInvites.length}
            </Badge>
            Outstanding Partner Invitations
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Email invitations to partners who do not have an account yet. They
            join through the membership process, then accept the invite. Revoke
            one to disable its link.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {partnerInviteError && (
            <div className="rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11">
              {partnerInviteError}
            </div>
          )}
          {loading ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Loading outstanding partner invitations...
            </div>
          ) : partnerInvites.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No outstanding partner invitations.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Invited email</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Group</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Invited by</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Expires</th>
                    <th className="text-right px-4 py-2 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {partnerInvites.map((invite) => (
                    <tr key={invite.id} className="border-b hover:bg-accent">
                      <td className="px-4 py-2 font-medium">{invite.invitedEmail}</td>
                      <td className="px-4 py-2">
                        {invite.familyGroupName || "Unnamed Group"}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {invite.createdBy?.name || "Unknown"}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {/* #2256: the club's locale/zone, not the browser's —
                            an expiry read as "4/16/2026" (or a day early) is a
                            real operational hazard here. The shared helper also
                            guards a malformed value, which Intl would otherwise
                            throw a RangeError on. */}
                        {formatPayloadInstantDate(clubTime, invite.expiresAt, "Not provided")}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevokePartnerInvite(invite)}
                          className="text-danger-11 hover:text-danger-11 hover:bg-danger-3"
                        >
                          <X className="h-4 w-4 mr-1" />
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit form. Named region only while the form is open: focus
          lands here from New Group or a row's Edit button, and the label is
          what tells an assistive-tech user what they just opened. An unnamed
          empty landmark would only add noise, so role, label and tabIndex are
          all conditional on the form being open. While closed the div must be
          `hidden`, not merely empty: an empty box would still be a `space-y-6`
          child and double the gap between the cards around it. */}
      <div
        ref={editorAnchorRef}
        className={showForm ? "scroll-mt-20 focus:outline-none" : "hidden"}
        role={showForm ? "region" : undefined}
        aria-label={showForm ? formRegionLabel : undefined}
        tabIndex={showForm ? -1 : undefined}
      >
      {showForm && (
        editingGroup ? (
          <FamilyGroupEditor
            groupId={editingGroup.id}
            onClose={closeForm}
            onChanged={() => {
              void fetchData();
            }}
            canEdit={canEditMembership}
            // #2160: the page banner above is unconditional and covers this
            // whole membership surface, including the editor rendered inline
            // here, so the editor must not repeat it. The dialog mount on
            // /admin/members/[id] keeps its own banner — a dialog is a separate
            // accessibility container that no ancestor banner reaches.
            renderViewOnlyBanner={false}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">New Family Group</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="groupName">Group Name</Label>
                  <Input
                    id="groupName"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    required
                    disabled={canEditMembership !== true}
                    {...groupNameHint.fieldProps}
                  />
                  <FieldHint {...groupNameHint.hintProps}>
                    Example: Smith Family
                  </FieldHint>
                </div>

                <div>
                  <Label>Members</Label>
                  {selectedMembers.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2 mb-2">
                      {selectedMembers.map((m) => (
                        <Badge
                          key={m.id}
                          variant="secondary"
                          // #2568: wraps rather than overflowing once a long name
                          // and an age share the pill on a narrow screen.
                          className="flex max-w-full flex-wrap items-center gap-1 py-1 px-2"
                        >
                          <span className="break-words">
                            {m.firstName} {m.lastName}
                          </span>
                          <MemberAgeChip ageLabel={m.ageLabel} />
                          <button
                            type="button"
                            onClick={() => removeMember(m.id)}
                            disabled={canEditMembership !== true}
                            title={canEditMembership === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
                            className="ml-1 hover:text-danger-11 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-current"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    <Input
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder="Search members by name or email..."
                      disabled={canEditMembership !== true}
                    />
                    {searching && (
                      <div className="absolute right-3 top-2.5 text-xs text-muted-foreground">
                        Searching...
                      </div>
                    )}
                    {searchResults.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-card border rounded-md shadow-lg max-h-48 overflow-y-auto">
                        {searchResults.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => addMember(m)}
                            disabled={canEditMembership !== true}
                            className="w-full text-left px-3 py-2 hover:bg-accent text-sm disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {/* #2568: age beside the name, so the admin links
                                the intended generation. */}
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="break-words font-medium">
                                {m.firstName} {m.lastName}
                              </span>
                              <MemberAgeChip ageLabel={m.ageLabel} />
                            </span>
                            <span className="block break-words text-muted-foreground">
                              {m.email}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Add adults, youth, or children to this family group
                  </p>
                </div>

                {error && <p className="text-sm text-danger-11">{error}</p>}

                <div className="flex gap-2">
                  <ViewOnlyActionButton
                    canEdit={canEditMembership}
                    describeReason={false}
                    type="submit"
                    disabled={submitting || selectedMembers.length < 1}
                  >
                    {submitting ? "Saving..." : "Create Group"}
                  </ViewOnlyActionButton>
                  <Button type="button" variant="outline" onClick={closeForm}>
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )
      )}
      </div>

      {/* Groups table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-center text-muted-foreground">Loading...</div>
          ) : filteredGroups.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              {hasActiveFilters
                ? "No family groups match the current filters."
                : "No family groups yet. Create one to link members together."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Group Name</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Members</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Created</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGroups.map((g) => (
                    <tr
                      key={g.id}
                      // #2256: the edited row uses the info tone that matches
                      // its "Editing" badge, NOT the hover token — a row that
                      // looks merely hovered does not read as a state. Keeping
                      // it off `hover:bg-accent` stops the hover colour
                      // overwriting the state colour under the cursor.
                      className={`border-b ${isRowBeingEdited(g.id) ? "bg-info-3" : "hover:bg-accent"}`}
                      aria-current={isRowBeingEdited(g.id) ? "true" : undefined}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Users className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{g.name || "Unnamed Group"}</span>
                          {isRowBeingEdited(g.id) && (
                            <Badge className="bg-info-3 text-info-11 border-info-6 text-xs">
                              Editing
                            </Badge>
                          )}
                          {g.pendingRequests > 0 && (
                            <Badge className="bg-warning-3 text-warning-11 border-warning-6 text-xs">
                              {g.pendingRequests} pending
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {/* #2568: NO age on these pills. This is the routine
                            Family Group overview — a roster of who is in each
                            group, with no action attached to an individual
                            member. Age belongs to the identity-sensitive
                            screens (the new-group form above, the request
                            review cards, and the per-group editor), and the
                            list payload deliberately does not carry it. */}
                        <div className="flex flex-wrap gap-1">
                          {g.members
                            .map((m) => (
                              <Badge
                                key={m.id}
                                variant="secondary"
                                className={`text-xs flex items-center gap-1 ${!m.active ? "opacity-50" : ""}`}
                              >
                                {m.firstName} {m.lastName}
                                {/* P3.2: Age tier badge */}
                                <AgeTierBadge tier={m.ageTier} />
                                {!m.active && (
                                  <span className="ml-1 text-muted-foreground">(inactive)</span>
                                )}
                              </Badge>
                            ))}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {g.memberCount} member{g.memberCount !== 1 ? "s" : ""}
                          {g.inactiveCount > 0 && (
                            <span className="text-muted-foreground">
                              {" "}({g.inactiveCount} inactive)
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatPayloadInstantDate(clubTime, g.createdAt, "Not provided")}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          {/* Edit opens the editor, which is itself edit-gated
                              internally (#2065). Opening it stays available so a
                              view-only membership admin can browse the group —
                              mirroring the members/[id] "open editor" trigger,
                              which is an ungated Button. */}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(event) => {
                              // Remember the trigger so closeForm can hand
                              // focus back to it (#2256).
                              formTriggerRef.current = event.currentTarget;
                              openEditForm(g);
                            }}
                            aria-label={`Edit ${g.name || "Unnamed Group"}`}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <ViewOnlyActionButton
                            canEdit={canEditMembership}
                            describeReason={false}
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(g.id)}
                            className="text-danger-11 hover:text-danger-11 hover:bg-danger-3"
                            aria-label={`Delete ${g.name || "Unnamed Group"}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </ViewOnlyActionButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
