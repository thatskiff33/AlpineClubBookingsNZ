"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/admin/back-link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { buildCopiedSeasonPayload } from "@/lib/season-rate-editor";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";

// New-lodge setup wizard (ADR-003 follow-up, implementation-plan "Future
// Enhancements"): a guided flow over the existing hub building blocks —
// identity via PATCH /api/admin/lodges/[id], quick-seed via the bulk
// rooms/lockers endpoints, and copy-from-existing-lodge for seasons/rates
// and chores through the standard admin create routes. Everything here
// reuses already-validated APIs; the wizard adds no new server surface.
// Steps are gated by the same module flags as the hub, and every step can
// be skipped — an unconfigured lodge is safe because it resolves to
// capacity 0 (phase 3).

interface LodgeRecord {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  doorCode: string | null;
  travelNote: string | null;
}

interface SeasonRecord {
  id: string;
  name: string;
  type: "WINTER" | "SUMMER";
  startDate: string;
  endDate: string;
  active: boolean;
  // Authoritative pricing rows, keyed by membership type + optional age tier
  // (#1930, E4). `ageTier` is null for a flat type (ageGroupsApply=false).
  // The legacy boolean-keyed `rates` relation is no longer returned by
  // GET /api/admin/seasons (#2129), so it is not declared here.
  membershipTypeRates: Array<{
    membershipTypeId: string;
    ageTier: string | null;
    pricePerNightCents: number;
  }>;
}

interface ChoreRecord {
  id: string;
  name: string;
  description: string;
  recommendedPeopleMin: number;
  recommendedPeopleMax: number;
  isEssential: boolean;
  ageRestriction: string;
  conditionalNote: string | null;
  minAge: number;
  sortOrder: number;
  timeOfDay: string;
  frequencyMode: string;
  frequencyDays: number | null;
  frequencyDaysOfWeek: number[];
  active: boolean;
}

type StepKey = "identity" | "rooms" | "lockers" | "seasons" | "chores" | "finish";

const ALL_STEPS: Array<{ key: StepKey; label: string }> = [
  { key: "identity", label: "Identity" },
  { key: "rooms", label: "Rooms & Beds" },
  { key: "lockers", label: "Lockers" },
  { key: "seasons", label: "Seasons & Rates" },
  { key: "chores", label: "Chores" },
  { key: "finish", label: "Finish" },
];

type CopyState =
  | { status: "idle" }
  | { status: "copying" }
  | { status: "done"; copied: number; failed: string[] };

