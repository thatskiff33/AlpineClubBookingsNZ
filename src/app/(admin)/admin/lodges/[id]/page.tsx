"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  BedDouble,
  CalendarRange,
  ClipboardList,
  Gauge,
  KeyRound,
  Lock,
  Monitor,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { BackLink } from "@/components/admin/back-link";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { LodgeCapacityGuidance } from "@/components/admin/lodge-capacity-guidance";
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

// Lodge configuration hub (ADR-003): one place to see a lodge's setup state,
// with links into the existing per-area pages pre-filtered via ?lodgeId=.
// Lives inside the /admin/lodges route family (admin-gated); every club can
// reach it to configure its lodge(s).

interface LodgeRecord {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  doorCode: string | null;
  travelNote: string | null;
}

interface AreaSummary {
  loaded: boolean;
  count: number;
  detail?: string;
}

const EMPTY_SUMMARY: AreaSummary = { loaded: false, count: 0 };

const CAPACITY_SOURCE_LABELS: Record<string, string> = {
  configured_beds: "active configured beds",
  capped_beds: "the capacity set below, capping the bed count",
  capacity_override: "the capacity set below",
  // `club_config` was retired in #1982 (the club.json runtime fallback was
  // removed); a lodge with no beds and no override now resolves to 0.
  unconfigured_lodge: "not configured yet",
};

