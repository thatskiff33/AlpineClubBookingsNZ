"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type MemberSummary = {
  id: string;
  firstName: string;
  lastName: string;
};

type LockerRecord = {
  id: string;
  name: string;
  allocatedToMemberId: string | null;
  allocatedTo: MemberSummary | null;
};

type SortField = "name" | "allocatedTo";

function memberDisplayName(member: MemberSummary | null): string {
  if (!member) {
    return "Unallocated";
  }
  return `${member.firstName} ${member.lastName}`.trim();
}

function handleAllocatedToSearchKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
) {
  // Prevent Select typeahead from hijacking focus as users type in search.
  event.stopPropagation();
}

export default function LockersPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [allocatedToMemberId, setAllocatedToMemberId] =
    useState<string>("UNALLOCATED");
  const [allocatedToSearch, setAllocatedToSearch] = useState("");
  const [editingLockerId, setEditingLockerId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [lockers, setLockers] = useState<LockerRecord[]>([]);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/lockers");
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Failed to load lockers");
      }

      setMembers(body.members ?? []);
      setLockers(body.lockers ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load lockers",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleFormSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const payload = {
        allocatedToMemberId:
          allocatedToMemberId === "UNALLOCATED" ? null : allocatedToMemberId,
      };
      const response = editingLockerId
        ? await fetch(`/api/admin/lockers/${editingLockerId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/lockers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              ...payload,
            }),
          });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body.error ||
            (editingLockerId
              ? "Failed to update locker"
              : "Failed to create locker"),
        );
      }

      if (editingLockerId) {
        setLockers((previous) =>
          previous.map((locker) =>
            locker.id === editingLockerId ? body.locker : locker,
          ),
        );
      } else {
        setLockers((previous) => [...previous, body.locker]);
      }

      setEditingLockerId(null);
      setName("");
      setAllocatedToMemberId("UNALLOCATED");
      setAllocatedToSearch("");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : editingLockerId
            ? "Failed to update locker"
            : "Failed to create locker",
      );
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(locker: LockerRecord) {
    setEditingLockerId(locker.id);
    setName(locker.name);
    setAllocatedToMemberId(locker.allocatedToMemberId ?? "UNALLOCATED");
    setAllocatedToSearch("");
    setError("");
  }

  function toggleSort(nextField: SortField) {
    if (sortField === nextField) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }

    setSortField(nextField);
    setSortDirection("asc");
  }

  const sortedLockers = useMemo(() => {
    const clone = [...lockers];
    clone.sort((a, b) => {
      const aValue =
        sortField === "name" ? a.name : memberDisplayName(a.allocatedTo);
      const bValue =
        sortField === "name" ? b.name : memberDisplayName(b.allocatedTo);

      const result = aValue.localeCompare(bValue, "en-NZ", {
        sensitivity: "base",
      });
      return sortDirection === "asc" ? result : -result;
    });

    return clone;
  }, [lockers, sortDirection, sortField]);

  const filteredMembers = useMemo(() => {
    const query = allocatedToSearch.trim().toLocaleLowerCase("en-NZ");
    if (!query) {
      return members;
    }

    return members.filter((member) =>
      memberDisplayName(member).toLocaleLowerCase("en-NZ").includes(query),
    );
  }, [allocatedToSearch, members]);

  const SortIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Lockers</h1>
        <p className="mt-1 text-sm text-slate-500">
          Create lockers and optionally allocate them to members.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Locker</CardTitle>
          <CardDescription>
            Add a locker name and optionally assign it to a member.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleFormSubmit}
            className="grid gap-4 sm:grid-cols-3"
          >
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="locker-name">Name</Label>
              <Input
                id="locker-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Locker A1"
                readOnly={Boolean(editingLockerId)}
                required
              />
            </div>
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="locker-allocated">Allocated To</Label>
              <Select
                value={allocatedToMemberId}
                onValueChange={(value) => {
                  setAllocatedToMemberId(value);
                  setAllocatedToSearch("");
                }}
              >
                <SelectTrigger id="locker-allocated">
                  <SelectValue placeholder="Unallocated" />
                </SelectTrigger>
                <SelectContent>
                  <div className="p-2">
                    <Input
                      value={allocatedToSearch}
                      onChange={(event) =>
                        setAllocatedToSearch(event.target.value)
                      }
                      onKeyDown={handleAllocatedToSearchKeyDown}
                      placeholder="Search member"
                      className="h-8"
                    />
                  </div>
                  <SelectItem value="UNALLOCATED">Unallocated</SelectItem>
                  {filteredMembers.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {memberDisplayName(member)}
                    </SelectItem>
                  ))}
                  {filteredMembers.length === 0 ? (
                    <div className="px-2 pb-2 text-xs text-slate-500">
                      No members found.
                    </div>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-1 flex items-end">
              <Button
                type="submit"
                disabled={saving}
                className="w-full sm:w-auto"
              >
                {saving
                  ? "Saving..."
                  : editingLockerId
                    ? "Update Locker"
                    : "Create Locker"}
              </Button>
            </div>
          </form>
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Locker List</CardTitle>
          <CardDescription>
            Sort by locker name or allocated member.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-slate-500">Loading lockers...</p>
          ) : sortedLockers.length === 0 ? (
            <p className="text-sm text-slate-500">No lockers created yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="min-w-full text-left text-sm text-slate-700">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 font-semibold"
                        onClick={() => toggleSort("name")}
                      >
                        Name
                        {sortField === "name" ? (
                          <SortIcon className="h-3.5 w-3.5" />
                        ) : null}
                      </button>
                    </th>
                    <th className="px-4 py-3">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 font-semibold"
                        onClick={() => toggleSort("allocatedTo")}
                      >
                        Allocated To
                        {sortField === "allocatedTo" ? (
                          <SortIcon className="h-3.5 w-3.5" />
                        ) : null}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLockers.map((locker) => (
                    <tr key={locker.id} className="border-t border-slate-200">
                      <td className="px-4 py-3 font-medium text-slate-900">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => beginEdit(locker)}
                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-300 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
                            aria-label={`Edit locker ${locker.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <span>{locker.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {memberDisplayName(locker.allocatedTo)}
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
