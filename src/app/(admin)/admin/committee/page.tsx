"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Trash2,
  Plus,
  Pencil,
  GripVertical,
  Users,
  X,
  ArrowUp,
  ArrowDown,
} from "lucide-react";

interface CommitteeMember {
  id: string;
  role: string;
  name: string;
  phone: string;
  email: string | null;
  contactKey: string | null;
  description: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const emptyForm = {
  role: "",
  name: "",
  phone: "",
  email: "",
  contactKey: "",
  description: "",
  sortOrder: 0,
  active: true,
};

export default function CommitteePage() {
  const [members, setMembers] = useState<CommitteeMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(emptyForm);
  const [error, setError] = useState("");

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/committee");
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  function openAddForm() {
    setEditingId(null);
    const maxOrder = members.reduce(
      (max, m) => Math.max(max, m.sortOrder),
      -1
    );
    setFormData({ ...emptyForm, sortOrder: maxOrder + 1 });
    setShowForm(true);
    setError("");
  }

  function openEditForm(member: CommitteeMember) {
    setEditingId(member.id);
    setFormData({
      role: member.role,
      name: member.name,
      phone: member.phone,
      email: member.email ?? "",
      contactKey: member.contactKey ?? "",
      description: member.description,
      sortOrder: member.sortOrder,
      active: member.active,
    });
    setShowForm(true);
    setError("");
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setFormData(emptyForm);
    setError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      role: formData.role,
      name: formData.name,
      phone: formData.phone,
      email: formData.email || null,
      contactKey: formData.contactKey || null,
      description: formData.description,
      sortOrder: formData.sortOrder,
      active: formData.active,
    };

    try {
      const url = editingId
        ? `/api/admin/committee/${editingId}`
        : "/api/admin/committee";
      const method = editingId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save");
        return;
      }

      closeForm();
      fetchMembers();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete committee member "${name}"?`)) return;
    const res = await fetch(`/api/admin/committee/${id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      fetchMembers();
    }
  }

  async function handleToggleActive(member: CommitteeMember) {
    await fetch(`/api/admin/committee/${member.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !member.active }),
    });
    fetchMembers();
  }

  async function handleReorder(id: string, direction: "up" | "down") {
    const idx = members.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= members.length) return;

    const current = members[idx];
    const swap = members[swapIdx];

    await Promise.all([
      fetch(`/api/admin/committee/${current.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sortOrder: swap.sortOrder }),
      }),
      fetch(`/api/admin/committee/${swap.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sortOrder: current.sortOrder }),
      }),
    ]);

    fetchMembers();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Committee Members
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Manage committee member details shown on the public committee page
          </p>
        </div>
        <Button onClick={openAddForm}>
          <Plus className="h-4 w-4 mr-2" />
          Add Member
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center justify-between">
              {editingId ? "Edit Committee Member" : "Add Committee Member"}
              <Button variant="ghost" size="icon" onClick={closeForm}>
                <X className="h-4 w-4" />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="role">Role / Position *</Label>
                  <Input
                    id="role"
                    value={formData.role}
                    onChange={(e) =>
                      setFormData({ ...formData, role: e.target.value })
                    }
                    placeholder="e.g. President"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                    placeholder="e.g. John Smith"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="phone">Phone *</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) =>
                      setFormData({ ...formData, phone: e.target.value })
                    }
                    placeholder="e.g. +64 21 123 4567"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) =>
                      setFormData({ ...formData, email: e.target.value })
                    }
                    placeholder="Optional"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="contactKey">Contact Key</Label>
                  <Input
                    id="contactKey"
                    value={formData.contactKey}
                    onChange={(e) =>
                      setFormData({ ...formData, contactKey: e.target.value })
                    }
                    placeholder="e.g. president (for /contact?recipient=)"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Used for &ldquo;Send a message&rdquo; link on the public
                    page
                  </p>
                </div>
                <div>
                  <Label htmlFor="sortOrder">Display Order</Label>
                  <Input
                    id="sortOrder"
                    type="number"
                    min={0}
                    value={formData.sortOrder}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        sortOrder: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Lower numbers appear first
                  </p>
                </div>
              </div>

              <div>
                <Label htmlFor="description">Description *</Label>
                <textarea
                  id="description"
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  rows={3}
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                  placeholder="Brief description of the role"
                  required
                  maxLength={500}
                />
                <p className="text-xs text-slate-500 mt-1">
                  {formData.description.length}/500 characters
                </p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="active"
                  checked={formData.active}
                  onChange={(e) =>
                    setFormData({ ...formData, active: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300"
                />
                <Label htmlFor="active" className="font-normal">
                  Active (visible on public committee page)
                </Label>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <div className="flex gap-2">
                <Button type="submit" disabled={saving}>
                  {saving
                    ? "Saving..."
                    : editingId
                      ? "Update Member"
                      : "Add Member"}
                </Button>
                <Button type="button" variant="outline" onClick={closeForm}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-center text-slate-500">Loading...</div>
          ) : members.length === 0 ? (
            <div className="p-6 text-center text-slate-500">
              <Users className="h-8 w-8 mx-auto mb-2 text-slate-300" />
              <p>No committee members yet.</p>
              <p className="text-xs mt-1">
                Click &ldquo;Add Member&rdquo; to get started.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left px-4 py-3 font-medium text-slate-600 w-10">
                      #
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">
                      Role
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">
                      Name
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">
                      Phone
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">
                      Status
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-slate-600">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m, idx) => (
                    <tr
                      key={m.id}
                      className={`border-b hover:bg-slate-50 ${
                        !m.active ? "opacity-50" : ""
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          <button
                            onClick={() => handleReorder(m.id, "up")}
                            disabled={idx === 0}
                            className="text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Move up"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <GripVertical className="h-3 w-3 text-slate-300 mx-auto" />
                          <button
                            onClick={() => handleReorder(m.id, "down")}
                            disabled={idx === members.length - 1}
                            className="text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Move down"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-blue-600">
                          {m.role}
                        </span>
                        {m.contactKey && (
                          <p className="text-xs text-slate-400 mt-0.5">
                            key: {m.contactKey}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{m.name}</div>
                        {m.email && (
                          <div className="text-xs text-slate-500">
                            {m.email}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{m.phone}</td>
                      <td className="px-4 py-3">
                        <button onClick={() => handleToggleActive(m)}>
                          {m.active ? (
                            <Badge className="bg-green-100 text-green-800 border-green-200 cursor-pointer">
                              Active
                            </Badge>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="cursor-pointer"
                            >
                              Inactive
                            </Badge>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditForm(m)}
                            className="text-slate-600 hover:text-blue-600"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(m.id, m.name)}
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
