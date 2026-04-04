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
  membersOnly: boolean;
  singleUse: boolean;
  active: boolean;
  createdAt: string;
  redemptions: { id: string; discountCents: number; createdAt: string }[];
}

const TYPE_LABELS: Record<string, string> = {
  PERCENTAGE: "Percentage",
  FIXED_AMOUNT: "Fixed Amount",
  FREE_NIGHTS: "Free Nights",
};

export default function PromoCodesPage() {
  const [promoCodes, setPromoCodes] = useState<PromoCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
  const [membersOnly, setMembersOnly] = useState(false);
  const [singleUse, setSingleUse] = useState(false);
  const [active, setActive] = useState(true);

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

  useEffect(() => {
    fetchPromoCodes();
  }, [fetchPromoCodes]);

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
    setMembersOnly(false);
    setSingleUse(false);
    setActive(true);
    setEditingId(null);
    setShowForm(false);
    setError("");
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
    setMembersOnly(promo.membersOnly);
    setSingleUse(promo.singleUse);
    setActive(promo.active);
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
      maxRedemptions: maxRedemptions ? parseInt(maxRedemptions) : null,
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

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this promo code?")) return;

    try {
      const res = await fetch(`/api/admin/promo-codes/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete");
      }
      fetchPromoCodes();
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

      {/* Promo Codes List */}
      {promoCodes.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No promo codes yet. Click &quot;Add Promo Code&quot; to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {promoCodes.map((promo) => (
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
                    <Badge variant={promo.active ? "default" : "outline"}>
                      {promo.active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <div className="flex space-x-2">
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
                      onClick={() => handleDelete(promo.id)}
                    >
                      Delete
                    </Button>
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
