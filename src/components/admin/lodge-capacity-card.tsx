"use client";

import { useEffect, useRef, useState } from "react";
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
import { LodgeSelect, useLodgeOptions } from "@/components/lodge-select";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";

interface LodgeSettingsResponse {
  capacity: number | null;
  hutLeaderLookaheadDays: number;
  schoolGroupSoftCap: number;
  clubConfigCapacity: number;
}

export function LodgeCapacityCard() {
  // Per-lodge capacity override scope (lodge-scoping contract); the picker
  // renders nothing while fewer than two lodges exist (ADR-002). The
  // hut-leader lookahead stays club-wide whichever lodge is selected.
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(null);
  const { hutLeaderLabel } = useClubIdentity();
  // This card writes the label as a hyphenated compound adjective ("hut-leader"),
  // so hyphenate the lowercased label to keep the default render byte-identical.
  const hutLeaderAdj = hutLeaderLabel.toLowerCase().replace(/\s+/g, "-");
  const hutLeaderAdjSentence =
    hutLeaderAdj.charAt(0).toUpperCase() + hutLeaderAdj.slice(1);
  const [clubConfigCapacity, setClubConfigCapacity] = useState<number | null>(
    null,
  );
  const [capacityValue, setCapacityValue] = useState("");
  const [hutLeaderLookaheadValue, setHutLeaderLookaheadValue] = useState("14");
  // Per-lodge school-group soft cap (a warning threshold on the public
  // school request form). Blank shows the resolved default.
  const [softCapValue, setSoftCapValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const { scrollToError, scrollToTop } = useScrollToFeedback();

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        lodgeId
          ? `/api/admin/lodge-settings?lodgeId=${encodeURIComponent(lodgeId)}`
          : "/api/admin/lodge-settings",
        { credentials: "same-origin" },
      );
      // The embedding page normally hides this card by permission matrix; this
      // in-card backstop keeps a future cross-area embedding degrading quietly
      // (render nothing) instead of showing the error box for a viewer who
      // simply lacks lodge access. Genuine failures (5xx/network) keep it.
      if (response.status === 403 || response.status === 401) {
        // Dev breadcrumb: the embedding page hides this card by matrix, so a
        // denial here means matrix↔enforcement drift or mid-session revocation.
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "LodgeCapacityCard: lodge-settings fetch denied; hiding card (matrix/enforcement drift or revoked session?)",
          );
        }
        setForbidden(true);
        return;
      }
      if (!response.ok) throw new Error("Failed to load lodge settings");
      const body = (await response.json()) as LodgeSettingsResponse;
      setClubConfigCapacity(body.clubConfigCapacity);
      setCapacityValue(body.capacity === null ? "" : String(body.capacity));
      setHutLeaderLookaheadValue(String(body.hutLeaderLookaheadDays));
      setSoftCapValue(String(body.schoolGroupSoftCap));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load lodge settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lodgeId]);

  useEffect(() => {
    if (error) scrollToError(feedbackRef);
  }, [error, scrollToError]);

  useEffect(() => {
    if (savedMessage) scrollToTop(cardRef);
  }, [savedMessage, scrollToTop]);

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
      setError(`Enter a ${hutLeaderAdj} lookahead between 1 and 365 days.`);
      setSaving(false);
      return;
    }

    const softCapTrimmed = softCapValue.trim();
    let schoolGroupSoftCap: number | null = null;
    if (softCapTrimmed !== "") {
      const parsedSoftCap = Number(softCapTrimmed);
      if (!Number.isInteger(parsedSoftCap) || parsedSoftCap <= 0) {
        setError("Enter a whole number greater than zero for the school-group cap, or leave blank for the default.");
        setSaving(false);
        return;
      }
      schoolGroupSoftCap = parsedSoftCap;
    }

    try {
      const response = await fetch("/api/admin/lodge-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capacity,
          hutLeaderLookaheadDays,
          schoolGroupSoftCap,
          ...(lodgeId ? { lodgeId } : {}),
        }),
      });
      if (!response.ok) throw new Error("Failed to save lodge settings");
      const body = (await response.json()) as LodgeSettingsResponse;
      setClubConfigCapacity(body.clubConfigCapacity);
      setCapacityValue(body.capacity === null ? "" : String(body.capacity));
      setHutLeaderLookaheadValue(String(body.hutLeaderLookaheadDays));
      setSoftCapValue(String(body.schoolGroupSoftCap));
      setSavedMessage("Lodge settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lodge settings");
    } finally {
      setSaving(false);
    }
  }

  if (forbidden) return null;

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <CardTitle className="text-lg">Lodge settings</CardTitle>
        <CardDescription>
          Set the fallback lodge capacity and how far ahead {hutLeaderAdj}{" "}
          coverage is checked for dashboard and Needs Attention warnings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <LodgeSelect
          lodges={lodges}
          value={lodgeId}
          onChange={setLodgeId}
          loading={lodgesLoading}
        />
        {(error || savedMessage) && (
          <div
            ref={feedbackRef}
            role={error ? "alert" : "status"}
            tabIndex={error ? -1 : undefined}
            className={
              error
                ? "scroll-mt-20 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 focus:outline-none"
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
              {hutLeaderAdjSentence} lookahead (days)
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
          <div className="space-y-1">
            <Label htmlFor="school-group-soft-cap">
              School-group soft cap (beds)
            </Label>
            <Input
              id="school-group-soft-cap"
              type="number"
              min={1}
              inputMode="numeric"
              className="w-44"
              placeholder="Default"
              value={softCapValue}
              onChange={(event) => {
                setSoftCapValue(event.target.value);
                setSavedMessage("");
              }}
              disabled={loading || saving}
            />
            <p className="text-xs text-slate-500">
              School groups above this many beds are warned they need a club
              member to host. Blank uses the default. Warning only — the hard
              limit stays the capacity above.
            </p>
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
