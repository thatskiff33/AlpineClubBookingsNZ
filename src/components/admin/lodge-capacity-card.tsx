"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
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

interface LodgeSettingsResponse {
  capacity: number | null;
  hutLeaderLookaheadDays: number;
  clubConfigCapacity: number;
}

export function LodgeCapacityCard() {
  const [clubConfigCapacity, setClubConfigCapacity] = useState<number | null>(
    null,
  );
  const [capacityValue, setCapacityValue] = useState("");
  const [hutLeaderLookaheadValue, setHutLeaderLookaheadValue] = useState("14");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/lodge-settings", {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Failed to load lodge settings");
      const body = (await response.json()) as LodgeSettingsResponse;
      setClubConfigCapacity(body.clubConfigCapacity);
      setCapacityValue(body.capacity === null ? "" : String(body.capacity));
      setHutLeaderLookaheadValue(String(body.hutLeaderLookaheadDays));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load lodge settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    setSavedMessage("");

    const trimmed = capacityValue.trim();
    let capacity: number | null = null;
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError("Enter a whole number greater than zero, or leave blank to use the default.");
        setSaving(false);
        return;
      }
      capacity = parsed;
    }

    const hutLeaderLookaheadDays = Number(hutLeaderLookaheadValue.trim());
    if (
      !Number.isInteger(hutLeaderLookaheadDays) ||
      hutLeaderLookaheadDays < 1 ||
      hutLeaderLookaheadDays > 365
    ) {
      setError("Enter a hut-leader lookahead between 1 and 365 days.");
      setSaving(false);
      return;
    }

    try {
      const response = await fetch("/api/admin/lodge-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacity, hutLeaderLookaheadDays }),
      });
      if (!response.ok) throw new Error("Failed to save lodge settings");
      const body = (await response.json()) as LodgeSettingsResponse;
      setClubConfigCapacity(body.clubConfigCapacity);
      setCapacityValue(body.capacity === null ? "" : String(body.capacity));
      setHutLeaderLookaheadValue(String(body.hutLeaderLookaheadDays));
      setSavedMessage("Lodge settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lodge settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Lodge settings</CardTitle>
        <CardDescription>
          Set the fallback lodge capacity and how far ahead hut-leader coverage
          is checked for dashboard and Needs Attention warnings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(error || savedMessage) && (
          <div
            className={
              error
                ? "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
                : "rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
            }
          >
            {error || savedMessage}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="lodge-capacity">Capacity (beds/guests)</Label>
            <Input
              id="lodge-capacity"
              type="number"
              min={1}
              inputMode="numeric"
              className="w-40"
              placeholder={
                clubConfigCapacity === null
                  ? "Default"
                  : `Default: ${clubConfigCapacity}`
              }
              value={capacityValue}
              onChange={(event) => {
                setCapacityValue(event.target.value);
                setSavedMessage("");
              }}
              disabled={loading || saving}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hut-leader-lookahead">
              Hut-leader lookahead (days)
            </Label>
            <Input
              id="hut-leader-lookahead"
              type="number"
              min={1}
              max={365}
              inputMode="numeric"
              className="w-44"
              value={hutLeaderLookaheadValue}
              onChange={(event) => {
                setHutLeaderLookaheadValue(event.target.value);
                setSavedMessage("");
              }}
              disabled={loading || saving}
            />
          </div>
          <Button type="button" onClick={() => void save()} disabled={loading || saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save
          </Button>
        </div>

        <p className="text-xs text-slate-500">
          Leave capacity blank to use the club default
          {clubConfigCapacity === null ? "" : ` (${clubConfigCapacity})`}. Hut
          leader warnings include unassigned dates from today through the
          configured lookahead.
        </p>
      </CardContent>
    </Card>
  );
}