export default function LodgeSetupWizardPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const lodgeId = params.id;
  // The wizard writes lodge identity plus rooms/lockers/seasons/chores; it is
  // reached under the lodge area, so a lodge:view admin sees it read-only.
  // (The seed/copy steps also hit bookings-area routes, which independently
  // enforce their own edit level — surfaced as a forbidden-save on 403.) #1940
  const canEdit = useAdminAreaEditAccess("lodge");
  // #2264 — the room/locker prefix examples move under their fields. Both keep
  // the `${lodge.name}` interpolation, so the example still reads as this
  // lodge's own naming rather than a generic one.
  const roomPrefixHint = useFieldHint();
  const lockerPrefixHint = useFieldHint();

  const [lodge, setLodge] = useState<LodgeRecord | null>(null);
  const [otherLodges, setOtherLodges] = useState<LodgeRecord[]>([]);
  const [modules, setModules] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<StepKey>("identity");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Step 1 — identity
  const [name, setName] = useState("");
  const [doorCode, setDoorCode] = useState("");
  const [travelNote, setTravelNote] = useState("");

  // Step 2 — rooms quick-seed. Names are unique per lodge, so plain
  // prefixes work; the lodge-name default just reads nicely on boards.
  const [roomCount, setRoomCount] = useState("4");
  const [bedsPerRoom, setBedsPerRoom] = useState("4");
  const [roomPrefix, setRoomPrefix] = useState("");
  const [roomsSeeded, setRoomsSeeded] = useState<string | null>(null);

  // Step 3 — lockers quick-seed
  const [lockerCount, setLockerCount] = useState("10");
  const [lockerPrefix, setLockerPrefix] = useState("");
  const [lockersSeeded, setLockersSeeded] = useState<string | null>(null);

  // Steps 4 & 5 — copy-from-lodge
  const [seasonSourceLodgeId, setSeasonSourceLodgeId] = useState("");
  const [seasonCopy, setSeasonCopy] = useState<CopyState>({ status: "idle" });
  const [choreSourceLodgeId, setChoreSourceLodgeId] = useState("");
  const [choreCopy, setChoreCopy] = useState<CopyState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const [lodgesRes, modulesRes] = await Promise.all([
          fetch("/api/admin/lodges"),
          fetch("/api/admin/modules"),
        ]);
        if (!lodgesRes.ok) throw new Error("Failed to load lodges");
        const lodgesData = await lodgesRes.json();
        const found = (lodgesData.lodges ?? []).find(
          (candidate: LodgeRecord) => candidate.id === lodgeId,
        );
        if (!found) throw new Error("Lodge not found");
        const flags: Record<string, boolean> = {};
        if (modulesRes.ok) {
          const modulesData = await modulesRes.json();
          for (const [key, value] of Object.entries(modulesData.settings ?? {})) {
            if (typeof value === "boolean") flags[key] = value;
          }
        }
        if (cancelled) return;
        setLodge(found);
        setOtherLodges(
          (lodgesData.lodges ?? []).filter(
            (candidate: LodgeRecord) =>
              candidate.id !== lodgeId && candidate.active,
          ),
        );
        setModules(flags);
        setName(found.name);
        setDoorCode(found.doorCode ?? "");
        setTravelNote(found.travelNote ?? "");
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [lodgeId]);

  // Same gating as the hub: bedAllocation and chores default off, lockers
  // defaults on; a missing flag falls back to the module's default.
  const steps = useMemo(
    () =>
      ALL_STEPS.filter((candidate) => {
        if (candidate.key === "rooms") return modules.bedAllocation === true;
        if (candidate.key === "lockers") return modules.lockers !== false;
        if (candidate.key === "chores") return modules.chores === true;
        return true;
      }),
    [modules],
  );
  const stepIndex = steps.findIndex((s) => s.key === step);

  const goNext = useCallback(() => {
    setError("");
    const next = steps[stepIndex + 1];
    if (next) setStep(next.key);
  }, [steps, stepIndex]);

  const goBack = useCallback(() => {
    setError("");
    const previous = steps[stepIndex - 1];
    if (previous) setStep(previous.key);
  }, [steps, stepIndex]);

  async function saveIdentity() {
    if (!name.trim()) {
      setError("Lodge name is required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/lodges/${encodeURIComponent(lodgeId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          doorCode: doorCode.trim() || null,
          travelNote: travelNote.trim() || null,
        }),
      });
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!res.ok) throw new Error(await apiErrorMessageFromResponse(res, "Failed to save lodge"));
      const data = await res.json();
      setLodge(data.lodge);
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lodge");
    } finally {
      setSaving(false);
    }
  }

  async function seedRooms() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/bed-allocation/rooms/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomCount: Number(roomCount),
          bedsPerRoom: Number(bedsPerRoom),
          namePrefix: roomPrefix.trim() || `${lodge?.name ?? "Lodge"} room`,
          lodgeId,
        }),
      });
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!res.ok) throw new Error(await apiErrorMessageFromResponse(res, "Failed to create rooms"));
      const data = await res.json();
      setRoomsSeeded(
        `Created ${data.createdRoomCount} rooms with ${data.createdBedCount} beds.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create rooms");
    } finally {
      setSaving(false);
    }
  }

  async function seedLockers() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/lockers/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: Number(lockerCount),
          // Lodge-prefixed default keeps names unique across lodges until
          // the contract release scopes locker uniqueness per lodge.
          namePrefix: lockerPrefix.trim() || `${lodge?.name ?? "Locker"} locker`,
          lodgeId,
        }),
      });
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!res.ok) throw new Error(await apiErrorMessageFromResponse(res, "Failed to create lockers"));
      const data = await res.json();
      setLockersSeeded(`Created ${data.createdCount} lockers.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create lockers");
    } finally {
      setSaving(false);
    }
  }

  async function copySeasons() {
    if (!seasonSourceLodgeId) return;
    setSaving(true);
    setError("");
    setSeasonCopy({ status: "copying" });
    try {
      const res = await fetch(
        `/api/admin/seasons?lodgeId=${encodeURIComponent(seasonSourceLodgeId)}`,
      );
      if (!res.ok) throw new Error("Failed to load the source lodge's seasons");
      const sourceSeasons: SeasonRecord[] = await res.json();
      if (sourceSeasons.length === 0) {
        setSeasonCopy({ status: "idle" });
        setError("The selected lodge has no seasons to copy.");
        return;
      }
      let copied = 0;
      const failed: string[] = [];
      for (const season of sourceSeasons) {
        const createRes = await fetch("/api/admin/seasons", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Shared with the route-level test that asserts this exact body is
          // accepted by `seasonSchema` (#2129). Membership types are global
          // (no lodgeId), so their ids carry across lodges unchanged; POST
          // requires `membershipTypeRates`, and this used to send the legacy
          // `rates` key, which meant every copy silently 400'd on validation.
          body: JSON.stringify(buildCopiedSeasonPayload(season, lodgeId)),
        });
        if (createRes.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          setSeasonCopy({ status: "idle" });
          return;
        }
        if (createRes.ok) {
          copied += 1;
        } else {
          failed.push(
            `${season.name}: ${await apiErrorMessageFromResponse(createRes, "failed")}`,
          );
        }
      }
      setSeasonCopy({ status: "done", copied, failed });
    } catch (err) {
      setSeasonCopy({ status: "idle" });
      setError(err instanceof Error ? err.message : "Failed to copy seasons");
    } finally {
      setSaving(false);
    }
  }

  async function copyChores() {
    if (!choreSourceLodgeId) return;
    setSaving(true);
    setError("");
    setChoreCopy({ status: "copying" });
    try {
      const res = await fetch(
        `/api/admin/chores?lodgeId=${encodeURIComponent(choreSourceLodgeId)}`,
      );
      if (!res.ok) throw new Error("Failed to load the source lodge's chores");
      const sourceChores: ChoreRecord[] = await res.json();
      if (sourceChores.length === 0) {
        setChoreCopy({ status: "idle" });
        setError("The selected lodge has no chores to copy.");
        return;
      }
      let copied = 0;
      const failed: string[] = [];
      for (const chore of sourceChores) {
        const createRes = await fetch("/api/admin/chores", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: chore.name,
            description: chore.description ?? "",
            recommendedPeopleMin: chore.recommendedPeopleMin,
            recommendedPeopleMax: chore.recommendedPeopleMax,
            isEssential: chore.isEssential,
            ageRestriction: chore.ageRestriction,
            conditionalNote: chore.conditionalNote,
            minAge: chore.minAge,
            sortOrder: chore.sortOrder,
            timeOfDay: chore.timeOfDay,
            frequencyMode: chore.frequencyMode,
            frequencyDays: chore.frequencyDays,
            frequencyDaysOfWeek: chore.frequencyDaysOfWeek ?? [],
            active: chore.active,
            lodgeId,
          }),
        });
        if (createRes.status === 403) {
          setError(ADMIN_FORBIDDEN_SAVE_REASON);
          setChoreCopy({ status: "idle" });
          return;
        }
        if (createRes.ok) {
          copied += 1;
        } else {
          failed.push(`${chore.name}: ${await apiErrorMessageFromResponse(createRes, "failed")}`);
        }
      }
      setChoreCopy({ status: "done", copied, failed });
    } catch (err) {
      setChoreCopy({ status: "idle" });
      setError(err instanceof Error ? err.message : "Failed to copy chores");
    } finally {
      setSaving(false);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It is rendered in the loading branch too
    so the region exists from the first paint rather than from whenever the
    lodge fetch settles, and it sits OUTSIDE the `space-y-*` stack so the empty
    wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the lodge setup wizard but cannot change
      anything. Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="py-12 text-center text-muted-foreground">Loading...</div>
      </div>
    );
  }
  if (loadError || !lodge) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-4">
          <p className="text-destructive">{loadError ?? "Lodge not found"}</p>
          <BackLink href="/admin/lodges" label="Lodges" />
        </div>
      </div>
    );
  }

  const configureHref = (path: string) =>
    `${path}?lodgeId=${encodeURIComponent(lodgeId)}`;

  function copySummary(state: CopyState, unit: string) {
    if (state.status !== "done") return null;
    return (
      <div className="text-sm space-y-1">
        <p className="text-success-11">
          Copied {state.copied} {unit}
          {state.copied === 1 ? "" : "s"}.
        </p>
        {state.failed.length > 0 && (
          <ul className="text-destructive list-disc pl-5">
            {state.failed.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      {viewOnlyBanner}
      <div className="space-y-6">
      <div>
        <BackLink
          href={`/admin/lodges/${encodeURIComponent(lodgeId)}`}
          label="Lodge configuration"
        />
        <h1 className="text-3xl font-bold mt-2">Set up {lodge.name}</h1>
        <p className="text-muted-foreground mt-1">
          A guided setup for the new lodge. Every step can be skipped and
          finished later from the lodge configuration page — an unconfigured
          lodge simply has no bookable capacity yet.
        </p>
      </div>

      {/* Step indicator */}
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {steps.map((entry, index) => (
          <li key={entry.key} className="flex items-center gap-2">
            {index > 0 && <span className="text-muted-foreground">&rarr;</span>}
            <span
              className={
                entry.key === step
                  ? "app-step-active font-medium"
                  : index < stepIndex
                    ? "text-success-11"
                    : "text-muted-foreground"
              }
            >
              {index < stepIndex ? (
                <Check className="inline h-4 w-4 mr-0.5" />
              ) : null}
              {index + 1}. {entry.label}
            </span>
          </li>
        ))}
      </ol>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {step === "identity" && (
        <Card>
          <CardHeader>
            <CardTitle>Lodge identity</CardTitle>
            <CardDescription>
              The name appears in booking emails and member-facing pages; the
              door code and travel note are included in pre-arrival emails for
              this lodge.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="wizard-name">Name</Label>
              <Input
                id="wizard-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                disabled={!canEdit}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wizard-door-code">Door code (optional)</Label>
              <Input
                id="wizard-door-code"
                value={doorCode}
                onChange={(e) => setDoorCode(e.target.value)}
                maxLength={80}
                disabled={!canEdit}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wizard-travel-note">Travel note (optional)</Label>
              <Textarea
                id="wizard-travel-note"
                value={travelNote}
                onChange={(e) => setTravelNote(e.target.value)}
                maxLength={2000}
                rows={3}
                disabled={!canEdit}
              />
            </div>
            <div className="flex gap-3">
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={saveIdentity} disabled={saving}>
                {saving ? "Saving..." : "Save and continue"}
              </ViewOnlyActionButton>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "rooms" && (
        <Card>
          <CardHeader>
            <CardTitle>Rooms &amp; beds</CardTitle>
            <CardDescription>
              Quick-seed the lodge&apos;s layout — &quot;we have 4 rooms of 4
              beds&quot; — and fine-tune names later. Active beds set the
              lodge&apos;s booking capacity.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="wizard-room-count">Rooms</Label>
                <Input
                  id="wizard-room-count"
                  type="number"
                  min="1"
                  max="20"
                  value={roomCount}
                  onChange={(e) => setRoomCount(e.target.value)}
                  disabled={!canEdit}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wizard-beds-per-room">Beds per room</Label>
                <Input
                  id="wizard-beds-per-room"
                  type="number"
                  min="0"
                  max="20"
                  value={bedsPerRoom}
                  onChange={(e) => setBedsPerRoom(e.target.value)}
                  disabled={!canEdit}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wizard-room-prefix">Room name prefix</Label>
                <Input
                  id="wizard-room-prefix"
                  value={roomPrefix}
                  onChange={(e) => setRoomPrefix(e.target.value)}
                  maxLength={80}
                  disabled={!canEdit}
                  {...roomPrefixHint.fieldProps}
                />
                <FieldHint {...roomPrefixHint.hintProps}>
                  {`Example: ${lodge.name} room`}
                </FieldHint>
              </div>
            </div>
            {roomsSeeded && <p className="text-sm text-success-11">{roomsSeeded}</p>}
            <p className="text-sm text-muted-foreground">
              Need a mixed layout? Use the full editor:{" "}
              <Link className="underline" href={configureHref("/admin/rooms-beds")}>
                rooms &amp; beds
              </Link>
              .
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={goBack} disabled={saving}>
                Back
              </Button>
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={seedRooms} disabled={saving || roomsSeeded !== null}>
                {saving ? "Creating..." : "Create rooms"}
              </ViewOnlyActionButton>
              <Button variant="ghost" onClick={goNext} disabled={saving}>
                {roomsSeeded ? "Continue" : "Skip for now"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "lockers" && (
        <Card>
          <CardHeader>
            <CardTitle>Lockers</CardTitle>
            <CardDescription>
              Create the lodge&apos;s lockers in one go; allocate them to
              members later from the lockers page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="wizard-locker-count">Lockers</Label>
                <Input
                  id="wizard-locker-count"
                  type="number"
                  min="1"
                  max="100"
                  value={lockerCount}
                  onChange={(e) => setLockerCount(e.target.value)}
                  disabled={!canEdit}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wizard-locker-prefix">Name prefix</Label>
                <Input
                  id="wizard-locker-prefix"
                  value={lockerPrefix}
                  onChange={(e) => setLockerPrefix(e.target.value)}
                  maxLength={80}
                  disabled={!canEdit}
                  {...lockerPrefixHint.fieldProps}
                />
                <FieldHint {...lockerPrefixHint.hintProps}>
                  {`Example: ${lodge.name} locker`}
                </FieldHint>
              </div>
            </div>
            {lockersSeeded && (
              <p className="text-sm text-success-11">{lockersSeeded}</p>
            )}
            <div className="flex gap-3">
              <Button variant="outline" onClick={goBack} disabled={saving}>
                Back
              </Button>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={seedLockers}
                disabled={saving || lockersSeeded !== null}
              >
                {saving ? "Creating..." : "Create lockers"}
              </ViewOnlyActionButton>
              <Button variant="ghost" onClick={goNext} disabled={saving}>
                {lockersSeeded ? "Continue" : "Skip for now"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "seasons" && (
        <Card>
          <CardHeader>
            <CardTitle>Seasons &amp; rates</CardTitle>
            <CardDescription>
              Bookings need a season covering the stay dates to be priced.
              Copy another lodge&apos;s seasons and rates as a starting point,
              then adjust the prices for this lodge.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {otherLodges.length > 0 ? (
              <div className="space-y-2 max-w-md">
                <Label htmlFor="wizard-season-source">Copy from lodge</Label>
                <div className="flex gap-2">
                  <select
                    id="wizard-season-source"
                    className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={seasonSourceLodgeId}
                    onChange={(e) => setSeasonSourceLodgeId(e.target.value)}
                    disabled={saving || !canEdit}
                  >
                    <option value="">Select a lodge…</option>
                    {otherLodges.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    onClick={copySeasons}
                    disabled={
                      saving ||
                      !seasonSourceLodgeId ||
                      seasonCopy.status === "done"
                    }
                  >
                    {seasonCopy.status === "copying" ? "Copying..." : "Copy"}
                  </ViewOnlyActionButton>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No other lodge to copy from yet.
              </p>
            )}
            {copySummary(seasonCopy, "season")}
            <p className="text-sm text-muted-foreground">
              Or create them from scratch on the{" "}
              <Link className="underline" href={configureHref("/admin/seasons")}>
                seasons &amp; rates
              </Link>{" "}
              page.
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={goBack} disabled={saving}>
                Back
              </Button>
              <Button variant="ghost" onClick={goNext} disabled={saving}>
                {seasonCopy.status === "done" ? "Continue" : "Skip for now"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "chores" && (
        <Card>
          <CardHeader>
            <CardTitle>Chores</CardTitle>
            <CardDescription>
              Copy another lodge&apos;s chore list as a starting point for the
              daily roster, then adjust for this lodge.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {otherLodges.length > 0 ? (
              <div className="space-y-2 max-w-md">
                <Label htmlFor="wizard-chore-source">Copy from lodge</Label>
                <div className="flex gap-2">
                  <select
                    id="wizard-chore-source"
                    className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={choreSourceLodgeId}
                    onChange={(e) => setChoreSourceLodgeId(e.target.value)}
                    disabled={saving || !canEdit}
                  >
                    <option value="">Select a lodge…</option>
                    {otherLodges.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    onClick={copyChores}
                    disabled={
                      saving ||
                      !choreSourceLodgeId ||
                      choreCopy.status === "done"
                    }
                  >
                    {choreCopy.status === "copying" ? "Copying..." : "Copy"}
                  </ViewOnlyActionButton>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No other lodge to copy from yet.
              </p>
            )}
            {copySummary(choreCopy, "chore")}
            <p className="text-sm text-muted-foreground">
              Or manage the list on the{" "}
              <Link className="underline" href={configureHref("/admin/chores")}>
                chores
              </Link>{" "}
              page.
            </p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={goBack} disabled={saving}>
                Back
              </Button>
              <Button variant="ghost" onClick={goNext} disabled={saving}>
                {choreCopy.status === "done" ? "Continue" : "Skip for now"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "finish" && (
        <Card>
          <CardHeader>
            <CardTitle>All set</CardTitle>
            <CardDescription>
              {lodge.name} is ready. The configuration page shows what exists
              at this lodge and links into every editor — anything skipped
              here can be finished there.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="text-sm space-y-1 text-muted-foreground list-disc pl-5">
              {roomsSeeded && <li>{roomsSeeded}</li>}
              {lockersSeeded && <li>{lockersSeeded}</li>}
              {seasonCopy.status === "done" && (
                <li>
                  Copied {seasonCopy.copied} season
                  {seasonCopy.copied === 1 ? "" : "s"}
                  {seasonCopy.failed.length > 0
                    ? ` (${seasonCopy.failed.length} failed)`
                    : ""}
                  .
                </li>
              )}
              {choreCopy.status === "done" && (
                <li>
                  Copied {choreCopy.copied} chore
                  {choreCopy.copied === 1 ? "" : "s"}
                  {choreCopy.failed.length > 0
                    ? ` (${choreCopy.failed.length} failed)`
                    : ""}
                  .
                </li>
              )}
            </ul>
            <div className="flex gap-3">
              <Button
                onClick={() =>
                  router.push(`/admin/lodges/${encodeURIComponent(lodgeId)}`)
                }
              >
                Open lodge configuration
              </Button>
              <Button variant="outline" onClick={() => router.push("/admin/lodges")}>
                Back to lodges
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  );
}
