"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Users, Check, X, Edit2, Search } from "lucide-react";
import { FamilyGroupEditor } from "@/components/admin/family-group-editor";

interface FamilyGroupMemberRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  role?: string;
}

interface FamilyGroup {
  id: string;
  name: string | null;
  createdAt: string;
  members: FamilyGroupMemberRow[];
  memberCount: number;
  inactiveCount: number;
  pendingRequests: number;
}

interface RequestMemberMatch extends MemberOption {
  ageTier: string;
  active: boolean;
  dateOfBirth: string | null;
  alreadyInGroup: boolean;
}

interface FamilyGroupRequest {
  id: string;
  type: "JOIN_REQUEST" | "CHILD_REQUEST";
  createdAt: string;
  requester: { id: string; firstName: string; lastName: string; email: string };
  familyGroup: {
    id: string;
    name: string | null;
    members: { id: string; firstName: string; lastName: string }[];
  };
  childFirstName?: string | null;
  childLastName?: string | null;
  childDateOfBirth?: string | null;
  matchingMembers: RequestMemberMatch[];
}

interface MemberOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

const AGE_TIER_COLORS: Record<string, string> = {
  INFANT: "bg-pink-100 text-pink-700 border-pink-200",
  CHILD: "bg-blue-100 text-blue-700 border-blue-200",
  YOUTH: "bg-purple-100 text-purple-700 border-purple-200",
  ADULT: "bg-slate-100 text-slate-700 border-slate-200",
};

