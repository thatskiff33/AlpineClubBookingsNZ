"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Save } from "lucide-react";
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
import { useActionAttention } from "@/hooks/use-scroll-to-feedback";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  MAX_CONFIGURED_LODGE_CAPACITY,
  MIN_CONFIGURED_LODGE_CAPACITY,
  parseConfiguredLodgeCapacity,
} from "@/lib/lodge-effective-capacity";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { LodgeScopeStatusNotice } from "@/components/admin/lodge-options-status";
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope";

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
  //
  // #2701: a FAILED lodge list is not a single-lodge club. Both are an empty
  // `lodges`, the picker disappears either way, and `lodgeId` stays null — which
  // /api/admin/lodge-settings resolves to the club's DEFAULT lodge. So a capacity
  // typed here would have been saved against a lodge that was never named on
  // screen. The settled-scope gate stops loading, failure, 403, and empty
  // responses until a successful response validates a real lodge.
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
    reload: reloadLodges,
  } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(null);
  // Lodge capacity settings write to /api/admin/lodge-settings (area "lodge"),
  // so gate the editor on lodge:edit — a lodge:view admin can read but not
  // change (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  // Role AND a known lodge. Every control below gates on this, not on canEdit.
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: lodgeId,
    loading: lodgesLoading,
    failed: lodgesFailed,
    forbidden: lodgesForbidden,
  });
  const scopedLodgeId = lodgeScope.kind === "lodge" ? lodgeScope.lodgeId : null;
  const lodgeScopeReady = scopedLodgeId !== null;
  const canWrite = canEdit && lodgeScopeReady;
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
  // A scope change can leave the previous lodge's GET in flight. Fence every
  // result as well as aborting it: some fetch mocks/transports ignore abort,
  // and a late A response must never repopulate the form now labelled B.
  const loadSequenceRef = useRef(0);
  const saveSequenceRef = useRef(0);
  const activeLodgeIdRef = useRef<string | null>(scopedLodgeId);
  useEffect(() => {
    activeLodgeIdRef.current = scopedLodgeId;
  }, [scopedLodgeId]);

  async function load(
    requestedLodgeId: string,
    sequence: number,
    signal: AbortSignal,
  ) {
    // #2701: without the lodge list, an unfiltered read resolves server-side to
    // the club's default lodge — so the numbers below would describe one lodge
    // while the card names none. Do not read, and do not fall back club-wide.
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/lodge-settings?lodgeId=${encodeURIComponent(requestedLodgeId)}`,
        { credentials: "same-origin", signal },
      );
      if (signal.aborted || sequence !== loadSequenceRef.current) return;
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
      if (signal.aborted || sequence !== loadSequenceRef.current) return;
      setClubConfigCapacity(body.clubConfigCapacity);
      setCapacityValue(body.capacity === null ? "" : String(body.capacity));
      setHutLeaderLookaheadValue(String(body.hutLeaderLookaheadDays));
      setSoftCapValue(String(body.schoolGroupSoftCap));
    } catch (err) {
      if (signal.aborted || sequence !== loadSequenceRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load lodge settings");
    } finally {
      if (!signal.aborted && sequence === loadSequenceRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const sequence = (loadSequenceRef.current += 1);
    // Invalidate a save started for the previous lodge. Its response may still
    // arrive (and a fetch mock may ignore abort), but it no longer owns any UI
    // state on the newly labelled card.
    saveSequenceRef.current += 1;
    setSaving(false);
    setError("");
    setSavedMessage("");
    setForbidden(false);
    setClubConfigCapacity(null);
    setCapacityValue("");
    setHutLeaderLookaheadValue("14");
    setSoftCapValue("");
    const controller = new AbortController();
    if (!scopedLodgeId) {
      setLoading(false);
      return () => controller.abort();
    }
    void load(scopedLodgeId, sequence, controller.signal);
    return () => controller.abort();
  }, [scopedLodgeId]);

  // Failure wins, success positions at the top, and neither runs for a
  // passive re-render — the shared action-attention rule (#2934).
  useActionAttention({
    error: error,
    errorTarget: feedbackRef,
    success: savedMessage,
    successTarget: cardRef,
  });

  async function save() {
    // #2701 backstop for the disabled Save button: a PUT with no lodgeId lands
    // on the club's default lodge, and while the lodge list is down nobody has
    // chosen that lodge.
    if (!scopedLodgeId) return;
    const requestedLodgeId = scopedLodgeId;
    const sequence = (saveSequenceRef.current += 1);
    const ownsCurrentScope = () =>
      sequence === saveSequenceRef.current &&
      activeLodgeIdRef.current === requestedLodgeId;
    setSaving(true);
    setError("");
    setSavedMessage("");

    // The same field, the same route, the same bounds as the lodge
    // configuration screen's capacity box — read from the one definition
    // rather than spelled out again here (#2724, INV-SSOT-001). This copy had
    // no upper bound at all, so a figure above the schema's maximum was
    // accepted locally and refused by the server as a bare "Invalid input".
    const typedCapacity = parseConfiguredLodgeCapacity(capacityValue);
    if (typedCapacity.kind === "invalid") {
      setError(typedCapacity.message);
      setSaving(false);
      return;
    }
    const capacity: number | null =
      typedCapacity.kind === "valid" ? typedCapacity.capacity : null;

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
          lodgeId: requestedLodgeId,
        }),
      });
      if (!ownsCurrentScope()) return;
      // A stale tab whose permissions were narrowed after load surfaces a
      // persistent forbidden-save message rather than the generic failure (#1940).
      if (response.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!response.ok) throw new Error("Failed to save lodge settings");
      const body = (await response.json()) as LodgeSettingsResponse;
      if (!ownsCurrentScope()) return;
      setClubConfigCapacity(body.clubConfigCapacity);
      setCapacityValue(body.capacity === null ? "" : String(body.capacity));
      setHutLeaderLookaheadValue(String(body.hutLeaderLookaheadDays));
      setSoftCapValue(String(body.schoolGroupSoftCap));
      setSavedMessage("Lodge settings saved.");
    } catch (err) {
      if (!ownsCurrentScope()) return;
      setError(err instanceof Error ? err.message : "Failed to save lodge settings");
    } finally {
      if (ownsCurrentScope()) setSaving(false);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view the lodge capacity settings but cannot
      change them. Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

  // A cross-area 403 hides the whole card, banner included — there is no
  // section left here for the banner to explain.
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
      <CardContent>
        {viewOnlyBanner}
        <div className="space-y-4">
        <LodgeSelect
          lodges={lodges}
          value={lodgeId}
          onChange={setLodgeId}
          loading={lodgesLoading}
          deferDefaultSelection={lodgesFailed || lodgesForbidden}
        />
        {/* #2701: without this the picker simply vanished and the card read as
            a single-lodge club's settings. */}
        <LodgeScopeStatusNotice
          scope={lodgeScope}
          onRetry={reloadLodges}
          what="these lodge capacity settings"
        />
        {lodgeScopeReady && (error || savedMessage) && (
          <div
            ref={feedbackRef}
            role={error ? "alert" : "status"}
            tabIndex={error ? -1 : undefined}
            className={
              error
                ? "scroll-mt-20 rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11 focus:outline-none"
                : "rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11"
            }
          >
            {error || savedMessage}
          </div>
        )}

        {lodgeScopeReady ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="lodge-capacity">Capacity (beds/guests)</Label>
            <Input
              id="lodge-capacity"
              type="number"
              min={MIN_CONFIGURED_LODGE_CAPACITY}
              max={MAX_CONFIGURED_LODGE_CAPACITY}
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
              disabled={loading || saving || !canWrite}
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
              disabled={loading || saving || !canWrite}
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
              disabled={loading || saving || !canWrite}
            />
            <p className="text-xs text-muted-foreground">
              School groups above this many beds are warned they need a club
              member to host. Blank uses the default. Warning only — the hard
              limit stays the capacity above.
            </p>
          </div>
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            type="button"
            onClick={() => void save()}
            // #2701: `canEdit` still carries the ROLE reason (that is what the
            // view-only affordance explains); a missing lodge list disables the
            // save here instead, with the notice above saying why.
            disabled={loading || saving}
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save
          </ViewOnlyActionButton>
        </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Leave capacity blank to use the club default
          {clubConfigCapacity === null ? "" : ` (${clubConfigCapacity})`}. Hut
          leader warnings include unassigned dates from today through the
          configured lookahead.
        </p>
        </div>
      </CardContent>
    </Card>
  );
}
