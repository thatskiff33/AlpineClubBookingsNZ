"use client";

import { useEffect, useState } from "react";
import {
  emptyWhakapapaSectionVisibility,
  type WhakapapaCurlData,
  type WhakapapaFacilityItem,
  type WhakapapaTrail,
  type WhakapapaTrailArea,
} from "@/lib/whakapapa-report";
import { useClubTime } from "@/components/club-time-provider";

/**
 * The upstream report's own "updated" stamp is an arbitrary string scraped from
 * the ski field feed, so it may not parse at all. `Intl` throws a RangeError on
 * an invalid Date where `toLocaleString` merely returned "Invalid Date", so the
 * unparseable case falls back to the same "Unknown" the missing case uses
 * rather than taking the conditions panel down (#2264).
 *
 * IT IS THE CLUB'S PERSISTED ZONE, NOT THE VIEWER'S (CT-4, #2870;
 * INV-CONFIG-002). A visitor reading the conditions from Sydney must see the
 * same "last updated" as one reading them at the lodge, so the zone arrives as
 * data through `ClubTimeProvider` - mounted by `website-chrome.tsx` for both
 * public route groups, and by `skifield-whakapapa-embed.tsx` for the one page
 * outside them. A hook rather than a plain function for exactly that reason: the
 * zone is no longer a module constant.
 */
function useUpdatedStampFormatter() {
  const clubTime = useClubTime();
  return (value: string): string => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? "Unknown"
      : clubTime.instantDateTime(parsed);
  };
}

type ApiResponse = WhakapapaCurlData & { error?: string; stale?: boolean };

function StatusCell({ status }: { status: string }) {
  const normalized = status.trim().toLowerCase();

  if (normalized === "open") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-success-11 bg-success-3 conditions-trail-status">
        {status}
      </span>
    );
  }

  if (normalized === "closed") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-danger-11 bg-danger-3 conditions-trail-status">
        {status}
      </span>
    );
  }

  if (normalized === "coming soon") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-muted-foreground bg-muted conditions-trail-status">
        {status}
      </span>
    );
  }

  if (normalized === "unknown" || normalized === "") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-muted-foreground bg-muted conditions-trail-status">
        {status || "Unknown"}
      </span>
    );
  }

  if (normalized === "on hold") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-warning-11 bg-warning-3 conditions-trail-status">
        {status}
      </span>
    );
  }

  if (normalized === "limited availability") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-warning-11 bg-warning-3 conditions-trail-status">
        {status}
      </span>
    );
  }

  return (
    <span className="block w-full text-center">{status || "Unknown"}</span>
  );
}

