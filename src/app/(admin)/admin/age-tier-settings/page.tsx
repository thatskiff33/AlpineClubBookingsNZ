"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type AgeTierRow = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  xeroContactGroupId: string | null;
  xeroContactGroupName: string | null;
  sortOrder: number;
};

type XeroContactGroup = {
  id: string;
  name: string;
  contactCount: number;
};

const DEFAULT_SETTINGS: AgeTierRow[] = [
  {
    tier: "INFANT",
    minAge: 0,
    maxAge: 4,
    label: "Infant (under 5)",
    xeroContactGroupId: null,
    xeroContactGroupName: null,
    sortOrder: 0,
  },
  {
    tier: "CHILD",
    minAge: 5,
    maxAge: 9,
    label: "Child (5-9)",
    xeroContactGroupId: null,
    xeroContactGroupName: null,
    sortOrder: 1,
  },
  {
    tier: "YOUTH",
    minAge: 10,
    maxAge: 17,
    label: "Youth (10-17)",
    xeroContactGroupId: null,
    xeroContactGroupName: null,
    sortOrder: 2,
  },
  {
    tier: "ADULT",
    minAge: 18,
    maxAge: null,
    label: "Adult (18+)",
    xeroContactGroupId: null,
    xeroContactGroupName: null,
    sortOrder: 3,
  },
];

