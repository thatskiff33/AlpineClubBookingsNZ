"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Search, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getEffectiveEmail } from "@/lib/member-utils";

interface MemberOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface FamilyGroupMemberRow extends MemberOption {
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  role?: string;
  inheritEmailFromId?: string | null;
  inheritEmailFrom?: { email: string } | null;
  hasPassword?: boolean;
  effectiveEmail?: string;
}

interface FamilyGroup {
  id: string;
  name: string | null;
  createdAt: string;
  members: FamilyGroupMemberRow[];
}

interface RequestMemberMatch extends MemberOption {
  ageTier: string;
  active: boolean;
  canLogin?: boolean;
  dateOfBirth: string | null;
  alreadyInGroup: boolean;
}

interface FamilyGroupRequest {
  id: string;
  type: "JOIN_REQUEST" | "CHILD_REQUEST" | "ADULT_REQUEST" | "REMOVAL_REQUEST";
  createdAt: string;
  requester: { id: string; firstName: string; lastName: string; email: string };
  familyGroup: {
    id: string;
    name: string | null;
    members: { id: string; firstName: string; lastName: string; email?: string; ageTier?: string }[];
  };
  childFirstName?: string | null;
  childLastName?: string | null;
  childDateOfBirth?: string | null;
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
  requestedDateOfBirth?: string | null;
  requestedEmail?: string | null;
  requestNotes?: string | null;
  subjectMemberId?: string | null;
  subjectMember?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    ageTier: string;
    active: boolean;
  } | null;
  matchingMembers: RequestMemberMatch[];
}

interface SharedEmailCluster {
  email: string;
  members: FamilyGroupMemberRow[];
}

export interface FamilyGroupEditorProps {
  groupId: string;
  onClose: () => void;
  onChanged?: () => void;
}

const AGE_TIER_COLORS: Record<string, string> = {
  INFANT: "bg-pink-100 text-pink-700 border-pink-200",
  CHILD: "bg-blue-100 text-blue-700 border-blue-200",
  YOUTH: "bg-purple-100 text-purple-700 border-purple-200",
  ADULT: "bg-slate-100 text-slate-700 border-slate-200",
};

const CHILD_REQUEST_AGE_TIERS = new Set(["INFANT", "CHILD", "YOUTH"]);

