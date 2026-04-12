"use client";

import { useEffect, useState, useCallback } from "react";
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
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/pricing";

interface MemberOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface PromoAssignment {
  id: string;
  memberId: string;
  member: MemberOption;
}

interface PromoCode {
  id: string;
  code: string;
  description: string | null;
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS";
  valueCents: number | null;
  percentOff: number | null;
  freeNights: number | null;
  maxRedemptions: number | null;
  currentRedemptions: number;
  validFrom: string | null;
  validUntil: string | null;
  bookingStartFrom: string | null;
  bookingStartUntil: string | null;
  membersOnly: boolean;
  singleUse: boolean;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
  redemptions: { id: string; discountCents: number; createdAt: string }[];
  assignments: PromoAssignment[];
}

const TYPE_LABELS: Record<string, string> = {
  PERCENTAGE: "Percentage",
  FIXED_AMOUNT: "Fixed Amount",
  FREE_NIGHTS: "Free Nights",
};

export default function PromoCodesPage() {
  const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
  const [archivedCodes, setArchivedCodes] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // Form state
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS">(
    "PERCENTAGE"
  );
  const [percentOff, setPercentOff] = useState("");
  const [valueDollars, setValueDollars] = useState("");
  const [freeNights, setFreeNights] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [bookingStartFrom, setBookingStartFrom] = useState("");
  const [bookingStartUntil, setBookingStartUntil] = useState("");
  const [membersOnly, setMembersOnly] = useState(false);
  const [singleUse, setSingleUse] = useState(false);
  const [active, setActive] = useState(true);

  // Member assignment state
  const [assignedMemberIds, setAssignedMemberIds] = useState<string[]>([]);
  const [assignedMembers, setAssignedMembers] = useState<MemberOption[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberResults, setMemberResults] = useState<MemberOption[]>([]);
  const [searchingMembers, setSearchingMembers] = useState(false);

  const fetchPromoCodes = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/promo-codes");
      if (!res.ok) throw new Error("Failed to fetch promo codes");
      const data = await res.json();
      setPromoCodes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchArchivedCodes = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/promo-codes?archived=true");
      if (!res.ok) throw new Error("Failed to fetch archived codes");
      const data = await res.json();
      setArchivedCodes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    fetchPromoCodes();
  }, [fetchPromoCodes]);

  useEffect(() => {
    if (showArchived) {
      fetchArchivedCodes();
    }
  }, [showArchived, fetchArchivedCodes]);

  async function searchMembers(query: string) {
    setMemberSearch(query);
    if (query.length < 2) {
      setMemberResults([]);
      return;
    }
    setSearchingMembers(true);
    try {
      const res = await fetch(
        `/api/admin/members?q=${encodeURIComponent(query)}&pageSize=10&active=true`
      );
      if (!res.ok) throw new Error("Failed to search members");
      const data = await res.json();
      const members = (data.members || []).map((m: MemberOption) => ({
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        email: m.email,
      }));
      // Filter out already assigned members
      setMemberResults(
        members.filter((m: MemberOption) => !assignedMemberIds.includes(m.id))
      );
    } catch {
      setMemberResults([]);
    } finally {
      setSearchingMembers(false);
    }
  }

  function addMember(member: MemberOption) {
    if (!assignedMemberIds.includes(member.id)) {
      setAssignedMemberIds([...assignedMemberIds, member.id]);
      setAssignedMembers([...assignedMembers, member]);
    }
    setMemberSearch("");
    setMemberResults([]);
  }

  function removeMember(memberId: string) {
    setAssignedMemberIds(assignedMemberIds.filter((id) => id !== memberId));
    setAssignedMembers(assignedMembers.filter((m) => m.id !== memberId));
  }

  function resetForm() {
    setCode("");
    setDescription("");
    setType("PERCENTAGE");
    setPercentOff("");
    setValueDollars("");
    setFreeNights("");
    setMaxRedemptions("");
    setValidFrom("");
    setValidUntil("");
    setBookingStartFrom("");
    setBookingStartUntil("");
    setMembersOnly(false);
    setSingleUse(false);
    setActive(true);
    setEditingId(null);
    setShowForm(false);
    setError("");
    setAssignedMemberIds([]);
    setAssignedMembers([]);
    setMemberSearch("");
    setMemberResults([]);
  }

  function startEdit(promo: PromoCode) {
    setEditingId(promo.id);
    setCode(promo.code);
    setDescription(promo.description || "");
    setType(promo.type);
    setPercentOff(promo.percentOff != null ? String(promo.percentOff) : "");
    setValueDollars(
      promo.valueCents != null ? (promo.valueCents / 100).toFixed(2) : ""
    );
    setFreeNights(promo.freeNights != null ? String(promo.freeNights) : "");
    setMaxRedemptions(
      promo.maxRedemptions != null ? String(promo.maxRedemptions) : ""
    );
    setValidFrom(promo.validFrom ? promo.validFrom.split("T")[0] : "");
    setValidUntil(promo.validUntil ? promo.validUntil.split("T")[0] : "");
    setBookingStartFrom(promo.bookingStartFrom ? promo.bookingStartFrom.split("T")[0] : "");
    setBookingStartUntil(promo.bookingStartUntil ? promo.bookingStartUntil.split("T")[0] : "");
    setMembersOnly(promo.membersOnly);
    setSingleUse(promo.singleUse);
    setActive(promo.active);
    setAssignedMemberIds(promo.assignments?.map((a) => a.member.id) || []);
    setAssignedMembers(promo.assignments?.map((a) => a.member) || []);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const payload: Record<string, unknown> = {
      code,
      description: description || null,
      type,
      membersOnly,
      singleUse,
      active,
      validFrom: validFrom || null,
      validUntil: validUntil || null,
      bookingStartFrom: bookingStartFrom || null,
      bookingStartUntil: bookingStartUntil || null,
      maxRedemptions: maxRedemptions ? parseInt(maxRedemptions) : null,
      assignedMemberIds,
    };

    if (type === "PERCENTAGE") {
      payload.percentOff = percentOff ? parseInt(percentOff) : null;
    } else if (type === "FIXED_AMOUNT") {
      payload.valueCents = valueDollars
        ? Math.round(parseFloat(valueDollars) * 100)
        : null;
    } else if (type === "FREE_NIGHTS") {
      payload.freeNights = freeNights ? parseInt(freeNights) : null;
    }

    try {
      const url = editingId
        ? `/api/admin/promo-codes/${editingId}`
        : "/api/admin/promo-codes";
      const method = editingId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save promo code");
      }

      resetForm();
      fetchPromoCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(promo: PromoCode) {
    const hasRedemptions = promo.redemptions.length > 0;
    const confirmMsg = hasRedemptions
      ? `This promo code has been used ${promo.redemptions.length} time(s). It will be archived (not deleted) so you can still reference it. Continue?`
      : "Are you sure you want to delete this promo code?";

    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch(`/api/admin/promo-codes/${promo.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete");
      }
      fetchPromoCodes();
      if (showArchived) fetchArchivedCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleRestore(id: string) {
    try {
      const res = await fetch(`/api/admin/promo-codes/${id}`, {
        method: "PATCH",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to restore");
      }
      fetchPromoCodes();
      fetchArchivedCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleToggleActive(promo: PromoCode) {
    try {
      const res = await fetch(`/api/admin/promo-codes/${promo.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !promo.active }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update");
      }
      fetchPromoCodes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  function formatPromoValue(promo: PromoCode): string {
    switch (promo.type) {
      case "PERCENTAGE":
        return `${promo.percentOff}% off`;
      case "FIXED_AMOUNT":
        return `${formatCents(promo.valueCents || 0)} off`;
      case "FREE_NIGHTS":
        return `${promo.freeNights} free night${promo.freeNights !== 1 ? "s" : ""}`;
      default:
        return "";
    }
  }

  function renderPromoCard(promo: PromoCode, isArchived: boolean) {
    return (
      <Card key={promo.id}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <CardTitle className="text-xl font-mono">
                {promo.code}
              </CardTitle>
              <Badge
                variant={
                  promo.type === "PERCENTAGE"
                    ? "default"
                    : promo.type === "FIXED_AMOUNT"
                      ? "secondary"
                      : "outline"
                }
              >
                {TYPE_LABELS[promo.type]}
              </Badge>
              {isArchived ? (
                <Badge variant="outline" className="text-orange-600 border-orange-600">
                  Archived
                </Badge>
              ) : (
                <Badge variant={promo.active ? "default" : "outline"}>
                  {promo.active ? "Active" : "Inactive"}
                </Badge>
              )}
            </div>
            <div className="flex space-x-2">
              {isArchived ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRestore(promo.id)}
                >
                  Restore
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggleActive(promo)}
                  >
                    {promo.active ? "Deactivate" : "Activate"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => startEdit(promo)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(promo)}
                  >
                    {promo.redemptions.length > 0 ? "Archive" : "Delete"}
                  </Button>
                </>
              )}
            </div>
          </div>
          {promo.description && (
            <CardDescription>{promo.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Value:</span>{" "}
              <span className="font-medium">{formatPromoValue(promo)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Redemptions:</span>{" "}
              <span className="font-medium">
                {promo.currentRedemptions}
                {promo.maxRedemptions != null
                  ? ` / ${promo.maxRedemptions}`
                  : " (unlimited)"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Valid:</span>{" "}
              <span className="font-medium">
                {promo.validFrom
                  ? new Date(promo.validFrom).toLocaleDateString("en-NZ")
                  : "Any time"}
                {" - "}
                {promo.validUntil
                  ? new Date(promo.validUntil).toLocaleDateString("en-NZ")
                  : "No expiry"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {promo.membersOnly && (
                <Badge variant="outline">Members Only</Badge>
              )}
              {promo.singleUse && (
                <Badge variant="outline">Single Use</Badge>
              )}
            </div>
          </div>
          {promo.assignments && promo.assignments.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <span className="text-sm text-muted-foreground">Assigned to: </span>
              <div className="flex flex-wrap gap-1 mt-1">
                {promo.assignments.map((a) => (
                  <Badge key={a.member.id} variant="secondary" className="text-xs">
                    {a.member.firstName} {a.member.lastName}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return <div className="text-center py-8">Loading promo codes...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Promo Codes</h1>
          <p className="text-muted-foreground mt-1">
            Create and manage discount codes and vouchers
          </p>
        </div>
        {!showForm && (
          <Button onClick={() => setShowForm(true)}>Add Promo Code</Button>
        )}
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>
              {editingId ? "Edit Promo Code" : "New Promo Code"}
            </CardTitle>
            <CardDescription>
              Configure discount type, value, and usage restrictions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="code">Code</Label>
                  <Input
                    id="code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="e.g. WINTER20"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Input
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g. Winter 2026 early bird discount"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="type">Discount Type</Label>
                  <select
                    id="type"
                    value={type}
                    onChange={(e) =>
                      setType(
                        e.target.value as
                          | "PERCENTAGE"
                          | "FIXED_AMOUNT"
                          | "FREE_NIGHTS"
                      )
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    <option value="PERCENTAGE">Percentage Off</option>
                    <option value="FIXED_AMOUNT">Fixed Amount Off</option>
                    <option value="FREE_NIGHTS">Free Nights</option>
                  </select>
                </div>

                {type === "PERCENTAGE" && (
                  <div className="space-y-2">
                    <Label htmlFor="percentOff">Percentage Off (%)</Label>
                    <Input
                      id="percentOff"
                      type="number"
                      min="1"
                      max="100"
                      value={percentOff}
                      onChange={(e) => setPercentOff(e.target.value)}
                      placeholder="e.g. 20"
                      required
                    />
                  </div>
                )}

                {type === "FIXED_AMOUNT" && (
                  <div className="space-y-2">
                    <Label htmlFor="valueDollars">Amount Off (NZD)</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        $
                      </span>
                      <Input
                        id="valueDollars"
                        type="number"
                        step="0.01"
                        min="0.01"
                        className="pl-7"
                        value={valueDollars}
                        onChange={(e) => setValueDollars(e.target.value)}
                        placeholder="0.00"
                        required
                      />
                    </div>
                  </div>
                )}

                {type === "FREE_NIGHTS" && (
                  <div className="space-y-2">
                    <Label htmlFor="freeNights">Number of Free Nights</Label>
                    <Input
                      id="freeNights"
                      type="number"
                      min="1"
                      value={freeNights}
                      onChange={(e) => setFreeNights(e.target.value)}
                      placeholder="e.g. 1"
                      required
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="validFrom">Valid From (optional)</Label>
                  <Input
                    id="validFrom"
                    type="date"
                    value={validFrom}
                    onChange={(e) => setValidFrom(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="validUntil">Valid Until (optional)</Label>
                  <Input
                    id="validUntil"
                    type="date"
                    value={validUntil}
                    onChange={(e) => setValidUntil(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="bookingStartFrom">Booking Check-in From (optional)</Label>
                  <Input
                    id="bookingStartFrom"
                    type="date"
                    value={bookingStartFrom}
                    onChange={(e) => setBookingStartFrom(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Only apply to bookings with check-in on or after this date
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bookingStartUntil">Booking Check-in Until (optional)</Label>
                  <Input
                    id="bookingStartUntil"
                    type="date"
                    value={bookingStartUntil}
                    onChange={(e) => setBookingStartUntil(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Only apply to bookings with check-in before this date
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="maxRedemptions">
                  Max Redemptions (optional, leave blank for unlimited)
                </Label>
                <Input
                  id="maxRedemptions"
                  type="number"
                  min="1"
                  value={maxRedemptions}
                  onChange={(e) => setMaxRedemptions(e.target.value)}
                  placeholder="Unlimited"
                />
              </div>

              <div className="flex flex-wrap gap-6">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="membersOnly"
                    checked={membersOnly}
                    onChange={(e) => setMembersOnly(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="membersOnly">Members Only</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="singleUse"
                    checked={singleUse}
                    onChange={(e) => setSingleUse(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="singleUse">Single Use (per member)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="active"
                    checked={active}
                    onChange={(e) => setActive(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="active">Active</Label>
                </div>
              </div>

              {/* Member Assignment Section */}
              <div className="space-y-3 border rounded-md p-4">
                <div>
                  <Label>Assign to Specific Members (optional)</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    If members are assigned, only they can use this code. Leave empty to allow anyone.
                  </p>
                </div>
                <div className="relative">
                  <Input
                    value={memberSearch}
                    onChange={(e) => searchMembers(e.target.value)}
                    placeholder="Search members by name or email..."
                  />
                  {memberResults.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-background border rounded-md shadow-lg max-h-48 overflow-y-auto">
                      {memberResults.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => addMember(m)}
                          className="w-full text-left px-3 py-2 hover:bg-muted text-sm"
                        >
                          {m.firstName} {m.lastName}{" "}
                          <span className="text-muted-foreground">({m.email})</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {searchingMembers && (
                    <div className="absolute z-10 w-full mt-1 bg-background border rounded-md shadow-lg px-3 py-2 text-sm text-muted-foreground">
                      Searching...
                    </div>
                  )}
                </div>
                {assignedMembers.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {assignedMembers.map((m) => (
                      <Badge
                        key={m.id}
                        variant="secondary"
                        className="flex items-center gap-1 py-1 px-2"
                      >
                        {m.firstName} {m.lastName}
                        <button
                          type="button"
                          onClick={() => removeMember(m.id)}
                          className="ml-1 text-muted-foreground hover:text-foreground"
                        >
                          &times;
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex space-x-3">
                <Button type="submit" disabled={saving}>
                  {saving
                    ? "Saving..."
                    : editingId
                      ? "Update Promo Code"
                      : "Create Promo Code"}
                </Button>
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Active Promo Codes List */}
      {promoCodes.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No promo codes yet. Click &quot;Add Promo Code&quot; to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {promoCodes.map((promo) => renderPromoCard(promo, false))}
        </div>
      )}

      {/* Archived Promo Codes Section */}
      <div className="border-t pt-6">
        <button
          onClick={() => setShowArchived(!showArchived)}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground text-sm font-medium"
        >
          <span>{showArchived ? "\u25BC" : "\u25B6"}</span>
          Archived Promo Codes
          {archivedCodes.length > 0 && showArchived && (
            <Badge variant="outline">{archivedCodes.length}</Badge>
          )}
        </button>
        {showArchived && (
          <div className="mt-4 space-y-4">
            {archivedCodes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No archived promo codes.</p>
            ) : (
              archivedCodes.map((promo) => renderPromoCard(promo, true))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
