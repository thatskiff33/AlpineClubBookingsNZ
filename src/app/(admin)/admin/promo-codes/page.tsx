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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { APP_CURRENCY } from "@/config/operational";
import { formatCents } from "@/lib/pricing";

interface MemberOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface XeroAccountOption {
  code: string;
  name: string;
  type: string;
}

interface XeroItemOption {
  code: string;
  name: string;
}

interface PromoAssignment {
  id: string;
  memberId: string;
  member: MemberOption;
}

interface PromoRedemptionRow {
  id: string;
  discountCents: number;
  priceAdjustmentCents: number;
  memberId: string;
  createdAt: string;
}

type PromoType = "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS" | "FIXED_NIGHTLY_PRICE";

interface PromoCode {
  id: string;
  code: string;
  description: string | null;
  type: PromoType;
  valueCents: number | null;
  percentOff: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: "SET_PRICE" | "CAP_ONLY" | null;
  maxNightlyValueCents: number | null;
  maxGuestsPerBooking: number | null;
  maxRedemptionsTotal: number | null;
  maxUniqueMembersTotal: number | null;
  maxUsesPerMember: number | null;
  currentRedemptions: number;
  validFrom: string | null;
  validUntil: string | null;
  bookingStartFrom: string | null;
  bookingStartUntil: string | null;
  membersOnly: boolean;
  memberGuestsOnly: boolean;
  xeroItemCode: string | null;
  xeroAccountCode: string | null;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
  redemptions: PromoRedemptionRow[];
  assignments: PromoAssignment[];
}