const SESSION_LAG_WARNING =
  "The previous holder's session may remain valid for up to 8 hours after the swap.";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function AgeTierBadge({ tier }: { tier: string }) {
  const colors = AGE_TIER_COLORS[tier] || "bg-gray-100 text-gray-700 border-gray-200";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${colors}`}>
      {tier}
    </span>
  );
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not provided";
  return new Date(value).toLocaleDateString();
}

function getMemberName(member: Pick<MemberOption, "firstName" | "lastName">) {
  return `${member.firstName} ${member.lastName}`.trim();
}

function buildSharedEmailClusters(members: FamilyGroupMemberRow[]) {
  const byEmail = new Map<string, FamilyGroupMemberRow[]>();

  for (const member of members) {
    const email = normalizeEmail(member.effectiveEmail || member.email);
    const current = byEmail.get(email) ?? [];
    current.push(member);
    byEmail.set(email, current);
  }

  return Array.from(byEmail.entries())
    .filter(([, clusterMembers]) => clusterMembers.length > 1)
    .map(([email, clusterMembers]) => ({ email, members: clusterMembers }));
}

export function FamilyGroupEditor({
  groupId,
  onClose,
  onChanged,
}: FamilyGroupEditorProps) {
  const [group, setGroup] = useState<FamilyGroup | null>(null);
  const [requests, setRequests] = useState<FamilyGroupRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [formName, setFormName] = useState("");
  const [selectedMembers, setSelectedMembers] = useState<MemberOption[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [searchResults, setSearchResults] = useState<MemberOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [requestSelections, setRequestSelections] = useState<Record<string, string>>({});
  const [requestSearchTerms, setRequestSearchTerms] = useState<Record<string, string>>({});
  const [requestSearchResults, setRequestSearchResults] = useState<Record<string, RequestMemberMatch[]>>({});
  const [requestSearchFeedback, setRequestSearchFeedback] = useState<Record<string, string>>({});
  const [requestNotes, setRequestNotes] = useState<Record<string, string>>({});
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [requestSearchingId, setRequestSearchingId] = useState<string | null>(null);
  const [requestSubmittingId, setRequestSubmittingId] = useState<string | null>(null);
  const [loginHolderSelections, setLoginHolderSelections] = useState<Record<string, string>>({});
  const [loginHolderSavingEmail, setLoginHolderSavingEmail] = useState<string | null>(null);
  const [loginHolderErrors, setLoginHolderErrors] = useState<Record<string, string>>({});
  const [loginHolderMessages, setLoginHolderMessages] = useState<Record<string, string>>({});
  const [setupInviteSendingId, setSetupInviteSendingId] = useState<string | null>(null);
  const [setupInviteMessages, setSetupInviteMessages] = useState<Record<string, string>>({});

  const sharedEmailClusters = useMemo(
    () => buildSharedEmailClusters(group?.members ?? []),
    [group?.members]
  );

  const refreshEditor = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [groupRes, requestsRes] = await Promise.all([
        fetch(`/api/admin/family-groups/${groupId}`),
        fetch("/api/admin/family-groups/requests"),
      ]);

      const groupData = await groupRes.json().catch(() => ({}));
      if (!groupRes.ok) {
        throw new Error(groupData.error || "Failed to load family group");
      }

      const rawMembers = (groupData.members ?? []) as FamilyGroupMemberRow[];
      const members = await Promise.all(
        rawMembers.map(async (member) => ({
          ...member,
          effectiveEmail: normalizeEmail(await getEffectiveEmail(member)),
        }))
      );

      const nextGroup = { ...groupData, members } as FamilyGroup;
      setGroup(nextGroup);
      setFormName(nextGroup.name || "");
      setSelectedMembers(
        members.map((member) => ({
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
        }))
      );

      const clusters = buildSharedEmailClusters(members);
      setLoginHolderSelections((current) => {
        const nextSelections: Record<string, string> = {};
        for (const cluster of clusters) {
          nextSelections[cluster.email] =
            current[cluster.email] ||
            cluster.members.find((member) => member.canLogin)?.id ||
            "";
        }
        return nextSelections;
      });

      if (requestsRes.ok) {
        const requestData = await requestsRes.json();
        const groupRequests = ((requestData.requests ?? []) as FamilyGroupRequest[])
          .filter((request) => request.familyGroup.id === groupId);
        setRequests(groupRequests);
        setRequestSelections((current) => {
          const nextSelections: Record<string, string> = {};
          for (const request of groupRequests) {
            if (current[request.id]) {
              nextSelections[request.id] = current[request.id];
            } else if (
              request.type === "CHILD_REQUEST" &&
              request.matchingMembers.length === 1
            ) {
              nextSelections[request.id] = request.matchingMembers[0].id;
            } else if (
              request.type === "ADULT_REQUEST" &&
              request.matchingMembers.length === 0
            ) {
              nextSelections[request.id] = "__create__";
            }
          }
          return nextSelections;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load family group");
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    refreshEditor();
  }, [refreshEditor]);

  useEffect(() => {
    if (memberSearch.length < 2) {
      setSearchResults([]);
      return;
    }

    let cancelled = false;
    setSearching(true);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/members?q=${encodeURIComponent(memberSearch)}&type=primary&active=true&pageSize=10`
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          const selectedIds = new Set(selectedMembers.map((member) => member.id));
          setSearchResults(
            (data.members ?? [])
              .filter((member: MemberOption) => !selectedIds.has(member.id))
              .map((member: MemberOption) => ({
                id: member.id,
                firstName: member.firstName,
                lastName: member.lastName,
                email: member.email,
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

  function addMember(member: MemberOption) {
    setSelectedMembers((current) => [...current, member]);
    setMemberSearch("");
    setSearchResults([]);
  }

  function removeMember(id: string) {
    setSelectedMembers((current) => current.filter((member) => member.id !== id));
  }

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

  function getRequestTypeLabel(request: FamilyGroupRequest) {
    if (request.type === "CHILD_REQUEST") return "Infant/Child/Youth Request";
    if (request.type === "ADULT_REQUEST") return "Same-email Adult Request";
    if (request.type === "REMOVAL_REQUEST") return "Removal Request";
    return "Join Request";
  }

  function getRequestSummary(request: FamilyGroupRequest) {
    if (request.type === "CHILD_REQUEST") {
      const childName = [request.childFirstName, request.childLastName]
        .filter(Boolean)
        .join(" ");
      return `${getMemberName(request.requester)} wants to add ${childName || "an infant/child/youth member"} to ${request.familyGroup.name || "this family group"}.`;
    }
    if (request.type === "ADULT_REQUEST") {
      const adultName = [request.requestedFirstName, request.requestedLastName]
        .filter(Boolean)
        .join(" ");
      return `${getMemberName(request.requester)} wants to add ${adultName || "a same-email adult"} to ${request.familyGroup.name || "this family group"}.`;
    }
    if (request.type === "REMOVAL_REQUEST") {
      const subjectName = request.subjectMember
        ? getMemberName(request.subjectMember)
        : "a member";
      return `${getMemberName(request.requester)} wants to remove ${subjectName} from ${request.familyGroup.name || "this family group"}.`;
    }
    return `${getMemberName(request.requester)} wants to join ${request.familyGroup.name || "this family group"}.`;
  }

  function getRequestSubjectName(request: FamilyGroupRequest) {
    if (request.type === "CHILD_REQUEST") {
      return [request.childFirstName, request.childLastName].filter(Boolean).join(" ");
    }
    if (request.type === "ADULT_REQUEST") {
      return [request.requestedFirstName, request.requestedLastName].filter(Boolean).join(" ");
    }
    if (request.type === "REMOVAL_REQUEST" && request.subjectMember) {
      return getMemberName(request.subjectMember);
    }
    return "";
  }

  function getRequestCandidates(request: FamilyGroupRequest) {
    const merged = new Map<string, RequestMemberMatch>();
    for (const candidate of request.matchingMembers) {
      merged.set(candidate.id, candidate);
    }
    for (const candidate of requestSearchResults[request.id] ?? []) {
      merged.set(candidate.id, candidate);
    }
    return Array.from(merged.values());
  }

  async function searchRequestMembers(request: FamilyGroupRequest) {
    const query =
      requestSearchTerms[request.id]?.trim() ||
      getRequestSubjectName(request);

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

      const foundMembers = ((data.members ?? []) as {
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        ageTier: string;
        active: boolean;
        canLogin?: boolean;
        dateOfBirth?: string | null;
      }[])
        .filter((member) =>
          request.type !== "CHILD_REQUEST" || CHILD_REQUEST_AGE_TIERS.has(member.ageTier)
        )
        .map((member) => ({
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
          ageTier: member.ageTier,
          active: member.active,
          canLogin: member.canLogin,
          dateOfBirth: member.dateOfBirth ?? null,
          alreadyInGroup: request.familyGroup.members.some(
            (groupMember) => groupMember.id === member.id
          ),
        }));

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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setStatusMessage("");

    if (selectedMembers.length < 1) {
      setError("At least one member is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/family-groups/${groupId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName.trim(),
          memberIds: selectedMembers.map((member) => member.id),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to save family group");
        return;
      }

      onChanged?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this family group? Members will be unlinked.")) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/family-groups/${groupId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to delete family group");
        return;
      }

      onChanged?.();
      onClose();
    } finally {
      setDeleting(false);
    }
  }

  async function handleRequest(request: FamilyGroupRequest, action: "approve" | "reject") {
    clearRequestError(request.id);
    const linkedMemberId = requestSelections[request.id];
    const needsMemberSelection =
      request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST";

    if (action === "approve" && needsMemberSelection && !linkedMemberId) {
      setRequestErrors((current) => ({
        ...current,
        [request.id]: "Choose the member record to link, or create a new non-login adult where available.",
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
              : { linkedMemberId }
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

      await refreshEditor();
      onChanged?.();
    } finally {
      setRequestSubmittingId((current) => (current === request.id ? null : current));
    }
  }

  async function sendPasswordSetupInvite(member: FamilyGroupMemberRow) {
    setSetupInviteSendingId(member.id);
    setSetupInviteMessages((current) => {
      const next = { ...current };
      delete next[member.id];
      return next;
    });

    try {
      const res = await fetch("/api/admin/members/send-setup-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds: [member.id] }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.sent !== 1) {
        setSetupInviteMessages((current) => ({
          ...current,
          [member.id]: data.error || "Password setup email could not be sent.",
        }));
        return;
      }

      setSetupInviteMessages((current) => ({
        ...current,
        [member.id]: "Password setup email sent.",
      }));
    } finally {
      setSetupInviteSendingId((current) => (current === member.id ? null : current));
    }
  }

  async function saveLoginHolder(cluster: SharedEmailCluster) {
    const newHolderId = loginHolderSelections[cluster.email];
    if (!newHolderId) {
      setLoginHolderErrors((current) => ({
        ...current,
        [cluster.email]: "Choose an adult member before saving.",
      }));
      return;
    }

    setLoginHolderSavingEmail(cluster.email);
    setLoginHolderErrors((current) => {
      const next = { ...current };
      delete next[cluster.email];
      return next;
    });
    setLoginHolderMessages((current) => {
      const next = { ...current };
      delete next[cluster.email];
      return next;
    });

    try {
      const res = await fetch(`/api/admin/family-groups/${groupId}/login-holder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cluster.email, newHolderId }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setLoginHolderErrors((current) => ({
          ...current,
          [cluster.email]: data.error || "Failed to save login holder.",
        }));
        return;
      }

      setLoginHolderMessages((current) => ({
        ...current,
        [cluster.email]: "Login holder updated.",
      }));
      await refreshEditor();
      onChanged?.();
    } finally {
      setLoginHolderSavingEmail((current) => (current === cluster.email ? null : current));
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-slate-500">Loading family group...</CardContent>
      </Card>
    );
  }

  if (!group) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <p className="text-sm text-red-600">{error || "Family group not found"}</p>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-lg">Edit Family Group</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              Rename the group, manage linked members, review pending requests, or swap a shared-email login holder.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={handleDelete}
            disabled={deleting}
          >
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {statusMessage && <p className="text-sm text-emerald-700">{statusMessage}</p>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor={`family-group-name-${groupId}`}>Group Name</Label>
            <Input
              id={`family-group-name-${groupId}`}
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
              placeholder='e.g., "Smith Family"'
              required
            />
          </div>

          <div>
            <Label>Members</Label>
            {selectedMembers.length > 0 && (
              <div className="mb-2 mt-2 flex flex-wrap gap-2">
                {selectedMembers.map((member) => {
                  const memberInfo = group.members.find((groupMember) => groupMember.id === member.id);
                  return (
                    <Badge
                      key={member.id}
                      variant="secondary"
                      className="flex items-center gap-1 px-2 py-1"
                    >
                      {getMemberName(member)}
                      {memberInfo?.ageTier && <AgeTierBadge tier={memberInfo.ageTier} />}
                      <button
                        type="button"
                        onClick={() => removeMember(member.id)}
                        className="ml-1 hover:text-red-600"
                        aria-label={`Remove ${getMemberName(member)}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            )}
            <div className="relative">
              <Input
                value={memberSearch}
                onChange={(event) => setMemberSearch(event.target.value)}
                placeholder="Search members by name or email..."
              />
              {searching && (
                <div className="absolute right-3 top-2.5 text-xs text-slate-400">
                  Searching...
                </div>
              )}
              {searchResults.length > 0 && (
                <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-white shadow-lg">
                  {searchResults.map((member) => (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => addMember(member)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="font-medium">{getMemberName(member)}</span>
                      <span className="ml-2 text-slate-500">{member.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Add adults, youth, or children to this family group
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={submitting || selectedMembers.length < 1}>
              {submitting ? "Saving..." : "Update Group"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>

        <section className="space-y-3 rounded-lg border border-slate-200 p-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Shared email & login</h3>
            <p className="mt-1 text-sm text-slate-500">
              Choose which adult in a shared-email cluster holds the login.
            </p>
          </div>
          {sharedEmailClusters.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-200 p-3 text-sm text-slate-500">
              No shared-email clusters in this family group.
            </p>
          ) : (
            sharedEmailClusters.map((cluster) => {
              const adultMembers = cluster.members.filter((member) => member.ageTier === "ADULT");
              const currentHolder = cluster.members.find((member) => member.canLogin);
              return (
                <div key={cluster.email} className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm font-medium text-slate-900">{cluster.email}</p>
                    {currentHolder && (
                      <p className="text-xs text-slate-500">
                        Current holder: {getMemberName(currentHolder)}
                      </p>
                    )}
                  </div>
                  {adultMembers.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      This shared email has no adult members who can hold the login.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {adultMembers.map((member) => {
                        const disabled = !member.active || !member.hasPassword;
                        return (
                          <label
                            key={member.id}
                            className={`flex flex-col gap-2 rounded-md border bg-white p-3 sm:flex-row sm:items-start ${
                              disabled ? "border-slate-200 opacity-80" : "border-slate-300"
                            }`}
                          >
                            <input
                              type="radio"
                              name={`login-holder-${cluster.email}`}
                              value={member.id}
                              checked={loginHolderSelections[cluster.email] === member.id}
                              onChange={() =>
                                setLoginHolderSelections((current) => ({
                                  ...current,
                                  [cluster.email]: member.id,
                                }))
                              }
                              disabled={disabled}
                              className="mt-1 h-4 w-4 border-slate-300"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-slate-900">
                                  {getMemberName(member)}
                                </span>
                                {member.canLogin && (
                                  <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                                    Current
                                  </Badge>
                                )}
                                {!member.active && (
                                  <Badge variant="secondary" className="bg-slate-100 text-slate-600 border-slate-200">
                                    Inactive
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-slate-500">{member.email}</p>
                              {!member.hasPassword && (
                                <p className="mt-1 text-xs text-amber-700">
                                  This member has never set a password. Use &apos;Send password setup email&apos; first.
                                </p>
                              )}
                              {setupInviteMessages[member.id] && (
                                <p className="mt-1 text-xs text-slate-600">
                                  {setupInviteMessages[member.id]}
                                </p>
                              )}
                            </div>
                            {!member.hasPassword && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={(event) => {
                                  event.preventDefault();
                                  sendPasswordSetupInvite(member);
                                }}
                                disabled={setupInviteSendingId === member.id}
                              >
                                {setupInviteSendingId === member.id
                                  ? "Sending..."
                                  : "Send password setup email"}
                              </Button>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-xs text-slate-500">{SESSION_LAG_WARNING}</p>
                  {loginHolderErrors[cluster.email] && (
                    <p className="text-sm text-red-600">{loginHolderErrors[cluster.email]}</p>
                  )}
                  {loginHolderMessages[cluster.email] && (
                    <p className="text-sm text-emerald-700">{loginHolderMessages[cluster.email]}</p>
                  )}
                  <Button
                    type="button"
                    onClick={() => saveLoginHolder(cluster)}
                    disabled={
                      loginHolderSavingEmail === cluster.email ||
                      !loginHolderSelections[cluster.email]
                    }
                  >
                    {loginHolderSavingEmail === cluster.email ? "Saving..." : "Save login holder"}
                  </Button>
                </div>
              );
            })
          )}
        </section>

        <section className="space-y-3 rounded-lg border border-slate-200 p-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Pending family changes</h3>
            <p className="mt-1 text-sm text-slate-500">
              Review requests that target this family group.
            </p>
          </div>
          {requests.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-200 p-3 text-sm text-slate-500">
              No pending requests for this group.
            </p>
          ) : (
            requests.map((request) => {
              const candidateMembers = getRequestCandidates(request);
              const searchedMembers = requestSearchResults[request.id] ?? [];
              const requestSearchMessage = requestSearchFeedback[request.id];
              const selectedCandidate = candidateMembers.find(
                (candidate) => candidate.id === requestSelections[request.id]
              );
              const requiresMemberChoice =
                request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST";
              const selectedCreateNew = requestSelections[request.id] === "__create__";

              return (
                <div key={request.id} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          className={
                            request.type === "CHILD_REQUEST"
                              ? "bg-blue-100 text-blue-800 border-blue-200"
                              : request.type === "ADULT_REQUEST"
                                ? "bg-violet-100 text-violet-800 border-violet-200"
                                : request.type === "REMOVAL_REQUEST"
                                  ? "bg-rose-100 text-rose-800 border-rose-200"
                              : "bg-emerald-100 text-emerald-800 border-emerald-200"
                          }
                        >
                          {getRequestTypeLabel(request)}
                        </Badge>
                        <span className="text-xs text-slate-500">
                          Requested {formatDate(request.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-slate-900">
                        {getRequestSummary(request)}
                      </p>
                    </div>
                    <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                      <p className="font-medium text-slate-900">Requester</p>
                      <p className="text-slate-700">{getMemberName(request.requester)}</p>
                      <p className="text-xs text-slate-500">{request.requester.email}</p>
                    </div>
                  </div>

                  {requiresMemberChoice && (
                    <div className="mt-4 space-y-3">
                      <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                        <p>
                          Requested {request.type === "ADULT_REQUEST" ? "adult" : "member"}:{" "}
                          <span className="font-medium text-slate-800">
                            {getRequestSubjectName(request)}
                          </span>
                        </p>
                        <p>
                          Date of birth:{" "}
                          {formatDate(
                            request.type === "ADULT_REQUEST"
                              ? request.requestedDateOfBirth
                              : request.childDateOfBirth
                          )}
                        </p>
                        {request.type === "ADULT_REQUEST" && (
                          <p>Shared email: {request.requestedEmail || request.requester.email}</p>
                        )}
                      </div>

                      <div>
                        <Label htmlFor={`editor-request-member-${request.id}`}>
                          {request.type === "ADULT_REQUEST" ? "Adult member record" : "Suggested matches"}
                        </Label>
                        <select
                          id={`editor-request-member-${request.id}`}
                          value={requestSelections[request.id] ?? ""}
                          onChange={(event) => {
                            clearRequestError(request.id);
                            clearRequestSearchFeedback(request.id);
                            setRequestSelections((current) => ({
                              ...current,
                              [request.id]: event.target.value,
                            }));
                          }}
                          className="mt-2 flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                        >
                          <option value="">Select a member record</option>
                          {request.type === "ADULT_REQUEST" && (
                            <option value="__create__">Create new non-login adult from request</option>
                          )}
                          {candidateMembers.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {getMemberName(candidate)}
                              {" - "}
                              {candidate.ageTier}
                              {candidate.canLogin ? " - has login" : " - no login"}
                              {candidate.alreadyInGroup ? " - already in group" : ""}
                              {!candidate.active ? " - inactive" : ""}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={requestSearchTerms[request.id] ?? ""}
                          onChange={(event) => {
                            clearRequestError(request.id);
                            clearRequestSearchFeedback(request.id);
                            setRequestSearchTerms((current) => ({
                              ...current,
                              [request.id]: event.target.value,
                            }));
                          }}
                          placeholder="Search members by name or email..."
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => searchRequestMembers(request)}
                          disabled={requestSearchingId === request.id}
                        >
                          <Search className="h-4 w-4" />
                          {requestSearchingId === request.id ? "Searching..." : "Search"}
                        </Button>
                      </div>

                      {requestSearchMessage && (
                        <p className="text-xs font-medium text-slate-700">
                          {requestSearchMessage}
                        </p>
                      )}

                      {searchedMembers.length > 0 && (
                        <div className="space-y-2 rounded-md border border-slate-200 bg-white p-2">
                          {searchedMembers.map((candidate) => (
                            <button
                              key={candidate.id}
                              type="button"
                              onClick={() => {
                                clearRequestError(request.id);
                                clearRequestSearchFeedback(request.id);
                                setRequestSelections((current) => ({
                                  ...current,
                                  [request.id]: candidate.id,
                                }));
                              }}
                              className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                                requestSelections[request.id] === candidate.id
                                  ? "border-amber-300 bg-amber-50"
                                  : "border-slate-200 bg-white hover:bg-slate-50"
                              }`}
                            >
                              <span className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                                {getMemberName(candidate)}
                                <AgeTierBadge tier={candidate.ageTier} />
                                {requestSelections[request.id] === candidate.id && (
                                  <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-200">
                                    Selected
                                  </Badge>
                                )}
                              </span>
                              <span className="mt-1 block text-xs text-slate-500">
                                {candidate.email}
                                {candidate.dateOfBirth ? ` - DOB ${formatDate(candidate.dateOfBirth)}` : ""}
                                {candidate.canLogin ? " - has login" : " - no login"}
                                {candidate.alreadyInGroup ? " - already in this group" : ""}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}

                      {selectedCandidate && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                          <p className="text-sm font-medium text-slate-900">
                            Selected member record
                          </p>
                          <p className="mt-1 text-sm text-slate-700">
                            {getMemberName(selectedCandidate)}
                          </p>
                          <p className="text-xs text-slate-500">
                            {selectedCandidate.email}
                            {" - "}
                            {selectedCandidate.ageTier}
                            {selectedCandidate.canLogin ? " - has login" : " - no login"}
                            {selectedCandidate.dateOfBirth
                              ? ` - DOB ${formatDate(selectedCandidate.dateOfBirth)}`
                              : ""}
                            {selectedCandidate.alreadyInGroup ? " - already in this group" : ""}
                            {!selectedCandidate.active ? " - inactive" : ""}
                          </p>
                        </div>
                      )}
                      {request.type === "ADULT_REQUEST" && selectedCreateNew && (
                        <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3">
                          <p className="text-sm font-medium text-slate-900">
                            New non-login adult will be created
                          </p>
                          <p className="mt-1 text-sm text-slate-700">
                            {getRequestSubjectName(request)}
                          </p>
                          <p className="text-xs text-slate-500">
                            {request.requestedEmail || request.requester.email}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {request.type === "REMOVAL_REQUEST" && (
                    <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                      <p>
                        Remove member:{" "}
                        <span className="font-medium text-slate-800">
                          {request.subjectMember ? getMemberName(request.subjectMember) : "Unknown member"}
                        </span>
                      </p>
                      {request.subjectMember && (
                        <p>{request.subjectMember.email} - {request.subjectMember.ageTier}</p>
                      )}
                      {request.requestNotes && <p>Notes: {request.requestNotes}</p>}
                    </div>
                  )}

                  <div className="mt-4">
                    <Label htmlFor={`editor-request-note-${request.id}`}>
                      Optional rejection note
                    </Label>
                    <Input
                      id={`editor-request-note-${request.id}`}
                      value={requestNotes[request.id] ?? ""}
                      onChange={(event) =>
                        setRequestNotes((current) => ({
                          ...current,
                          [request.id]: event.target.value,
                        }))
                      }
                      placeholder="Why should this request be rejected?"
                      className="mt-2"
                    />
                  </div>

                  {requestErrors[request.id] && (
                    <p className="mt-4 text-sm text-red-600">{requestErrors[request.id]}</p>
                  )}

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={() => handleRequest(request, "approve")}
                      disabled={
                        requestSubmittingId === request.id ||
                        (requiresMemberChoice && !requestSelections[request.id])
                      }
                    >
                      <Check className="h-4 w-4" />
                      {requestSubmittingId === request.id
                        ? "Saving..."
                        : request.type === "CHILD_REQUEST"
                          ? "Approve and Link Member"
                          : request.type === "ADULT_REQUEST"
                            ? selectedCreateNew
                              ? "Approve and Create Adult"
                              : "Approve and Link Adult"
                            : request.type === "REMOVAL_REQUEST"
                              ? "Approve Removal"
                          : "Approve Request"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => handleRequest(request, "reject")}
                      disabled={requestSubmittingId === request.id}
                    >
                      <X className="h-4 w-4" />
                      {requestSubmittingId === request.id ? "Saving..." : "Reject Request"}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </section>
      </CardContent>
    </Card>
  );
}
