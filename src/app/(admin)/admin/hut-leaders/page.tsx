"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, UserCheck, CalendarDays, Check, Pencil } from "lucide-react";

interface HutLeaderAssignment {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  startDate: string;
  endDate: string;
  createdAt: string;
}

interface EligibleMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  bookingCheckIn: string;
  bookingCheckOut: string;
  suggestedStartDate: string;
  suggestedEndDate: string;
}

interface UnassignedDate {
  date: string;
  bookingCount: number;
  guestCount: number;
}

export default function HutLeadersPage() {
  const [assignments, setAssignments] = useState<HutLeaderAssignment[]>([]);
  const [eligibleMembers, setEligibleMembers] = useState<EligibleMember[]>([]);
  const [unassignedDates, setUnassignedDates] = useState<UnassignedDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingMember, setEditingMember] = useState<string | null>(null);
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

  const fetchUnassignedDates = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/hut-leaders/unassigned-dates");
      if (res.ok) {
        const data = await res.json();
        setUnassignedDates(data.unassignedDates);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchAssignments();
    fetchUnassignedDates();
  }, [fetchAssignments, fetchUnassignedDates]);

  // Fetch eligible members when dates change
  useEffect(() => {
    if (!formData.startDate || !formData.endDate || formData.startDate > formData.endDate) {
      setEligibleMembers([]);
      setFormData((prev) => ({ ...prev, memberId: "" }));
      return;
    }

    let cancelled = false;
    setLoadingMembers(true);
    setFormData((prev) => ({ ...prev, memberId: "" }));
    setEditingMember(null);

    fetch(`/api/admin/hut-leaders/eligible-members?startDate=${formData.startDate}&endDate=${formData.endDate}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (!cancelled) {
          setEligibleMembers(data.members);
        }
      })
      .catch(() => {
        if (!cancelled) setEligibleMembers([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.startDate, formData.endDate]);

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
      setEditingMember(null);
      fetchAssignments();
      fetchUnassignedDates();
    } finally {
      setCreating(false);
    }
  }

  async function handleQuickAssign(member: EligibleMember) {
    setError("");
    setCreating(true);
    try {
      const res = await fetch("/api/admin/hut-leaders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: member.id,
          startDate: member.suggestedStartDate,
          endDate: member.suggestedEndDate,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create");
        return;
      }
      setFormData({ memberId: "", startDate: "", endDate: "" });
      setShowForm(false);
      setEditingMember(null);
      fetchAssignments();
      fetchUnassignedDates();
    } finally {
      setCreating(false);
    }
  }

  function handleEditAndAssign(member: EligibleMember) {
    setEditingMember(member.id);
    setFormData({
      memberId: member.id,
      startDate: member.suggestedStartDate,
      endDate: member.suggestedEndDate,
    });
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this hut leader assignment?")) return;
    const res = await fetch(`/api/admin/hut-leaders/${id}`, { method: "DELETE" });
    if (res.ok) {
      fetchAssignments();
      fetchUnassignedDates();
    }
  }

  function handleAssignForDate(date: string) {
    setShowForm(true);
    setFormData({ memberId: "", startDate: date, endDate: date });
    setEditingMember(null);
  }

  const today = new Date().toISOString().split("T")[0];
  const datesSelected = formData.startDate && formData.endDate && formData.startDate <= formData.endDate;

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

      {unassignedDates.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-amber-800 flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              Upcoming Dates Without Hut Leader ({unassignedDates.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {unassignedDates.map((d) => (
                <div
                  key={d.date}
                  className="flex items-center justify-between rounded-lg border border-amber-200 bg-white px-3 py-2"
                >
                  <div>
                    <p className="font-medium text-sm text-slate-800">{d.date}</p>
                    <p className="text-xs text-slate-500">
                      {d.bookingCount} booking{d.bookingCount !== 1 ? "s" : ""}, {d.guestCount} guest{d.guestCount !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleAssignForDate(d.date)}
                    className="text-xs"
                  >
                    Assign
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">New Hut Leader Assignment</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
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
              <div>
                <Label>Eligible Members</Label>
                {!datesSelected ? (
                  <p className="mt-1 text-sm text-slate-500">
                    Select a date range first to see adults staying at the lodge
                  </p>
                ) : loadingMembers ? (
                  <p className="mt-1 text-sm text-slate-500">Loading eligible members...</p>
                ) : eligibleMembers.length === 0 ? (
                  <p className="mt-1 text-sm text-amber-600">
                    No adult members have bookings during this date range
                  </p>
                ) : (
                  <div className="mt-2 space-y-3">
                    {eligibleMembers.map((m) => (
                      <div
                        key={m.id}
                        className={`rounded-lg border p-4 ${
                          editingMember === m.id ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-medium text-sm">
                              {m.firstName} {m.lastName}
                            </p>
                            <p className="text-xs text-slate-500">{m.email}</p>
                            <div className="flex items-center gap-1 mt-1.5 text-xs text-slate-600">
                              <CalendarDays className="h-3.5 w-3.5" />
                              <span>
                                Booking: {m.bookingCheckIn} — {m.bookingCheckOut}
                              </span>
                            </div>
                            <p className="text-xs text-slate-500 mt-0.5">
                              Suggested: {m.suggestedStartDate} — {m.suggestedEndDate}
                            </p>
                          </div>
                          <div className="flex gap-2 flex-shrink-0">
                            <Button
                              type="button"
                              size="sm"
                              disabled={creating}
                              onClick={() => handleQuickAssign(m)}
                            >
                              <Check className="h-3.5 w-3.5 mr-1" />
                              Confirm
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={creating}
                              onClick={() => handleEditAndAssign(m)}
                            >
                              <Pencil className="h-3.5 w-3.5 mr-1" />
                              Edit &amp; Assign
                            </Button>
                          </div>
                        </div>
                        {editingMember === m.id && (
                          <div className="mt-3 pt-3 border-t border-blue-200">
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <Label htmlFor={`edit-start-${m.id}`} className="text-xs">Start Date</Label>
                                <Input
                                  id={`edit-start-${m.id}`}
                                  type="date"
                                  value={formData.startDate}
                                  onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                                  className="mt-1"
                                />
                              </div>
                              <div>
                                <Label htmlFor={`edit-end-${m.id}`} className="text-xs">End Date</Label>
                                <Input
                                  id={`edit-end-${m.id}`}
                                  type="date"
                                  value={formData.endDate}
                                  onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                                  className="mt-1"
                                />
                              </div>
                            </div>
                            <div className="flex gap-2 mt-3">
                              <Button
                                type="submit"
                                size="sm"
                                disabled={creating || !formData.startDate || !formData.endDate}
                              >
                                {creating ? "Saving..." : "Save Assignment"}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingMember(null)}
                              >
                                Cancel Edit
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => { setShowForm(false); setEditingMember(null); }}>
                  Close
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
