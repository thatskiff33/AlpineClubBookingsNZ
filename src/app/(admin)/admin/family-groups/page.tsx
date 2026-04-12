"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Users, Check, X, Edit2, Search } from "lucide-react";

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

interface JoinRequest {
  id: string;
  createdAt: string;
  requester: { id: string; firstName: string; lastName: string; email: string };
  familyGroup: {
    id: string;
    name: string | null;
    members: { id: string; firstName: string; lastName: string }[];
  };
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
  const [requests, setRequests] = useState<JoinRequest[]>([]);
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

  const fetchData = useCallback(async () => {
    try {
      const [groupsRes, requestsRes] = await Promise.all([
        fetch("/api/admin/family-groups"),
        fetch("/api/admin/family-groups/requests"),
      ]);
      if (groupsRes.ok) {
        const data = await groupsRes.json();
        setGroups(data.familyGroups);
        return data.familyGroups as FamilyGroup[];
      }
      if (requestsRes.ok) {
        const data = await requestsRes.json();
        setRequests(data.requests);
      }
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

  async function handleRequest(requestId: string, action: "approve" | "reject") {
    const res = await fetch("/api/admin/family-groups/requests", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, action }),
    });
    if (res.ok) {
      fetchData();
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

      {/* Pending join requests */}
      {requests.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Badge className="bg-amber-100 text-amber-800 border-amber-200">
                {requests.length}
              </Badge>
              Pending Join Requests
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Requester</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Wants to Join</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Current Members</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Requested</th>
                    <th className="text-right px-4 py-3 font-medium text-slate-600">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} className="border-b hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {r.requester.firstName} {r.requester.lastName}
                        </div>
                        <div className="text-xs text-slate-500">{r.requester.email}</div>
                      </td>
                      <td className="px-4 py-3">{r.familyGroup.name || "Unnamed Group"}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {r.familyGroup.members.map((m) => `${m.firstName} ${m.lastName}`).join(", ")}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {new Date(r.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRequest(r.id, "approve")}
                            className="text-green-600 hover:text-green-700 hover:bg-green-50"
                          >
                            <Check className="h-4 w-4 mr-1" />
                            Approve
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRequest(r.id, "reject")}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            <X className="h-4 w-4 mr-1" />
                            Reject
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create/Edit form */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {editingGroup ? "Edit Family Group" : "New Family Group"}
            </CardTitle>
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
                    {selectedMembers.map((m) => {
                      // P3.2: Show age tier badge in edit panel
                      const memberInfo = editingGroup?.members.find((em) => em.id === m.id);
                      return (
                        <Badge
                          key={m.id}
                          variant="secondary"
                          className="flex items-center gap-1 py-1 px-2"
                        >
                          {m.firstName} {m.lastName}
                          {memberInfo?.ageTier && (
                            <AgeTierBadge tier={memberInfo.ageTier} />
                          )}
                          <button
                            type="button"
                            onClick={() => removeMember(m.id)}
                            className="ml-1 hover:text-red-600"
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
                  {submitting ? "Saving..." : editingGroup ? "Update Group" : "Create Group"}
                </Button>
                <Button type="button" variant="outline" onClick={closeForm}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
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