const TYPE_LABELS: Record<string, string> = {
  PERCENTAGE: "Percentage",
  FIXED_AMOUNT: "Fixed Amount",
  FREE_NIGHTS: "Free Nights",
  FIXED_NIGHTLY_PRICE: "Fixed Price per Night",
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

  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<PromoType>("PERCENTAGE");
  const [percentOff, setPercentOff] = useState("");
  const [valueDollars, setValueDollars] = useState("");
  const [freeNightsPerIndividual, setFreeNightsPerIndividual] = useState("");
  const [lifetimeFreeNightsCap, setLifetimeFreeNightsCap] = useState("");
  const [fixedNightlyPriceDollars, setFixedNightlyPriceDollars] = useState("");
  const [fixedNightlyMode, setFixedNightlyMode] = useState<"SET_PRICE" | "CAP_ONLY">("CAP_ONLY");
  const [maxNightlyValueDollars, setMaxNightlyValueDollars] = useState("");
  const [maxGuestsPerBooking, setMaxGuestsPerBooking] = useState("");
  const [maxRedemptionsTotal, setMaxRedemptionsTotal] = useState("");
  const [maxUniqueMembersTotal, setMaxUniqueMembersTotal] = useState("");
  const [maxUsesPerMember, setMaxUsesPerMember] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [bookingStartFrom, setBookingStartFrom] = useState("");
  const [bookingStartUntil, setBookingStartUntil] = useState("");
  const [membersOnly, setMembersOnly] = useState(false);
  const [memberGuestsOnly, setMemberGuestsOnly] = useState(false);
  const [xeroItemCode, setXeroItemCode] = useState("");
  const [xeroAccountCode, setXeroAccountCode] = useState("");
  const [active, setActive] = useState(true);

  const [assignedMemberIds, setAssignedMemberIds] = useState<string[]>([]);
  const [assignedMembers, setAssignedMembers] = useState<MemberOption[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberResults, setMemberResults] = useState<MemberOption[]>([]);
  const [searchingMembers, setSearchingMembers] = useState(false);

  const [xeroAccounts, setXeroAccounts] = useState<XeroAccountOption[]>([]);
  const [xeroItems, setXeroItems] = useState<XeroItemOption[]>([]);
  const [xeroDataLoaded, setXeroDataLoaded] = useState(false);
  const [xeroDataLoading, setXeroDataLoading] = useState(false);
  const [xeroDataError, setXeroDataError] = useState("");

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

  const fetchXeroReferenceData = useCallback(async () => {
    if (xeroDataLoaded || xeroDataLoading) return;
    setXeroDataLoading(true);
    setXeroDataError("");
    try {
      const [accountsRes, itemsRes] = await Promise.all([
        fetch("/api/admin/xero/chart-of-accounts"),
        fetch("/api/admin/xero/items"),
      ]);
      if (!accountsRes.ok || !itemsRes.ok) {
        throw new Error("Xero not connected or accounts/items unavailable");
      }
      const accountsData = (await accountsRes.json()) as { accounts?: XeroAccountOption[] };
      const itemsData = (await itemsRes.json()) as { items?: XeroItemOption[] };
      setXeroAccounts(accountsData.accounts ?? []);
      setXeroItems(itemsData.items ?? []);
      setXeroDataLoaded(true);
    } catch (err) {
      setXeroDataError(
        err instanceof Error
          ? err.message
          : "Could not load Xero accounts/items"
      );
    } finally {
      setXeroDataLoading(false);
    }
  }, [xeroDataLoaded, xeroDataLoading]);

  useEffect(() => {
    if (showForm) {
      void fetchXeroReferenceData();
    }
  }, [showForm, fetchXeroReferenceData]);

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
    setFreeNightsPerIndividual("");
    setLifetimeFreeNightsCap("");
    setFixedNightlyPriceDollars("");
    setFixedNightlyMode("CAP_ONLY");
    setMaxNightlyValueDollars("");
    setMaxGuestsPerBooking("");
    setMaxRedemptionsTotal("");
    setMaxUniqueMembersTotal("");
    setMaxUsesPerMember("");
    setValidFrom("");
    setValidUntil("");
    setBookingStartFrom("");
    setBookingStartUntil("");
    setMembersOnly(false);
    setMemberGuestsOnly(false);
    setXeroItemCode("");
    setXeroAccountCode("");
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
    setFreeNightsPerIndividual(
      promo.freeNightsPerIndividual != null ? String(promo.freeNightsPerIndividual) : ""
    );
    setLifetimeFreeNightsCap(
      promo.lifetimeFreeNightsCap != null ? String(promo.lifetimeFreeNightsCap) : ""
    );
    setFixedNightlyPriceDollars(
      promo.fixedNightlyPriceCents != null
        ? (promo.fixedNightlyPriceCents / 100).toFixed(2)
        : ""
    );
    setFixedNightlyMode(promo.fixedNightlyMode ?? "CAP_ONLY");
    setMaxNightlyValueDollars(
      promo.maxNightlyValueCents != null
        ? (promo.maxNightlyValueCents / 100).toFixed(2)
        : ""
    );
    setMaxGuestsPerBooking(
      promo.maxGuestsPerBooking != null ? String(promo.maxGuestsPerBooking) : ""
    );
    setMaxRedemptionsTotal(
      promo.maxRedemptionsTotal != null ? String(promo.maxRedemptionsTotal) : ""
    );
    setMaxUniqueMembersTotal(
      promo.maxUniqueMembersTotal != null ? String(promo.maxUniqueMembersTotal) : ""
    );
    setMaxUsesPerMember(
      promo.maxUsesPerMember != null ? String(promo.maxUsesPerMember) : ""
    );
    setValidFrom(promo.validFrom ? promo.validFrom.split("T")[0] : "");
    setValidUntil(promo.validUntil ? promo.validUntil.split("T")[0] : "");
    setBookingStartFrom(promo.bookingStartFrom ? promo.bookingStartFrom.split("T")[0] : "");
    setBookingStartUntil(promo.bookingStartUntil ? promo.bookingStartUntil.split("T")[0] : "");
    setMembersOnly(promo.membersOnly);
    setMemberGuestsOnly(promo.memberGuestsOnly);
    setXeroItemCode(promo.xeroItemCode ?? "");
    setXeroAccountCode(promo.xeroAccountCode ?? "");
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
      memberGuestsOnly,
      xeroItemCode: xeroItemCode.trim() || null,
      xeroAccountCode: xeroAccountCode.trim() || null,
      active,
      validFrom: validFrom || null,
      validUntil: validUntil || null,
      bookingStartFrom: bookingStartFrom || null,
      bookingStartUntil: bookingStartUntil || null,
      maxGuestsPerBooking: maxGuestsPerBooking ? parseInt(maxGuestsPerBooking) : null,
      maxRedemptionsTotal: maxRedemptionsTotal ? parseInt(maxRedemptionsTotal) : null,
      maxUniqueMembersTotal: maxUniqueMembersTotal ? parseInt(maxUniqueMembersTotal) : null,
      maxUsesPerMember: maxUsesPerMember ? parseInt(maxUsesPerMember) : null,
      assignedMemberIds,
    };

    if (type === "PERCENTAGE") {
      payload.percentOff = percentOff ? parseInt(percentOff) : null;
    } else if (type === "FIXED_AMOUNT") {
      payload.valueCents = valueDollars
        ? Math.round(parseFloat(valueDollars) * 100)
        : null;
    } else if (type === "FREE_NIGHTS") {
      payload.freeNightsPerIndividual = freeNightsPerIndividual
        ? parseInt(freeNightsPerIndividual)
        : null;
      payload.lifetimeFreeNightsCap = lifetimeFreeNightsCap
        ? parseInt(lifetimeFreeNightsCap)
        : null;
    } else if (type === "FIXED_NIGHTLY_PRICE") {
      payload.fixedNightlyPriceCents = fixedNightlyPriceDollars
        ? Math.round(parseFloat(fixedNightlyPriceDollars) * 100)
        : null;
      payload.fixedNightlyMode = fixedNightlyMode;
    }

    if (type !== "FIXED_AMOUNT" && type !== "FIXED_NIGHTLY_PRICE") {
      payload.maxNightlyValueCents = maxNightlyValueDollars
        ? Math.round(parseFloat(maxNightlyValueDollars) * 100)
        : null;
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
        return `${promo.percentOff}% off per individual`;
      case "FIXED_AMOUNT":
        return `${formatCents(promo.valueCents || 0)} off per individual`;
      case "FREE_NIGHTS": {
        const perBooking = `${promo.freeNightsPerIndividual} free night${promo.freeNightsPerIndividual !== 1 ? "s" : ""} per booking`;
        if (promo.lifetimeFreeNightsCap != null) {
          return `${perBooking} · ${promo.lifetimeFreeNightsCap} lifetime`;
        }
        return perBooking;
      }
      case "FIXED_NIGHTLY_PRICE": {
        const mode = promo.fixedNightlyMode === "SET_PRICE" ? "set price" : "cap only";
        return `${formatCents(promo.fixedNightlyPriceCents || 0)} per eligible night · ${mode}`;
      }
      default:
        return "";
    }
  }

  function uniqueMemberCount(redemptions: PromoRedemptionRow[]): number {
    return new Set(redemptions.map((r) => r.memberId)).size;
  }

  function renderPromoCard(promo: PromoCode, isArchived: boolean) {
    const uniqueMembers = uniqueMemberCount(promo.redemptions);
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
              <span className="text-muted-foreground">Benefit:</span>{" "}
              <span className="font-medium">{formatPromoValue(promo)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Redemptions:</span>{" "}
              <span className="font-medium">
                {promo.currentRedemptions}
                {promo.maxRedemptionsTotal != null
                  ? ` / ${promo.maxRedemptionsTotal}`
                  : " (unlimited)"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Unique members:</span>{" "}
              <span className="font-medium">
                {uniqueMembers}
                {promo.maxUniqueMembersTotal != null
                  ? ` / ${promo.maxUniqueMembersTotal}`
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
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {promo.maxGuestsPerBooking != null && (
              <Badge variant="outline">
                Up to {promo.maxGuestsPerBooking} guest{promo.maxGuestsPerBooking === 1 ? "" : "s"} per booking
              </Badge>
            )}
            {promo.maxUsesPerMember != null && (
              <Badge variant="outline">
                Max {promo.maxUsesPerMember} use{promo.maxUsesPerMember === 1 ? "" : "s"} per member
              </Badge>
            )}
            {promo.maxNightlyValueCents != null && (
              <Badge variant="outline">
                Up to {formatCents(promo.maxNightlyValueCents)}/night
              </Badge>
            )}
            {promo.membersOnly && (
              <Badge variant="outline">Members only</Badge>
            )}
            {promo.memberGuestsOnly && (
              <Badge variant="outline">Member guests only</Badge>
            )}
            {promo.xeroItemCode && (
              <Badge variant="outline">Xero Item: {promo.xeroItemCode}</Badge>
            )}
            {promo.xeroAccountCode && (
              <Badge variant="outline">Xero Account: {promo.xeroAccountCode}</Badge>
            )}
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
              Configure discount type, per-individual value, usage caps, and member restrictions
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
                      setType(e.target.value as PromoType)
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    <option value="PERCENTAGE">Percentage Off</option>
                    <option value="FIXED_AMOUNT">Fixed Amount Off</option>
                    <option value="FREE_NIGHTS">Free Nights</option>
                    <option value="FIXED_NIGHTLY_PRICE">Fixed Price per Night</option>
                  </select>
                </div>

                {type === "PERCENTAGE" && (
                  <div className="space-y-2">
                    <Label htmlFor="percentOff">Percentage off per individual (%)</Label>
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
                    <p className="text-xs text-muted-foreground">
                      Applied to each eligible guest&apos;s stay total.
                    </p>
                  </div>
                )}

                {type === "FIXED_AMOUNT" && (
                  <div className="space-y-2">
                    <Label htmlFor="valueDollars">Amount off per individual ({APP_CURRENCY})</Label>
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
                    <p className="text-xs text-muted-foreground">
                      Each eligible guest receives this amount off, capped at their stay total.
                    </p>
                  </div>
                )}

                {type === "FREE_NIGHTS" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="freeNightsPerIndividual">
                        Free nights per individual (per booking)
                      </Label>
                      <Input
                        id="freeNightsPerIndividual"
                        type="number"
                        min="1"
                        value={freeNightsPerIndividual}
                        onChange={(e) => setFreeNightsPerIndividual(e.target.value)}
                        placeholder="e.g. 2"
                        required
                      />
                      <p className="text-xs text-muted-foreground">
                        Each eligible guest receives up to this many free nights on a single booking.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="lifetimeFreeNightsCap">
                        Lifetime free nights per individual (optional)
                      </Label>
                      <Input
                        id="lifetimeFreeNightsCap"
                        type="number"
                        min="1"
                        value={lifetimeFreeNightsCap}
                        onChange={(e) => setLifetimeFreeNightsCap(e.target.value)}
                        placeholder="Leave blank for no lifetime cap"
                      />
                      <p className="text-xs text-muted-foreground">
                        Caps the total free nights any one member can claim from this code across all
                        their bookings. Leave blank for no lifetime cap.
                      </p>
                    </div>
                  </>
                )}

                {type === "FIXED_NIGHTLY_PRICE" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="fixedNightlyPrice">
                        Fixed nightly price per eligible individual ({APP_CURRENCY})
                      </Label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                          $
                        </span>
                        <Input
                          id="fixedNightlyPrice"
                          type="number"
                          step="0.01"
                          min="0.01"
                          className="pl-7"
                          value={fixedNightlyPriceDollars}
                          onChange={(e) => setFixedNightlyPriceDollars(e.target.value)}
                          placeholder="0.00"
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="fixedNightlyMode">Fixed nightly mode</Label>
                      <select
                        id="fixedNightlyMode"
                        value={fixedNightlyMode}
                        onChange={(e) =>
                          setFixedNightlyMode(e.target.value as "SET_PRICE" | "CAP_ONLY")
                        }
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                      >
                        <option value="SET_PRICE">Set everyone to this price</option>
                        <option value="CAP_ONLY">Use as maximum cap</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        Set price can increase cheaper nights and decrease dearer nights. Cap only
                        leaves cheaper nights unchanged.
                      </p>
                    </div>
                  </>
                )}
              </div>

              {type !== "FIXED_AMOUNT" && type !== "FIXED_NIGHTLY_PRICE" && (
                <div className="space-y-2 max-w-md">
                  <Label htmlFor="maxNightlyValue">
                    Maximum nightly value covered (optional, {APP_CURRENCY})
                  </Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      $
                    </span>
                    <Input
                      id="maxNightlyValue"
                      type="number"
                      step="0.01"
                      min="0"
                      className="pl-7"
                      value={maxNightlyValueDollars}
                      onChange={(e) => setMaxNightlyValueDollars(e.target.value)}
                      placeholder="Unlimited"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Caps the discount applied to any single night. Guest pays any excess.
                  </p>
                </div>
              )}

              <div className="border rounded-md p-4 space-y-4">
                <div>
                  <h3 className="text-sm font-medium">Usage limits</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave any field blank for no limit.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="maxGuestsPerBooking">
                      How many individuals can use this per booking?
                    </Label>
                    <Input
                      id="maxGuestsPerBooking"
                      type="number"
                      min="1"
                      value={maxGuestsPerBooking}
                      onChange={(e) => setMaxGuestsPerBooking(e.target.value)}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">
                      Max guests on a single booking the promo applies to (most expensive first).
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxUniqueMembersTotal">
                      How many individuals can use this overall?
                    </Label>
                    <Input
                      id="maxUniqueMembersTotal"
                      type="number"
                      min="1"
                      value={maxUniqueMembersTotal}
                      onChange={(e) => setMaxUniqueMembersTotal(e.target.value)}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">
                      Cap on distinct members who can ever redeem this code.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxUsesPerMember">
                      How many times can the same individual use this?
                    </Label>
                    <Input
                      id="maxUsesPerMember"
                      type="number"
                      min="1"
                      value={maxUsesPerMember}
                      onChange={(e) => setMaxUsesPerMember(e.target.value)}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">
                      Set to 1 for single-use per member.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxRedemptionsTotal">
                      Total redemptions allowed
                    </Label>
                    <Input
                      id="maxRedemptionsTotal"
                      type="number"
                      min="1"
                      value={maxRedemptionsTotal}
                      onChange={(e) => setMaxRedemptionsTotal(e.target.value)}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-muted-foreground">
                      Hard cap on uses across everyone. Reaching either this or the unique-members cap closes the promo.
                    </p>
                  </div>
                </div>
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

              <div className="flex flex-wrap gap-6">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="membersOnly"
                    checked={membersOnly}
                    onChange={(e) => setMembersOnly(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="membersOnly">Members only (booker must be a member)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="memberGuestsOnly"
                    checked={memberGuestsOnly}
                    onChange={(e) => setMemberGuestsOnly(e.target.checked)}
                    className="rounded border-input"
                  />
                  <Label htmlFor="memberGuestsOnly">
                    Member guests only (promo applies only to member guest rows)
                  </Label>
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

              <div className="space-y-3 border rounded-md p-4">
                <div>
                  <Label>Xero accounting (optional)</Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    Code the discount line on the Xero invoice to a separate item or account so promo usage shows in the P&amp;L. Leave both blank to keep the existing behaviour (discount inherits the hut-fee codes).
                  </p>
                </div>
                {xeroDataLoading ? (
                  <p className="text-xs text-muted-foreground">Loading Xero accounts and items...</p>
                ) : null}
                {xeroDataError ? (
                  <p className="text-xs text-amber-600">
                    {xeroDataError}. Enter the codes manually below.
                  </p>
                ) : null}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="xeroItemCode">Xero Item Code</Label>
                    {xeroDataLoaded && xeroItems.length > 0 ? (
                      <Select
                        value={xeroItemCode || "__none__"}
                        onValueChange={(value) =>
                          setXeroItemCode(value === "__none__" ? "" : value)
                        }
                      >
                        <SelectTrigger id="xeroItemCode">
                          <SelectValue placeholder="Select item..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">
                            <span className="text-muted-foreground">Not configured</span>
                          </SelectItem>
                          {xeroItems.map((item) => (
                            <SelectItem key={item.code} value={item.code}>
                              {item.code} - {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id="xeroItemCode"
                        type="text"
                        value={xeroItemCode}
                        onChange={(e) => setXeroItemCode(e.target.value)}
                        placeholder="e.g. PROMO-DISC"
                        maxLength={30}
                      />
                    )}
                    <p className="text-xs text-muted-foreground">
                      If set, the discount line posts to this Xero item. The item&apos;s mapped account in Xero takes priority over the account code below.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="xeroAccountCode">Xero Account Code</Label>
                    {xeroDataLoaded && xeroAccounts.length > 0 ? (
                      <Select
                        value={xeroAccountCode || "__none__"}
                        onValueChange={(value) =>
                          setXeroAccountCode(value === "__none__" ? "" : value)
                        }
                      >
                        <SelectTrigger id="xeroAccountCode">
                          <SelectValue placeholder="Select account..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">
                            <span className="text-muted-foreground">Not configured (use default)</span>
                          </SelectItem>
                          {xeroAccounts
                            .filter((a) => a.type === "REVENUE")
                            .map((account) => (
                              <SelectItem key={account.code} value={account.code}>
                                {account.code} - {account.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id="xeroAccountCode"
                        type="text"
                        value={xeroAccountCode}
                        onChange={(e) => setXeroAccountCode(e.target.value)}
                        placeholder="e.g. 201"
                        maxLength={10}
                      />
                    )}
                    <p className="text-xs text-muted-foreground">
                      Used when no item code is set, or to override the item&apos;s default account.
                    </p>
                  </div>
                </div>
              </div>

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

      <div className="border-t pt-6">
        <button
          onClick={() => setShowArchived(!showArchived)}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground text-sm font-medium"
        >
          <span>{showArchived ? "▼" : "▶"}</span>
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
