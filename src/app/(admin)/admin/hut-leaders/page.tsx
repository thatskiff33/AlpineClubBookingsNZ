"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, UserCheck } from "lucide-react";

interface HutLeaderAssignment {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  startDate: string;
  endDate: string;
  createdAt: string;
}

interface MemberOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export default function HutLeadersPage() {
  const [assignments, setAssignments] = useState<HutLeaderAssignment[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    memberId: "",
    startDate: "",
    endDate: "",
  });
  const [error, setError] = useState("");

  const fetchAssignments = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/hut-leaders");
      if (res.ok) {
        const data = await res.json();
        setAssignments(data.assignments);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMembers = useCallback(async () => {
    const res = await fetch("/api/admin/members?limit=500");
    if (res.ok) {
      const data = await res.json();
      setMembers(
        data.members
          .filter((m: MemberOption & { role: string }) => m.role !== "LODGE")
          .map((m: MemberOption) => ({
            id: m.id,
            firstName: m.firstName,
            lastName: m.lastName,
            email: m.email,
          }))
      );
    }
  }, []);

  useEffect(() => {
    fetchAssignments();
    fetchMembers();
  }, [fetchAssignments, fetchMembers]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      const res = await fetch("/api/admin/hut-leaders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create");
        return;
      }
      setFormData({ memberId: "", startDate: "", endDate: "" });
      setShowForm(false);
      fetchAssignments();
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this hut leader assignment?")) return;
    const res = await fetch(`/api/admin/hut-leaders/${id}`, { method: "DELETE" });
    if (res.ok) {
      fetchAssignments();
    }
  }

  const today = new Date().toISOString().split("T")[0];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Hut Leader Assignments</h1>
          <p className="text-sm text-slate-500 mt-1">
            Assign members as hut leader for specific date ranges
          </p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4 mr-2" />
          New Assignment
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">New Hut Leader Assignment</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <Label htmlFor="memberId">Member</Label>
                <select
                  id="memberId"
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  value={formData.memberId}
                  onChange={(e) => setFormData({ ...formData, memberId: e.target.value })}
                  required
                >
                  <option value="">Select a member...</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.firstName} {m.lastName} ({m.email})
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="startDate">Start Date</Label>
                  <Input
                    id="startDate"
                    type="date"
                    value={formData.startDate}
                    onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="endDate">End Date</Label>
                  <Input
                    id="endDate"
                    type="date"
                    value={formData.endDate}
                    onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                    required
                  />
                </div>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2">
                <Button type="submit" disabled={creating}>
                  {creating ? "Creating..." : "Create Assignment"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
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
          ) : assignments.length === 0 ? (
            <div className="p-6 text-center text-slate-500">
              No hut leader assignments yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Member</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Start</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">End</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-slate-600">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((a) => {
                    const isActive = a.startDate <= today && a.endDate >= today;
                    const isPast = a.endDate < today;
                    return (
                      <tr key={a.id} className="border-b hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <UserCheck className="h-4 w-4 text-slate-400" />
                            <div>
                              <div className="font-medium">{a.memberName}</div>
                              <div className="text-xs text-slate-500">{a.memberEmail}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">{a.startDate}</td>
                        <td className="px-4 py-3">{a.endDate}</td>
                        <td className="px-4 py-3">
                          {isActive ? (
                            <Badge className="bg-green-100 text-green-800 border-green-200">Active</Badge>
                          ) : isPast ? (
                            <Badge variant="secondary">Past</Badge>
                          ) : (
                            <Badge className="bg-blue-100 text-blue-800 border-blue-200">Upcoming</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(a.id)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