export default function LodgeConfigurationHubPage() {
  const params = useParams<{ id: string }>();
  const lodgeId = params.id;
  // Lodge capacity is lodge config; the write route enforces lodge:edit, so a
  // lodge:view admin sees this screen read-only (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const [lodge, setLodge] = useState<LodgeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modules, setModules] = useState<Record<string, boolean>>({});
  const [rooms, setRooms] = useState<AreaSummary>(EMPTY_SUMMARY);
  const [lockers, setLockers] = useState<AreaSummary>(EMPTY_SUMMARY);
  const [seasons, setSeasons] = useState<AreaSummary>(EMPTY_SUMMARY);
  const [chores, setChores] = useState<AreaSummary>(EMPTY_SUMMARY);
  // Resolved capacity for this lodge and where it came from (beds override
  // vs the admin capacity override vs the default-lodge fallback), plus the
  // editable per-lodge override value. Capacity is core lodge config, set
  // here even when the Bed Allocation module is off.
  const [resolvedCapacity, setResolvedCapacity] = useState<number | null>(null);
  const [capacitySource, setCapacitySource] = useState<string | null>(null);
  // Active bed inventory for this lodge, used to warn when the capacity is set
  // below the installed beds (it then caps the lodge — #1653).
  const [activeBedCount, setActiveBedCount] = useState<number | null>(null);
  // Partner-shared double-bed slots on top of the base figure (#1745), shown
  // broken out so an admin can see the extra is partner-only.
  const [partnerSharedHeadroom, setPartnerSharedHeadroom] = useState(0);
  // The shareable inventory those slots come from: the headroom above is the
  // SAVED capacity's, and the guidance previews an unsaved one (#2724).
  const [activeDoubleBedCount, setActiveDoubleBedCount] = useState(0);
  const [capacityOverride, setCapacityOverride] = useState("");
  const [savedCapacityOverride, setSavedCapacityOverride] = useState("");
  const [savingCapacity, setSavingCapacity] = useState(false);
  const [capacityMessage, setCapacityMessage] = useState<
    { type: "success" | "error"; text: string } | null
  >(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [lodgesRes, modulesRes] = await Promise.all([
          fetch("/api/admin/lodges"),
          fetch("/api/admin/modules"),
        ]);
        if (!lodgesRes.ok) throw new Error("Failed to load lodge");
        const lodgesData = (await lodgesRes.json()) as {
          lodges: LodgeRecord[];
        };
        const found = lodgesData.lodges.find((row) => row.id === lodgeId);
        if (!found) throw new Error("Lodge not found");
        if (cancelled) return;
        setLodge(found);
        if (modulesRes.ok) {
          // /api/admin/modules returns { settings: {<key>: boolean}, modules,
          // ... } — the flat effective toggles live under `settings`, not at the
          // top level. Reading the top level left every flag undefined, so
          // bedAllocationOn was always false here.
          const moduleData = (await modulesRes.json()) as {
            settings?: Record<string, unknown>;
          };
          if (!cancelled) {
            setModules(
              Object.fromEntries(
                Object.entries(moduleData.settings ?? {}).filter(
                  ([, value]) => typeof value === "boolean",
                ),
              ) as Record<string, boolean>,
            );
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load lodge",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [lodgeId]);

  useEffect(() => {
    let cancelled = false;
    const query = `lodgeId=${encodeURIComponent(lodgeId)}`;

    fetch(`/api/admin/bed-allocation/rooms?${query}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const bedCount = (data.rooms ?? []).reduce(
          (total: number, room: { beds: unknown[] }) =>
            total + room.beds.length,
          0,
        );
        setRooms({
          loaded: true,
          count: data.rooms?.length ?? 0,
          detail: `${bedCount} bed${bedCount === 1 ? "" : "s"} · capacity ${data.capacity?.capacity ?? 0}`,
        });
        if (data.capacity) {
          setResolvedCapacity(data.capacity.capacity ?? 0);
          setCapacitySource(data.capacity.source ?? null);
          setActiveBedCount(data.capacity.activeBedCount ?? 0);
          setPartnerSharedHeadroom(data.capacity.partnerSharedHeadroom ?? 0);
          setActiveDoubleBedCount(data.capacity.activeDoubleBedCount ?? 0);
        }
      })
      .catch(() => {});

    fetch(`/api/admin/lockers?${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setLockers({ loaded: true, count: data.lockers?.length ?? 0 });
      })
      .catch(() => {});

    fetch(`/api/admin/seasons?${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        const active = data.filter(
          (season: { active: boolean }) => season.active,
        ).length;
        setSeasons({
          loaded: true,
          count: data.length,
          detail: `${active} active`,
        });
      })
      .catch(() => {});

    fetch(`/api/admin/chores?${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setChores({ loaded: true, count: data.length });
      })
      .catch(() => {});

    fetch(`/api/admin/lodge-settings?${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const value = data.capacity === null || data.capacity === undefined
          ? ""
          : String(data.capacity);
        setCapacityOverride(value);
        setSavedCapacityOverride(value);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [lodgeId]);

  async function saveCapacityOverride() {
    setSavingCapacity(true);
    setCapacityMessage(null);
    const trimmed = capacityOverride.trim();
    // One parser, shared with the guidance beside the field and with the API
    // schema's bounds (#2724, INV-SSOT-001), so a figure the screen calls
    // acceptable is exactly a figure the save accepts — at BOTH bounds.
    const typed = parseConfiguredLodgeCapacity(capacityOverride);
    if (typed.kind === "invalid") {
      setCapacityMessage({ type: "error", text: typed.message });
      setSavingCapacity(false);
      return;
    }
    const capacity: number | null =
      typed.kind === "valid" ? typed.capacity : null;
    try {
      const res = await fetch(
        `/api/admin/lodge-settings?lodgeId=${encodeURIComponent(lodgeId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capacity, lodgeId }),
        },
      );
      if (res.status === 403) {
        setCapacityMessage({ type: "error", text: ADMIN_FORBIDDEN_SAVE_REASON });
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Failed to save capacity");
      }
      setSavedCapacityOverride(trimmed);
      setCapacityMessage({ type: "success", text: "Capacity saved" });
      // Re-read the resolved figure (the lower of beds and this capacity wins).
      const refreshed = await fetch(
        `/api/admin/bed-allocation/rooms?lodgeId=${encodeURIComponent(lodgeId)}`,
        { cache: "no-store" },
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (refreshed?.capacity) {
        setResolvedCapacity(refreshed.capacity.capacity ?? 0);
        setCapacitySource(refreshed.capacity.source ?? null);
        setActiveBedCount(refreshed.capacity.activeBedCount ?? 0);
        // The saved capacity also moves the partner headroom (a cap at or
        // below the bed count zeroes it) — keep the breakout in sync.
        setPartnerSharedHeadroom(refreshed.capacity.partnerSharedHeadroom ?? 0);
        setActiveDoubleBedCount(refreshed.capacity.activeDoubleBedCount ?? 0);
      }
    } catch (err) {
      setCapacityMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to save capacity",
      });
    } finally {
      setSavingCapacity(false);
    }
  }

  const bedAllocationOn = modules.bedAllocation === true;

  const areas = [
    {
      key: "rooms",
      enabled: modules.bedAllocation !== false,
      title: "Rooms & Beds",
      icon: BedDouble,
      href: `/admin/rooms-beds?lodgeId=${encodeURIComponent(lodgeId)}`,
      summary: rooms,
      emptyHint: "No rooms yet — capacity resolves to 0 until beds exist.",
      unit: "room",
    },
    {
      key: "lockers",
      enabled: modules.lockers !== false,
      title: "Lockers",
      icon: Lock,
      href: `/admin/lockers?lodgeId=${encodeURIComponent(lodgeId)}`,
      summary: lockers,
      emptyHint: "No lockers yet.",
      unit: "locker",
    },
    {
      key: "seasons",
      enabled: true,
      title: "Seasons & Rates",
      icon: CalendarRange,
      // Consolidated fee console (#1933, E7): hut nightly rates now live in
      // Fees → Hut Fees with the lodge pre-selected (?lodgeId=). Season windows
      // remain editable on /admin/seasons.
      href: `/admin/fees?lodgeId=${encodeURIComponent(lodgeId)}`,
      summary: seasons,
      emptyHint: "No seasons yet — nights here cannot be priced until one exists.",
      unit: "season",
    },
    {
      key: "chores",
      enabled: modules.chores !== false,
      title: "Chores",
      icon: ClipboardList,
      href: `/admin/chores?lodgeId=${encodeURIComponent(lodgeId)}`,
      summary: chores,
      emptyHint: "No chore templates yet — rosters here will be empty.",
      unit: "chore template",
    },
  ].filter((area) => area.enabled);

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings — which is why it is rendered in the
    loading branch too. It sits OUTSIDE the `space-y-*` stack so the empty
    wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view this lodge&apos;s capacity but cannot
      change it. Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading) {
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading lodge...</p>
      </div>
    );
  }

  if (error || !lodge) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-4">
          <p className="text-sm text-destructive" role="alert">
            {error ?? "Lodge not found."}
          </p>
          <BackLink href="/admin/lodges" label="Lodges" />
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{lodge.name}</h1>
            <Badge variant={lodge.active ? "default" : "secondary"}>
              {lodge.active ? "Active" : "Inactive"}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            Everything this lodge needs, in one place. Each area opens the
            usual page filtered to this lodge.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/admin/lodges/${encodeURIComponent(lodgeId)}/setup`}>
              Setup wizard
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/lodges">
              <ArrowLeft className="mr-2 h-4 w-4" />
              All lodges
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            Identity
          </CardTitle>
          <CardDescription>
            The name, door code, and travel note appear in this lodge&apos;s
            booking and pre-arrival emails. Edit them on the{" "}
            <Link href="/admin/lodges" className="underline">
              Lodges page
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-muted-foreground">Door code</p>
            <p className="font-medium">
              {lodge.doorCode ?? "Not set — door-code emails omit it"}
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-muted-foreground">Travel note</p>
            <p className="font-medium">
              {lodge.travelNote ?? "Not set — emails fall back to the club-wide note"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-4 w-4" />
            Capacity
          </CardTitle>
          <CardDescription>
            {bedAllocationOn
              ? "Bed Allocation is on, so this lodge's capacity is the count of its active beds. Setting a capacity below caps it — the lower of the two applies, so you can install more beds than the lodge may sleep. Leave it blank to use the bed count."
              : "Bed Allocation is off, so this lodge's capacity comes from the value below. Set it before taking bookings — an unset lodge resolves to zero capacity and cannot be booked."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm">
            <p className="text-muted-foreground">Current capacity</p>
            <p className="font-medium">
              {resolvedCapacity === null
                ? "\u2014"
                : `${resolvedCapacity} bed${resolvedCapacity === 1 ? "" : "s"}`}
              {resolvedCapacity !== null && partnerSharedHeadroom > 0
                ? ` + up to ${partnerSharedHeadroom} partner spot${partnerSharedHeadroom === 1 ? "" : "s"}`
                : ""}
              {capacitySource
                ? ` (from ${CAPACITY_SOURCE_LABELS[capacitySource] ?? capacitySource})`
                : ""}
            </p>
            {partnerSharedHeadroom > 0 && (
              <p className="text-xs text-muted-foreground">
                Partner spots are second occupants of shareable double beds:
                admin-placed, only for a guest whose confirmed partner stays
                those nights, and never open to ordinary bookings.
              </p>
            )}
          </div>
          <div className="space-y-1 max-w-xs">
            <Label htmlFor="lodge-capacity-override">
              Capacity for this lodge
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="lodge-capacity-override"
                type="number"
                min={MIN_CONFIGURED_LODGE_CAPACITY}
                max={MAX_CONFIGURED_LODGE_CAPACITY}
                // Both notes describe this field, so both are announced on
                // focus — why a description and not a live region is on
                // LodgeCapacityGuidance (#2724).
                aria-describedby="lodge-capacity-fallback-hint lodge-capacity-guidance"
                value={capacityOverride}
                onChange={(e) => setCapacityOverride(e.target.value)}
                disabled={!canEdit}
                className="w-28"
              />
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={() => void saveCapacityOverride()}
                disabled={savingCapacity || capacityOverride.trim() === savedCapacityOverride.trim()}
              >
                {savingCapacity ? "Saving..." : "Save"}
              </ViewOnlyActionButton>
            </div>
            <p
              id="lodge-capacity-fallback-hint"
              className="text-xs text-muted-foreground"
            >
              Leave blank to fall back to the club default (default lodge) or
              zero (additional lodges).
            </p>
            <LodgeCapacityGuidance
              id="lodge-capacity-guidance"
              capacityInput={capacityOverride}
              activeBedCount={activeBedCount}
              activeDoubleBedCount={activeDoubleBedCount}
            />
          </div>
          {capacityMessage && (
            <div
              className={`rounded-md p-3 text-sm ${
                capacityMessage.type === "success"
                  ? "bg-success-3 text-success-11"
                  : "bg-danger-3 text-danger-11"
              }`}
            >
              {capacityMessage.text}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lobby display: per-lodge display config (LTV-035, #81). Relocated here
          from the retired /admin/display/settings so the controls edit THIS
          lodge, not the club default. Gated on the lobbyDisplay module, matching
          the module gating the area cards below use. */}
      {modules.lobbyDisplay === true && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Monitor className="h-4 w-4" />
              Lobby display
            </CardTitle>
            <CardDescription>
              Per-lodge display values — guest name granularity, committee
              notice, and {"{{config:key}}"} values for this lodge.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-end">
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/lodges/${encodeURIComponent(lodgeId)}/display`}>
                Configure
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {areas.map((area) => {
          const Icon = area.icon;
          const configured = area.summary.loaded && area.summary.count > 0;
          return (
            <Card key={area.key}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="flex items-center gap-2">
                    <Icon className="h-4 w-4" />
                    {area.title}
                  </span>
                  {area.summary.loaded ? (
                    <Badge variant={configured ? "default" : "secondary"}>
                      {configured
                        ? `${area.summary.count} ${area.unit}${area.summary.count === 1 ? "" : "s"}`
                        : "Not set up"}
                    </Badge>
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {configured
                    ? area.summary.detail ?? "Configured."
                    : area.emptyHint}
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link href={area.href}>Configure</Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
      </div>
    </div>
  );
}