export default function AgeTierSettingsPage() {
  const [settings, setSettings] = useState<AgeTierRow[]>([]);
  const [savedSettings, setSavedSettings] = useState<AgeTierRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [xeroGroups, setXeroGroups] = useState<XeroContactGroup[]>([]);
  const [loadingXeroGroups, setLoadingXeroGroups] = useState(true);
  const [refreshingXeroGroups, setRefreshingXeroGroups] = useState(false);
  const [xeroGroupsError, setXeroGroupsError] = useState<string | null>(null);

  async function loadXeroGroups(refreshFromXero = false) {
    if (refreshFromXero) {
      setRefreshingXeroGroups(true);
    } else {
      setLoadingXeroGroups(true);
    }
    setXeroGroupsError(null);

    try {
      const res = await fetch(
        `/api/admin/xero/contact-groups${refreshFromXero ? "?refresh=1" : ""}`
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to load Xero contact groups");
      }
      setXeroGroups(data?.groups ?? []);
    } catch (loadError) {
      setXeroGroupsError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load Xero contact groups"
      );
    } finally {
      setLoadingXeroGroups(false);
      setRefreshingXeroGroups(false);
    }
  }

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

    void loadXeroGroups();
  }, []);

  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  const lastTier = sorted[sorted.length - 1];

  function updateRow(
    tier: string,
    field: keyof AgeTierRow,
    value: string | number | null
  ) {
    setSettings((prev) =>
      prev.map((setting) =>
        setting.tier === tier ? { ...setting, [field]: value } : setting
      )
    );
    setSuccess(false);
    setError(null);
  }

  function updateXeroContactGroup(tier: AgeTier, groupId: string) {
    const selectedGroup =
      groupId === "__none__"
        ? null
        : xeroGroups.find((group) => group.id === groupId) ?? null;

    setSettings((prev) =>
      prev.map((setting) =>
        setting.tier === tier
          ? {
              ...setting,
              xeroContactGroupId: selectedGroup?.id ?? null,
              xeroContactGroupName: selectedGroup?.name ?? null,
            }
          : setting
      )
    );
    setSuccess(false);
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);

    const bySort = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
    const payload = bySort.map((setting, index) => {
      const next = bySort[index + 1];
      return {
        ...setting,
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
          Configure the age boundaries for each membership tier. The highest tier has no
          upper limit. MaxAge for each tier is automatically set to the next tier&apos;s
          MinAge minus 1. Optional Xero contact-group mappings drive managed Xero
          contact-group allocation for linked members.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Age Tier Boundaries</CardTitle>
          {!editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(true);
                setSuccess(false);
              }}
            >
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <p className="text-sm text-slate-500">Loading settings...</p>
          ) : null}

          <div className="flex flex-col gap-3 rounded-md border bg-slate-50/70 p-4 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-900">Xero Contact Groups</p>
              <p className="text-sm text-slate-600">
                Use cached Xero contact groups here to assign one managed group per age tier.
              </p>
              {loadingXeroGroups ? (
                <p className="text-xs text-slate-500">Loading cached Xero contact groups...</p>
              ) : (
                <p className="text-xs text-slate-500">
                  {xeroGroups.length > 0
                    ? `${xeroGroups.length} cached Xero group${xeroGroups.length === 1 ? "" : "s"} available.`
                    : "No cached Xero contact groups available yet."}
                </p>
              )}
              {xeroGroupsError ? (
                <p className="text-xs text-red-700">{xeroGroupsError}</p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadXeroGroups(true)}
              disabled={refreshingXeroGroups}
            >
              {refreshingXeroGroups ? "Refreshing..." : "Refresh Xero Groups"}
            </Button>
          </div>

          {sorted.map((setting) => (
            <div
              key={setting.tier}
              className="grid grid-cols-1 items-end gap-4 border-b pb-4 last:border-0 last:pb-0 sm:grid-cols-4"
            >
              <div className="space-y-1">
                <Label className="text-xs text-slate-500 uppercase tracking-wide">
                  {setting.tier}
                </Label>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input
                    value={setting.label}
                    onChange={(event) =>
                      updateRow(setting.tier, "label", event.target.value)
                    }
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
                  value={setting.minAge}
                  onChange={(event) =>
                    updateRow(
                      setting.tier,
                      "minAge",
                      parseInt(event.target.value, 10)
                    )
                  }
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
                    lastTier && setting.tier === lastTier.tier
                      ? "No limit"
                      : String(
                          (sorted.find((row) => row.sortOrder === setting.sortOrder + 1)
                            ?.minAge ?? 0) - 1
                        )
                  }
                  className="bg-slate-50 text-slate-500"
                />
                {!(lastTier && setting.tier === lastTier.tier) ? (
                  <p className="text-xs text-slate-400">
                    Auto-calculated from next tier&apos;s min age
                  </p>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label>Xero Contact Group</Label>
                <Select
                  value={setting.xeroContactGroupId ?? "__none__"}
                  onValueChange={(value) => updateXeroContactGroup(setting.tier, value)}
                  disabled={!editing || loadingXeroGroups || refreshingXeroGroups}
                >
                  <SelectTrigger className={!editing ? "bg-slate-50 text-slate-700" : ""}>
                    <SelectValue placeholder="Not mapped" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not mapped</SelectItem>
                    {setting.xeroContactGroupId &&
                    !xeroGroups.some((group) => group.id === setting.xeroContactGroupId) ? (
                      <SelectItem value={setting.xeroContactGroupId}>
                        {setting.xeroContactGroupName ?? setting.xeroContactGroupId}
                      </SelectItem>
                    ) : null}
                    {xeroGroups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name} ({group.contactCount})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-400">
                  Linked members in this tier will be kept in the mapped Xero group.
                </p>
              </div>
            </div>
          ))}

          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          {success ? (
            <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              Age tier settings saved successfully.
            </div>
          ) : null}

          {editing ? (
            <div className="flex gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
              <Button variant="outline" onClick={handleCancel} disabled={saving}>
                Cancel
              </Button>
            </div>
          ) : null}
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
                <th className="text-left py-2 font-medium text-slate-700">Xero Group</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((setting) => (
                <tr key={setting.tier} className="border-b last:border-0">
                  <td className="py-2 font-medium text-slate-900">{setting.tier}</td>
                  <td className="py-2 text-slate-600">{setting.label}</td>
                  <td className="py-2 text-slate-600">
                    {setting.maxAge !== null
                      ? `${setting.minAge} – ${setting.maxAge}`
                      : `${setting.minAge}+`}
                  </td>
                  <td className="py-2 text-slate-600">
                    {setting.xeroContactGroupName ??
                      setting.xeroContactGroupId ??
                      "Not mapped"}
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
