"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Users, Check, X, Edit2 } from "lucide-react";

interface FamilyGroupMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  parentMemberId: string | null;
}

interface FamilyGroup {
  id: string;
  name: string | null;
  createdAt: string;
  members: FamilyGroupMember[];
  memberCount: number;
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

export default function FamilyGroupsPage() {
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

  const fetchData = useCallback(async () => {
    try {
      const [groupsRes, requestsRes] = await Promise.all([
        fetch("/api/admin/family-groups"),
        fetch("/api/admin/family-groups/requests"),
      ]);
      if (groupsRes.ok) {
        const data = await groupsRes.json();
        setGroups(data.familyGroups);
      }
      if (requestsRes.ok) {
        const data = await requestsRes.json();
        setRequests(data.requests);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
              .filter((m: MemberOption & { familyGroupId?: string }) => !selectedIds.has(m.id))
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
        .filter((m) => !m.parentMemberId)
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

      setShowForm(false);
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
                  Only primary (non-dependent) members can be added to a family group
                </p>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <div className="flex gap-2">
                <Button type="submit" disabled={submitting || selectedMembers.length < 1}>
                  {submitting ? "Saving..." : editingGroup ? "Update Group" : "Create Group"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
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
          ) : groups.length === 0 ? (
            <div className="p-6 text-center text-slate-500">
              No family groups yet. Create one to link members together.
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
                  {groups.map((g) => (
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
                            .filter((m) => !m.parentMemberId)
                            .map((m) => (
                              <Badge key={m.id} variant="secondary" className="text-xs">
                                {m.firstName} {m.lastName}
                              </Badge>
                            ))}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {g.memberCount} member{g.memberCount !== 1 ? "s" : ""}
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
