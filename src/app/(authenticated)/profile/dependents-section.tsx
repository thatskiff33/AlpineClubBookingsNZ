"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface Dependent {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  dateOfBirth: string | null;
}

export function DependentsSection({
  initialDependents,
}: {
  initialDependents: Dependent[];
}) {
  const [dependents, setDependents] = useState<Dependent[]>(initialDependents);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const resetForm = () => {
    setFirstName("");
    setLastName("");
    setDateOfBirth("");
    setShowForm(false);
    setEditingId(null);
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const body: Record<string, string> = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      };
      if (dateOfBirth) body.dateOfBirth = dateOfBirth;

      if (editingId) {
        const res = await fetch(`/api/members/dependents/${editingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to update");
        }
        const updated = await res.json();
        setDependents((prev) =>
          prev.map((d) =>
            d.id === editingId
              ? {
                  ...d,
                  firstName: updated.firstName,
                  lastName: updated.lastName,
                  ageTier: updated.ageTier,
                  dateOfBirth: updated.dateOfBirth
                    ? updated.dateOfBirth.substring(0, 10)
                    : null,
                }
              : d
          )
        );
      } else {
        const res = await fetch("/api/members/dependents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to create");
        }
        const created = await res.json();
        setDependents((prev) => [
          ...prev,
          {
            id: created.id,
            firstName: created.firstName,
            lastName: created.lastName,
            ageTier: created.ageTier,
            dateOfBirth: created.dateOfBirth
              ? created.dateOfBirth.substring(0, 10)
              : null,
          },
        ]);
      }
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string) => {
    if (!confirm("Remove this family member?")) return;

    try {
      const res = await fetch(`/api/members/dependents/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to remove");
      }
      setDependents((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  const startEdit = (dep: Dependent) => {
    setEditingId(dep.id);
    setFirstName(dep.firstName);
    setLastName(dep.lastName);
    setDateOfBirth(dep.dateOfBirth || "");
    setShowForm(true);
    setError("");
  };

  const tierColor = (tier: string) => {
    if (tier === "CHILD") return "bg-purple-100 text-purple-800 border-purple-200";
    if (tier === "YOUTH") return "bg-blue-100 text-blue-800 border-blue-200";
    return "bg-slate-100 text-slate-800 border-slate-200";
  };

  return (
    <div className="space-y-4">
      {dependents.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">
          No family members added yet.
        </p>
      )}

      {dependents.map((dep) => (
        <div
          key={dep.id}
          className="flex items-center justify-between rounded-lg border p-3"
        >
          <div className="flex items-center gap-3">
            <div>
              <p className="font-medium text-sm">
                {dep.firstName} {dep.lastName}
              </p>
              {dep.dateOfBirth && (
                <p className="text-xs text-muted-foreground">
                  DOB: {dep.dateOfBirth}
                </p>
              )}
            </div>
            <Badge className={tierColor(dep.ageTier)}>{dep.ageTier}</Badge>
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => startEdit(dep)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700"
              onClick={() => handleRemove(dep.id)}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}

      {showForm ? (
        <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border p-4">
          <p className="text-sm font-medium">
            {editingId ? "Edit Family Member" : "Add Family Member"}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="dep-first-name">First Name</Label>
              <Input
                id="dep-first-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="dep-last-name">Last Name</Label>
              <Input
                id="dep-last-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
              />
            </div>
          </div>
          <div>
            <Label htmlFor="dep-dob">Date of Birth (optional)</Label>
            <Input
              id="dep-dob"
              type="date"
              value={dateOfBirth}
              onChange={(e) => setDateOfBirth(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Age tier (Adult/Youth/Child) is calculated from date of birth
            </p>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving..." : editingId ? "Update" : "Add"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetForm}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowForm(true)}
        >
          + Add Family Member
        </Button>
      )}
    </div>
  );
}
