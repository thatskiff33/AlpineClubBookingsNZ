"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AgeTierRow = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  sortOrder: number;
};

const DEFAULT_SETTINGS: AgeTierRow[] = [
  { tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant (under 5)", sortOrder: 0 },
  { tier: "CHILD", minAge: 5, maxAge: 9, label: "Child (5-9)", sortOrder: 1 },
  { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
  { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 3 },
];

export default function AgeTierSettingsPage() {
  const [settings, setSettings] = useState<AgeTierRow[]>([]);
  const [savedSettings, setSavedSettings] = useState<AgeTierRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/age-tier-settings")
      .then((r) => r.json())
      .then((d) => {
        const rows = d.settings ?? [];
        const data = rows.length > 0 ? rows : DEFAULT_SETTINGS;
        setSettings(data);
        setSavedSettings(data);
      })
      .catch(() => setError("Failed to load settings"))
      .finally(() => setLoading(false));
  }, []);

  // Sort by sortOrder for display
  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  const lastTier = sorted[sorted.length - 1];

  function updateRow(tier: string, field: keyof AgeTierRow, value: string | number | null) {
    setSettings((prev) =>
      prev.map((s) => (s.tier === tier ? { ...s, [field]: value } : s))
    );
    setSuccess(false);
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);

    // Auto-calculate maxAge for each tier based on the next tier's minAge - 1
    const bySort = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
    const payload = bySort.map((s, i) => {
      const next = bySort[i + 1];
      return {
        ...s,
        // Last tier (highest sortOrder) has no upper limit; others use next tier's minAge - 1
        maxAge: next ? next.minAge - 1 : null,
      };
    });

    try {
      const res = await fetch("/api/admin/age-tier-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
      } else {
        setSettings(data.settings);
        setSavedSettings(data.settings);
        setEditing(false);
        setSuccess(true);
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setSettings(savedSettings);
    setEditing(false);
    setError(null);
    setSuccess(false);
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Age Group Settings</h1>
        <p className="text-slate-600 mt-1">
          Configure the age boundaries for each membership tier. The highest tier has no upper limit.
          MaxAge for each tier is automatically set to the next tier&apos;s MinAge minus 1.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Age Tier Boundaries</CardTitle>
          {!editing && (
            <Button variant="outline" size="sm" onClick={() => { setEditing(true); setSuccess(false); }}>
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {loading && (
            <p className="text-sm text-slate-500">Loading settings...</p>
          )}
          {sorted.map((s) => (
            <div key={s.tier} className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end border-b pb-4 last:border-0 last:pb-0">
              <div className="space-y-1">
                <Label className="text-xs text-slate-500 uppercase tracking-wide">{s.tier}</Label>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input
                    value={s.label}
                    onChange={(e) => updateRow(s.tier, "label", e.target.value)}
                    disabled={!editing}
                    className={!editing ? "bg-slate-50 text-slate-700" : ""}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Min Age (years)</Label>
                <Input
                  type="number"
                  min={0}
                  value={s.minAge}
                  onChange={(e) => updateRow(s.tier, "minAge", parseInt(e.target.value, 10))}
                  disabled={!editing}
                  className={!editing ? "bg-slate-50 text-slate-700" : ""}
                />
              </div>
              <div className="space-y-1">
                <Label>Max Age (years)</Label>
                <Input
                  type="text"
                  disabled
                  value={
                    lastTier && s.tier === lastTier.tier
                      ? "No limit"
                      : String(
                          (sorted.find((x) => x.sortOrder === s.sortOrder + 1)?.minAge ?? 0) - 1
                        )
                  }
                  className="bg-slate-50 text-slate-500"
                />
                {!(lastTier && s.tier === lastTier.tier) && (
                  <p className="text-xs text-slate-400">Auto-calculated from next tier&apos;s min age</p>
                )}
              </div>
            </div>
          ))}

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm text-green-700">
              Age tier settings saved successfully.
            </div>
          )}

          {editing && (
            <div className="flex gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
              <Button variant="outline" onClick={handleCancel} disabled={saving}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current Boundaries</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 font-medium text-slate-700">Tier</th>
                <th className="text-left py-2 font-medium text-slate-700">Label</th>
                <th className="text-left py-2 font-medium text-slate-700">Age Range</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.tier} className="border-b last:border-0">
                  <td className="py-2 font-medium text-slate-900">{s.tier}</td>
                  <td className="py-2 text-slate-600">{s.label}</td>
                  <td className="py-2 text-slate-600">
                    {s.maxAge !== null
                      ? `${s.minAge} – ${s.maxAge}`
                      : `${s.minAge}+`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