function AgeTierBadge({ tier }: { tier: string }) {
  const colors = AGE_TIER_COLORS[tier] || "bg-gray-100 text-gray-700 border-gray-200";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border ${colors}`}>
      {tier}
    </span>
  );
}

export default function FamilyGroupsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [groups, setGroups] = useState<FamilyGroup[]>([]);
  const [requests, setRequests] = useState<FamilyGroupRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingGroup, setEditingGroup] = useState<FamilyGroup | null>(null);
  const [formName, setFormName] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [searchResults, setSearchResults] = useState<MemberOption[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<MemberOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // P3.1: Search and filter state
  const [filterQuery, setFilterQuery] = useState("");
  const [filterMinMembers, setFilterMinMembers] = useState("");
  const [filterMaxMembers, setFilterMaxMembers] = useState("");
  const [filterHasPending, setFilterHasPending] = useState(false);
  const [requestSelections, setRequestSelections] = useState<Record<string, string>>({});
  const [requestSearchTerms, setRequestSearchTerms] = useState<Record<string, string>>({});
  const [requestSearchResults, setRequestSearchResults] = useState<Record<string, RequestMemberMatch[]>>({});
  const [requestNotes, setRequestNotes] = useState<Record<string, string>>({});
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [requestSearchingId, setRequestSearchingId] = useState<string | null>(null);
  const [requestSubmittingId, setRequestSubmittingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [groupsRes, requestsRes] = await Promise.all([
        fetch("/api/admin/family-groups"),
        fetch("/api/admin/family-groups/requests"),
      ]);
      let fetchedGroups: FamilyGroup[] = [];

      if (groupsRes.ok) {
        const data = await groupsRes.json();
        setGroups(data.familyGroups);
        fetchedGroups = data.familyGroups as FamilyGroup[];
      }
      if (requestsRes.ok) {
        const data = await requestsRes.json();
        const fetchedRequests = data.requests as FamilyGroupRequest[];
        setRequests(fetchedRequests);
        setRequestSelections((current) => {
          const nextSelections: Record<string, string> = {};

          for (const request of fetchedRequests) {
            if (current[request.id]) {
              nextSelections[request.id] = current[request.id];
              continue;
            }
            if (request.type === "CHILD_REQUEST" && request.matchingMembers.length === 1) {
              nextSelections[request.id] = request.matchingMembers[0].id;
            }
          }

          return nextSelections;
        });
      }
      return fetchedGroups;
    } finally {
      setLoading(false);
    }
    return [] as FamilyGroup[];
  }, []);

  // On mount: fetch data, then auto-open edit dialog if ?edit=GROUP_ID is set
  useEffect(() => {
    const editId = searchParams.get("edit");
    fetchData().then((fetchedGroups) => {
      if (editId && fetchedGroups) {
        const target = fetchedGroups.find((g: FamilyGroup) => g.id === editId);
        if (target) openEditForm(target);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const res = await fetch(
          `/api/admin/members?q=${encodeURIComponent(memberSearch)}&type=primary&active=true&pageSize=10`
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          // Filter out already selected members
          const selectedIds = new Set(selectedMembers.map((m) => m.id));
          setSearchResults(
            data.members
              .filter((m: MemberOption) => !selectedIds.has(m.id))
              .map((m: MemberOption) => ({
                id: m.id,
                firstName: m.firstName,
                lastName: m.lastName,
                email: m.email,
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

  function openCreateForm() {
    setEditingGroup(null);
    setFormName("");
    setSelectedMembers([]);
    setMemberSearch("");
    setSearchResults([]);
    setError("");
    setShowForm(true);
  }

  function openEditForm(group: FamilyGroup) {
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
  }

  function addMember(member: MemberOption) {
    setSelectedMembers((prev) => [...prev, member]);
    setMemberSearch("");
    setSearchResults([]);
  }

  function removeMember(id: string) {
    setSelectedMembers((prev) => prev.filter((m) => m.id !== id));
  }

  function closeForm() {
    setShowForm(false);
    // Remove ?edit param from URL when closing
    const params = new URLSearchParams(searchParams.toString());
    params.delete("edit");
    const newSearch = params.toString();
    router.replace(newSearch ? `/admin/family-groups?${newSearch}` : "/admin/family-groups", {
      scroll: false,
    });
  }

  function formatDate(value: string | null | undefined) {
    if (!value) return "Not provided";
    return new Date(value).toLocaleDateString();
  }

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

  function getRequestTypeLabel(request: FamilyGroupRequest) {
    return request.type === "CHILD_REQUEST" ? "Child/Youth Request" : "Join Request";
  }

  function getRequestSummary(request: FamilyGroupRequest) {
    if (request.type === "CHILD_REQUEST") {
      const childName = [request.childFirstName, request.childLastName].filter(Boolean).join(" ");
      return `${request.requester.firstName} ${request.requester.lastName} wants to add ${childName || "a child/youth member"} to ${request.familyGroup.name || "this family group"}.`;
    }
    return `${request.requester.firstName} ${request.requester.lastName} wants to join ${request.familyGroup.name || "this family group"}.`;
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
    const query = requestSearchTerms[request.id]?.trim()
      || [request.childFirstName, request.childLastName].filter(Boolean).join(" ").trim();

    if (query.length < 2) {
      setRequestErrors((current) => ({
        ...current,
        [request.id]: "Enter at least 2 characters to search for an existing member record.",
      }));
      return;
    }

    clearRequestError(request.id);
    setRequestSearchingId(request.id);

    try {
      const res = await fetch(`/api/admin/members?q=${encodeURIComponent(query)}&pageSize=10`);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setRequestErrors((current) => ({
          ...current,
          [request.id]: data.error || "Failed to search member records.",
        }));
        return;
      }

      setRequestSearchResults((current) => ({
        ...current,
        [request.id]: (data.members ?? []).map((member: {
          id: string;
          firstName: string;
          lastName: string;
          email: string;
          ageTier: string;
          active: boolean;
          dateOfBirth?: string | null;
        }) => ({
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
          ageTier: member.ageTier,
          active: member.active,
          dateOfBirth: member.dateOfBirth ?? null,
          alreadyInGroup: request.familyGroup.members.some(
            (groupMember) => groupMember.id === member.id
          ),
        })),
      }));
    } finally {
      setRequestSearchingId((current) => (current === request.id ? null : current));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
    if (!confirm("Delete this family group? Members will be unlinked.")) return;
    const res = await fetch(`/api/admin/family-groups/${id}`, { method: "DELETE" });
    if (res.ok) {
      fetchData();
    }
  }

  async function handleRequest(request: FamilyGroupRequest, action: "approve" | "reject") {
    clearRequestError(request.id);

    const linkedMemberId = requestSelections[request.id];

    if (action === "approve" && request.type === "CHILD_REQUEST" && !linkedMemberId) {
      setRequestErrors((current) => ({
        ...current,
        [request.id]: "Choose the member record that should be linked before approving this request.",
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
          ...(action === "approve" && request.type === "CHILD_REQUEST"
            ? { linkedMemberId }
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
      setRequestNotes((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });

      await fetchData();
    } finally {
      setRequestSubmittingId((current) => (current === request.id ? null : current));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Family Groups</h1>
          <p className="text-sm text-slate-500 mt-1">
            Link primary members together so they appear in each other&apos;s booking quick-add lists
          </p>
        </div>
        <Button onClick={openCreateForm}>
          <Plus className="h-4 w-4 mr-2" />
          New Group
        </Button>
      </div>

      {/* P3.1: Search and filter bar */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[200px] max-w-md relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Search by group name, member name, or email..."
                className="pl-9"
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Min members</Label>
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
                <Label className="text-xs text-slate-500">Max members</Label>
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
                className="rounded border-slate-300"
              />
              Has pending requests
            </label>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            )}
          </div>
          {hasActiveFilters && (
            <p className="text-xs text-slate-500">
              Showing {filteredGroups.length} of {groups.length} group{groups.length !== 1 ? "s" : ""}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Badge className="bg-amber-100 text-amber-800 border-amber-200">
              {requests.length}
            </Badge>
            Pending Family Group Changes
          </CardTitle>
          <p className="text-sm text-slate-500">
            Step 1: review the requested change. Step 2: if it is a child/youth request, pick the member record to link. Step 3: approve or reject.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
              Loading pending family group changes...
            </div>
          ) : requests.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
              No family group changes are awaiting review.
            </div>
          ) : (
            requests.map((request) => {
              const candidateMembers = getRequestCandidates(request);
              const selectedCandidate = candidateMembers.find(
                (candidate) => candidate.id === requestSelections[request.id]
              );

              return (
                <div key={request.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          className={
                            request.type === "CHILD_REQUEST"
                              ? "bg-blue-100 text-blue-800 border-blue-200"
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
                      <p className="text-sm text-slate-600">
                        Family group:{" "}
                        <span className="font-medium text-slate-800">
                          {request.familyGroup.name || "Unnamed Group"}
                        </span>
                      </p>
                    </div>

                    <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                      <p className="font-medium text-slate-900">Requester</p>
                      <p className="text-slate-700">
                        {request.requester.firstName} {request.requester.lastName}
                      </p>
                      <p className="text-xs text-slate-500">{request.requester.email}</p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-3">
                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Step 1
                      </p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        Review what was requested
                      </p>
                      {request.type === "CHILD_REQUEST" ? (
                        <div className="mt-2 space-y-1 text-sm text-slate-600">
                          <p>
                            Requested member:{" "}
                            <span className="font-medium text-slate-800">
                              {[request.childFirstName, request.childLastName].filter(Boolean).join(" ")}
                            </span>
                          </p>
                          <p>Date of birth: {formatDate(request.childDateOfBirth)}</p>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-slate-600">
                          Approving this request adds{" "}
                          <span className="font-medium text-slate-800">
                            {request.requester.firstName} {request.requester.lastName}
                          </span>{" "}
                          to the selected family group.
                        </p>
                      )}
                    </div>

                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {request.type === "CHILD_REQUEST" ? "Step 2" : "Current Group"}
                      </p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {request.type === "CHILD_REQUEST"
                          ? "Check who is already in the group"
                          : "Review existing members"}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {request.familyGroup.members.length > 0 ? (
                          request.familyGroup.members.map((member) => (
                            <Badge key={member.id} variant="secondary" className="text-xs">
                              {member.firstName} {member.lastName}
                            </Badge>
                          ))
                        ) : (
                          <p className="text-sm text-slate-500">No members currently linked.</p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {request.type === "CHILD_REQUEST" ? "Step 3" : "Step 2"}
                      </p>
                      <p className="mt-1 text-sm font-medium text-slate-900">
                        {request.type === "CHILD_REQUEST"
                          ? "Choose the member record to link"
                          : "Approve or reject the request"}
                      </p>
                      {request.type === "CHILD_REQUEST" ? (
                        <div className="mt-2 space-y-2">
                          {candidateMembers.length > 0 ? (
                            <>
                              <Label htmlFor={`request-member-${request.id}`}>Suggested matches</Label>
                              <select
                                id={`request-member-${request.id}`}
                                value={requestSelections[request.id] ?? ""}
                                onChange={(e) => {
                                  clearRequestError(request.id);
                                  setRequestSelections((current) => ({
                                    ...current,
                                    [request.id]: e.target.value,
                                  }));
                                }}
                                className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                              >
                                <option value="">Select a member record</option>
                                {candidateMembers.map((candidate) => (
                                  <option key={candidate.id} value={candidate.id}>
                                    {candidate.firstName} {candidate.lastName}
                                    {" • "}
                                    {candidate.ageTier}
                                    {candidate.alreadyInGroup ? " • already in group" : ""}
                                    {!candidate.active ? " • inactive" : ""}
                                  </option>
                                ))}
                              </select>
                            </>
                          ) : (
                            <p className="text-sm text-slate-600">
                              No matching member record has been suggested yet. Search below.
                            </p>
                          )}

                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                              value={requestSearchTerms[request.id] ?? ""}
                              onChange={(e) => {
                                clearRequestError(request.id);
                                setRequestSearchTerms((current) => ({
                                  ...current,
                                  [request.id]: e.target.value,
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
                              <Search className="mr-2 h-4 w-4" />
                              {requestSearchingId === request.id ? "Searching..." : "Search"}
                            </Button>
                          </div>

                          <p className="text-xs text-slate-500">
                            Suggested matches are based on the requested child name and date of birth. Search if the correct member record is not listed.
                          </p>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-slate-600">
                          Rejecting leaves the family group unchanged. Approving adds the requester to this group immediately.
                        </p>
                      )}
                    </div>
                  </div>

                  {request.type === "CHILD_REQUEST" && selectedCandidate && (
                    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                      <p className="text-sm font-medium text-slate-900">
                        Selected member record
                      </p>
                      <p className="mt-1 text-sm text-slate-700">
                        {selectedCandidate.firstName} {selectedCandidate.lastName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {selectedCandidate.email}
                        {" • "}
                        {selectedCandidate.ageTier}
                        {selectedCandidate.dateOfBirth ? ` • DOB ${formatDate(selectedCandidate.dateOfBirth)}` : ""}
                        {selectedCandidate.alreadyInGroup ? " • already in this group" : ""}
                        {!selectedCandidate.active ? " • inactive" : ""}
                      </p>
                    </div>
                  )}

                  <div className="mt-4">
                    <Label htmlFor={`request-note-${request.id}`}>Optional rejection note</Label>
                    <Input
                      id={`request-note-${request.id}`}
                      value={requestNotes[request.id] ?? ""}
                      onChange={(e) => setRequestNotes((current) => ({
                        ...current,
                        [request.id]: e.target.value,
                      }))}
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
                        requestSubmittingId === request.id
                        || (request.type === "CHILD_REQUEST" && !requestSelections[request.id])
                      }
                    >
                      <Check className="mr-2 h-4 w-4" />
                      {requestSubmittingId === request.id
                        ? "Saving..."
                        : request.type === "CHILD_REQUEST"
                          ? "Approve and Link Member"
                          : "Approve Request"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => handleRequest(request, "reject")}
                      disabled={requestSubmittingId === request.id}
                    >
                      <X className="mr-2 h-4 w-4" />
                      {requestSubmittingId === request.id ? "Saving..." : "Reject Request"}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Create/Edit form */}
      {showForm && (
        editingGroup ? (
          <FamilyGroupEditor
            groupId={editingGroup.id}
            onClose={closeForm}
            onChanged={() => {
              void fetchData();
            }}
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
                    placeholder='e.g., "Smith Family"'
                    required
                  />
                </div>

                <div>
                  <Label>Members</Label>
                  {selectedMembers.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2 mb-2">
                      {selectedMembers.map((m) => (
                        <Badge
                          key={m.id}
                          variant="secondary"
                          className="flex items-center gap-1 py-1 px-2"
                        >
                          {m.firstName} {m.lastName}
                          <button
                            type="button"
                            onClick={() => removeMember(m.id)}
                            className="ml-1 hover:text-red-600"
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
                    />
                    {searching && (
                      <div className="absolute right-3 top-2.5 text-xs text-slate-400">
                        Searching...
                      </div>
                    )}
                    {searchResults.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
                        {searchResults.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => addMember(m)}
                            className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm"
                          >
                            <span className="font-medium">
                              {m.firstName} {m.lastName}
                            </span>
                            <span className="text-slate-500 ml-2">{m.email}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Add adults, youth, or children to this family group
                  </p>
                </div>

                {error && <p className="text-sm text-red-600">{error}</p>}

                <div className="flex gap-2">
                  <Button type="submit" disabled={submitting || selectedMembers.length < 1}>
                    {submitting ? "Saving..." : "Create Group"}
                  </Button>
                  <Button type="button" variant="outline" onClick={closeForm}>
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )
      )}

      {/* Groups table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-center text-slate-500">Loading...</div>
          ) : filteredGroups.length === 0 ? (
            <div className="p-6 text-center text-slate-500">
              {hasActiveFilters
                ? "No family groups match the current filters."
                : "No family groups yet. Create one to link members together."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Group Name</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Members</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Created</th>
                    <th className="text-right px-4 py-3 font-medium text-slate-600">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGroups.map((g) => (
                    <tr key={g.id} className="border-b hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Users className="h-4 w-4 text-slate-400" />
                          <span className="font-medium">{g.name || "Unnamed Group"}</span>
                          {g.pendingRequests > 0 && (
                            <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-xs">
                              {g.pendingRequests} pending
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
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
                                  <span className="ml-1 text-slate-400">(inactive)</span>
                                )}
                              </Badge>
                            ))}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {g.memberCount} member{g.memberCount !== 1 ? "s" : ""}
                          {g.inactiveCount > 0 && (
                            <span className="text-slate-400">
                              {" "}({g.inactiveCount} inactive)
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {new Date(g.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditForm(g)}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(g.id)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
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
  );
}