function FacilityGroup({
  id,
  title,
  items,
  emptyLabel,
}: {
  id: string;
  title: string;
  items: WhakapapaFacilityItem[];
  emptyLabel: string;
}) {
  return (
    <article id={id} className="wcx-group rounded-md border border-border bg-card p-2">
      <h3 className="wcx-group-title text-sm font-semibold text-foreground">{title}</h3>
      {items.length > 0 ? (
        <div
          className={`mt-2 flex flex-wrap gap-2 ${title.replace(/\s+/g, "-").toLowerCase()}-status-container`}
        >
          {items.map((item) => (
            <div
              key={`${item.name}-${item.status}`}
              className={`wcx-item flex flex-col gap-1 rounded-md border border-border bg-card p-2 ${title.replace(/\s+/g, "-").toLowerCase()}-status-item`}
            >
              <span
                className={`text-xs font-medium text-foreground ${title.replace(/\s+/g, "-").toLowerCase()}-status-description`}
              >
                {item.name || "Unknown"}
              </span>
              <StatusCell status={item.status} />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">{emptyLabel}</p>
      )}
    </article>
  );
}

type TrailShape = "circle" | "square" | "diamond";

// Standardised ski trail-difficulty markers. The colours are universal safety
// symbols (not brand/club colours), so they are fixed literals via SVG `fill`
// rather than theme tokens; the thin outline uses `currentColor` (the border
// token) so each shape stays visible on both light and dark cards.
const DIFFICULTY_MARKERS: {
  key: string;
  label: string;
  shape: TrailShape;
  color: string;
}[] = [
  { key: "beginner", label: "Beginner", shape: "circle", color: "#2E9E3F" },
  {
    key: "intermediate",
    label: "Intermediate",
    shape: "square",
    color: "#0B75B8",
  },
  { key: "advanced", label: "Advanced", shape: "diamond", color: "#1A1A1A" },
  { key: "expert", label: "Expert", shape: "diamond", color: "#D22F2F" },
];

function DifficultyShape({
  shape,
  color,
  size = 14,
}: {
  shape: TrailShape;
  color: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="shrink-0 text-border"
      aria-hidden="true"
      focusable="false"
    >
      {shape === "circle" ? (
        <circle
          cx={12}
          cy={12}
          r={9}
          fill={color}
          stroke="currentColor"
          strokeWidth={1.5}
        />
      ) : null}
      {shape === "square" ? (
        <rect
          x={3}
          y={3}
          width={18}
          height={18}
          rx={2}
          fill={color}
          stroke="currentColor"
          strokeWidth={1.5}
        />
      ) : null}
      {shape === "diamond" ? (
        <path
          d="M12 1.5 L22.5 12 L12 22.5 L1.5 12 Z"
          fill={color}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

function DifficultyMarker({ difficulty }: { difficulty: string }) {
  const marker = DIFFICULTY_MARKERS.find(
    (candidate) => candidate.key === difficulty.trim().toLowerCase(),
  );
  if (!marker) {
    return null;
  }
  return (
    <span
      className="inline-flex items-center"
      role="img"
      aria-label={`Difficulty: ${marker.label}`}
      title={marker.label}
    >
      <DifficultyShape shape={marker.shape} color={marker.color} />
    </span>
  );
}

function TrailsKey() {
  return (
    <ul
      className="flex flex-wrap gap-x-3 gap-y-1"
      aria-label="Trail difficulty key"
    >
      {DIFFICULTY_MARKERS.map((marker) => (
        <li
          key={marker.key}
          className="flex items-center gap-1 text-[11px] text-muted-foreground"
        >
          <DifficultyShape
            shape={marker.shape}
            color={marker.color}
            size={12}
          />
          {marker.label}
        </li>
      ))}
    </ul>
  );
}

function TrailCard({ trail }: { trail: WhakapapaTrail }) {
  return (
    <div className="wcx-trail flex flex-col gap-1 rounded-md border border-border bg-card p-2">
      <span className="text-xs font-medium text-foreground conditions-trail-name">
        {trail.name || "Unknown"}
      </span>
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground conditions-trail-details">
        {trail.difficulty ? (
          <DifficultyMarker difficulty={trail.difficulty} />
        ) : null}
        {trail.difficulty && (trail.groomed || trail.size) ? (
          <span aria-hidden>·</span>
        ) : null}
        <span>{trail.groomed ? "Groomed" : "Ungroomed"}</span>
        {trail.size ? (
          <>
            <span aria-hidden>·</span>
            <span>{trail.size}</span>
          </>
        ) : null}
      </div>
      <StatusCell status={trail.status} />
    </div>
  );
}

function TrailAreaName({ name }: { name: string }) {
  if (!name) {
    return null;
  }
  return (
    <h4 className="text-xs font-semibold text-muted-foreground">{name}</h4>
  );
}

// A sub-area is "small" when it holds fewer than 4 trails.
const SMALL_TRAIL_AREA_MAX = 3;

type TrailAreaGroup =
  | { kind: "row"; areas: WhakapapaTrailArea[] }
  | { kind: "block"; area: WhakapapaTrailArea };

// Merge each maximal run of consecutive small (<4 trail) sub-areas into a single
// "row" so their names and trails share one line — but only when a small area's
// next neighbour is also small. A small area with a large (or no) neighbour, and
// any 4+ trail area, stays its own stacked block.
function groupTrailAreas(areas: WhakapapaTrailArea[]): TrailAreaGroup[] {
  const groups: TrailAreaGroup[] = [];
  let index = 0;
  while (index < areas.length) {
    const current = areas[index];
    const next = areas[index + 1];
    const currentIsSmall = current.trails.length <= SMALL_TRAIL_AREA_MAX;
    const nextIsSmall = Boolean(
      next && next.trails.length <= SMALL_TRAIL_AREA_MAX,
    );

    if (currentIsSmall && nextIsSmall) {
      const run: WhakapapaTrailArea[] = [current];
      index += 1;
      while (
        index < areas.length &&
        areas[index].trails.length <= SMALL_TRAIL_AREA_MAX
      ) {
        run.push(areas[index]);
        index += 1;
      }
      groups.push({ kind: "row", areas: run });
    } else {
      groups.push({ kind: "block", area: current });
      index += 1;
    }
  }
  return groups;
}

function TrailsGroup({ areas }: { areas: WhakapapaTrailArea[] }) {
  return (
    <article
      id="whakapapa-trails"
      className="wcx-group mt-3 rounded-md border border-border bg-card p-2"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <h3 className="wcx-group-title text-sm font-semibold text-foreground">Trails</h3>
        <TrailsKey />
      </div>
      {areas.length > 0 ? (
        <div className="mt-2 space-y-3">
          {groupTrailAreas(areas).map((group, groupIndex) => {
            if (group.kind === "row") {
              // Consecutive small sub-areas share one wrapping line. Each area is
              // a column stack — its name on TOP of its own trail cards (matching
              // the full-block layout) — and the stacks sit side by side.
              return (
                <div
                  key={`trails-row-${group.areas
                    .map((area) => area.name || "unnamed")
                    .join("|")}-${groupIndex}`}
                  className="flex flex-wrap items-start gap-x-4 gap-y-2"
                >
                  {group.areas.map((area) => (
                    <div
                      key={area.name || `trails-area-${groupIndex}`}
                      aria-label={area.name || "trails-area"}
                      className="flex flex-col gap-1"
                    >
                      <TrailAreaName name={area.name} />
                      <div className="flex flex-wrap gap-2">
                        {area.trails.map((trail) => (
                          <TrailCard
                            key={`${area.name}-${trail.name}`}
                            trail={trail}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            }

            const area = group.area;
            return (
              <div
                key={area.name || `trails-area-${groupIndex}`}
                aria-label={area.name || "trails-area"}
              >
                <TrailAreaName name={area.name} />
                <div className="mt-1 flex flex-wrap gap-2">
                  {area.trails.map((trail) => (
                    <TrailCard
                      key={`${area.name}-${trail.name}`}
                      trail={trail}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          No trail data available.
        </p>
      )}
    </article>
  );
}

const EMPTY_DATA: WhakapapaCurlData = {
  updated: "",
  roadStatus: {
    name: "",
    status: "",
    wheelRequirements: "",
    roadContent: "",
  },
  facilities: [],
  foodAndDrink: [],
  lifts: [],
  conditions: [],
  trails: [],
  visibility: emptyWhakapapaSectionVisibility(),
};

export function SkifieldWhakapapaWidget() {
  const formatUpdatedStamp = useUpdatedStampFormatter();
  const [data, setData] = useState<WhakapapaCurlData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const response = await fetch("/api/skifield-whakapapa", {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json()) as ApiResponse;
        if (!active) {
          return;
        }

        setData({
          updated: payload.updated || "",
          roadStatus: {
            name: payload.roadStatus?.name || "",
            status: payload.roadStatus?.status || "",
            wheelRequirements: payload.roadStatus?.wheelRequirements || "",
            roadContent: payload.roadStatus?.roadContent || "",
          },
          facilities: payload.facilities ?? [],
          foodAndDrink: payload.foodAndDrink ?? [],
          lifts: payload.lifts ?? [],
          conditions: payload.conditions ?? [],
          trails: payload.trails ?? [],
          visibility: payload.visibility ?? emptyWhakapapaSectionVisibility(),
        });

        setError(payload.error || "");
        setStale(Boolean(payload.stale));
      } catch {
        if (!active) {
          return;
        }
        setError("Unable to load Whakapapa report data.");
        setStale(false);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        Loading Whakapapa report...
      </div>
    );
  }

  const formattedUpdated = data.updated
    ? formatUpdatedStamp(data.updated)
    : "Unknown";

  const roadStatusTone = /open/i.test(data.roadStatus.status)
    ? "bg-success-3 text-success-11"
    : data.roadStatus.status
      ? "bg-warning-3 text-warning-11"
      : "bg-muted text-muted-foreground";

  // At-a-glance summary (#weather redesign, Option A). Derived, not stored: the
  // headline facts a visitor scans for — is the road open, how many lifts, snow
  // base and last 24h — surfaced above the detail. `wcx-*` classes are stable
  // hooks the site-style Raw CSS skins; each stat is omitted when its data or
  // section is unavailable so the strip never shows a blank tile.
  const openLiftCount = data.lifts.filter(
    (lift) => lift.status.trim().toLowerCase() === "open",
  ).length;
  const topConditions = data.conditions[0];
  const summaryStats: Array<{
    key: string;
    label: string;
    value: string;
    sub?: string;
    tone?: "ok" | "accent";
  }> = [];
  if (data.visibility.roadStatus && data.roadStatus.status) {
    summaryStats.push({
      key: "road",
      label: data.roadStatus.name || "Road",
      value: data.roadStatus.status,
      tone: /open/i.test(data.roadStatus.status) ? "ok" : undefined,
    });
  }
  if (data.visibility.lifts && data.lifts.length > 0) {
    summaryStats.push({
      key: "lifts",
      label: "Lifts open",
      value: `${openLiftCount} / ${data.lifts.length}`,
    });
  }
  if (data.visibility.conditions && topConditions?.snowBase) {
    summaryStats.push({
      key: "base",
      label: "Snow base",
      value: topConditions.snowBase,
      sub: topConditions.name || undefined,
    });
  }
  if (data.visibility.conditions && topConditions?.snowfall24h) {
    summaryStats.push({
      key: "24h",
      label: "Last 24h",
      value: topConditions.snowfall24h,
      sub: "Fresh snow",
      tone: "accent",
    });
  }

  return (
    <section
      id="conditions"
      className="wcx-panel rounded-lg border border-border bg-card p-2 shadow-sm sm:p-4"
    >
      <div className="wcx-head mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="wcx-eyebrow text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Mt Ruapehu
          </p>
          <h2 className="wcx-title text-lg font-semibold text-foreground">
            Whakapapa Conditions
          </h2>
          <p className="wcx-updated text-xs text-muted-foreground">
            Updated: {formattedUpdated}
          </p>
        </div>
        <div className="wcx-head-meta flex items-center gap-2">
          {stale ? (
            <span className="inline-flex rounded-full bg-warning-3 px-2 py-1 text-xs font-medium text-warning-11">
              Showing cached data
            </span>
          ) : (
            <span className="wcx-live inline-flex items-center gap-1.5 text-xs font-medium text-success-11">
              <span
                className="wcx-live-dot inline-block h-2 w-2 rounded-full bg-success-11"
                aria-hidden="true"
              />
              Live
            </span>
          )}
        </div>
      </div>

      {summaryStats.length > 0 ? (
        <div className="wcx-summary mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {summaryStats.map((stat) => (
            <div
              key={stat.key}
              className="wcx-stat rounded-md border border-border bg-card p-2"
            >
              <span className="wcx-stat-label block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {stat.label}
              </span>
              <span
                className={`wcx-stat-value block text-base font-semibold ${
                  stat.tone === "ok"
                    ? "wcx-tone-ok text-success-11"
                    : stat.tone === "accent"
                      ? "wcx-tone-accent text-foreground"
                      : "text-foreground"
                }`}
              >
                {stat.value}
              </span>
              {stat.sub ? (
                <span className="wcx-stat-sub block text-[11px] text-muted-foreground">
                  {stat.sub}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="mb-3 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-xs text-warning-11">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          {data.visibility.roadStatus ? (
            <article
              id="whakapapa-road-status"
              className="wcx-group rounded-md border border-border bg-card p-2"
            >
              <h3 className="wcx-group-title text-sm font-semibold text-foreground">
                Road Status
              </h3>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="sm:flex-1">
                  <div className="text-xs text-muted-foreground">
                    <span>{data.roadStatus.name || "Unknown road"}&nbsp;</span>
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${roadStatusTone}`}
                    >
                      {data.roadStatus.status || "Status unavailable"}
                    </span>
                  </div>
                </div>
                {data.roadStatus.wheelRequirements ||
                data.roadStatus.roadContent ? (
                  <dl className="space-y-2 text-xs text-muted-foreground sm:flex-1">
                    {data.roadStatus.wheelRequirements ? (
                      <div>
                        <dt className="font-medium text-muted-foreground">
                          Wheel requirements
                        </dt>
                        <dd>{data.roadStatus.wheelRequirements}</dd>
                      </div>
                    ) : null}
                    {data.roadStatus.roadContent ? (
                      <div>
                        <dt className="font-medium text-muted-foreground">
                          Road content
                        </dt>
                        <dd>{data.roadStatus.roadContent}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
              </div>
            </article>
          ) : null}

          {data.visibility.foodAndDrink ? (
            <FacilityGroup
              id="whakapapa-food-and-drink"
              title="Food & Drink"
              items={data.foodAndDrink}
              emptyLabel="No food & drink data available."
            />
          ) : null}
        </div>

        {data.visibility.lifts ? (
          <FacilityGroup
            id="whakapapa-lifts"
            title="Lifts"
            items={data.lifts}
            emptyLabel="No lift data available."
          />
        ) : null}

        {data.visibility.facilities ? (
          <FacilityGroup
            id="whakapapa-facilities"
            title="Facilities"
            items={data.facilities}
            emptyLabel="No facility data available."
          />
        ) : null}

        {data.visibility.trails ? <TrailsGroup areas={data.trails} /> : null}
      </div>

      {data.visibility.conditions ? (
        <article
          id="whakapapa-mountain-conditions"
          className="wcx-group mt-3 rounded-md border border-border bg-card p-2"
        >
          <h3 className="wcx-group-title text-sm font-semibold text-foreground">
            Mountain Conditions
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="wcx-conditions-table min-w-full text-left text-xs text-muted-foreground">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Location</th>
                  <th className="pb-2 pr-4 font-medium">Temp</th>
                  <th className="pb-2 pr-4 font-medium">Wind</th>
                  <th className="pb-2 pr-4 font-medium">Snow Base</th>
                  <th className="pb-2 pr-4 font-medium">24h</th>
                  <th className="pb-2 font-medium">7d</th>
                </tr>
              </thead>
              <tbody>
                {data.conditions.length > 0 ? (
                  data.conditions.map((condition) => (
                    <tr key={condition.name} className="border-t border-border">
                      <td className="py-2 pr-4 font-medium text-foreground">
                        {condition.name || "Unknown"}
                      </td>
                      <td className="py-2 pr-4">
                        {condition.temperature || "-"}
                      </td>
                      <td className="py-2 pr-4">{condition.wind || "-"}</td>
                      <td className="py-2 pr-4">{condition.snowBase || "-"}</td>
                      <td className="py-2 pr-4">
                        {condition.snowfall24h || "-"}
                      </td>
                      <td className="py-2">{condition.snowfall7d || "-"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="py-2 text-muted-foreground" colSpan={6}>
                      No condition data available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      ) : null}
    </section>
  );
}
