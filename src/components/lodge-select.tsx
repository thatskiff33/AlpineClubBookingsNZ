"use client";

import { useCallback, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface LodgeOption {
  id: string;
  name: string;
  travelNote?: string | null;
}

/**
 * The value of a DELIBERATE club-wide selection (#2701), for the callers that
 * opt into it with `allowAllLodges`.
 *
 * It is a sentinel string rather than `null` because `null` was already
 * carrying three unrelated meanings on the bed-allocation board — "I chose to
 * see everything", "the selector has not resolved yet" and "the lodge list
 * failed to load" — and the four bed pickers behaved identically in all three.
 * A sentinel makes the deliberate case its own value, so `null` is left meaning
 * only "not resolved". Not a possible cuid, so it can never collide with a real
 * lodge id, and callers must never send it to an API as a `lodgeId`.
 */
export const ALL_LODGES = "__all_lodges__";

/**
 * Who asked for the change. `"user"` is the admin operating the selector;
 * `"auto"` is this component's own normalising effect (the sole-lodge rule and
 * the first-lodge default). Callers that treat a lodge change as "the admin
 * browsed away from something" must act on `"user"` alone — inferring it from
 * the values, as the bed-allocation board used to, cannot tell a default apart
 * from a choice that happens to pick the same lodge.
 */
export type LodgeChangeSource = "user" | "auto";

// Shared lodge selector honouring the single-lodge presentation rule
// (docs/multi-lodge/decisions/ADR-002): when fewer than two lodges are
// offered it renders nothing and reports the sole lodge (or null) through
// onChange, so surrounding flows behave exactly as a single-lodge club.
export function LodgeSelect({
  lodges,
  value,
  onChange,
  label = "Lodge",
  id = "lodge-select",
  loading = false,
  allowAllLodges = false,
  deferDefaultSelection = false,
}: {
  lodges: LodgeOption[];
  value: string | null;
  onChange: (lodgeId: string | null, source: LodgeChangeSource) => void;
  label?: string;
  id?: string;
  // True while the lodge options are still being fetched. The sole-lodge /
  // default-selection normalisation must not run against an empty
  // still-loading list, or it clobbers a caller-provided initial selection
  // (e.g. a ?lodgeId= hub link, ADR-003) before the options arrive.
  loading?: boolean;
  /**
   * Offer `ALL_LODGES` as an explicit option (#2701). Off by default: a page
   * that cannot render a club-wide view must not be able to reach one, and
   * with it off an `ALL_LODGES` value arriving from a URL is normalised away
   * like any other unusable selection.
   */
  allowAllLodges?: boolean;
  /**
   * Hold the first-lodge default off while the CALLER is still resolving an
   * authoritative selection of its own — a deep-linked booking whose lodge
   * only the server knows (#2701). Without it the selector would default to
   * `lodges[0]` in the meantime, which is precisely how a lodge-B booking used
   * to land on lodge A's board.
   */
  deferDefaultSelection?: boolean;
}) {
  useEffect(() => {
    if (loading || deferDefaultSelection) return;
    if (lodges.length < 2) {
      // ADR-002: fewer than two lodges is a single-lodge club, where there is
      // no club-wide view to choose — so even an explicit ALL_LODGES
      // normalises to the sole lodge (or to null when the list is empty).
      const sole = lodges[0]?.id ?? null;
      if (value !== sole) onChange(sole, "auto");
      return;
    }
    // A deliberate club-wide selection is a settled value, never normalised
    // away — that is the entire point of making it explicit.
    if (allowAllLodges && value === ALL_LODGES) return;
    if (
      value === null ||
      value === ALL_LODGES ||
      !lodges.some((lodge) => lodge.id === value)
    ) {
      onChange(lodges[0].id, "auto");
    }
  }, [lodges, value, onChange, loading, allowAllLodges, deferDefaultSelection]);

  if (lodges.length < 2) {
    return null;
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? undefined}
        onValueChange={(next) => onChange(next, "user")}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a lodge" />
        </SelectTrigger>
        <SelectContent>
          {allowAllLodges ? (
            <SelectItem value={ALL_LODGES}>All lodges</SelectItem>
          ) : null}
          {lodges.map((lodge) => (
            <SelectItem key={lodge.id} value={lodge.id}>
              {lodge.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Initial lodge context from a `?lodgeId=` URL parameter (ADR-003 hub
 * links), for a page's `useState` initialiser. Read synchronously on the
 * client so the page's very first data fetch is already lodge-filtered —
 * applying it in an effect creates an unfiltered-then-filtered request pair
 * whose responses can land out of order and show the wrong lodge's data.
 * During SSR there is no window and the value starts null, which is safe:
 * nothing lodge-dependent renders before the options load.
 */
export function initialLodgeIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("lodgeId");
}

/**
 * Fetch active lodges for the current user. `scope: "member"` returns only
 * lodges the member may book; `scope: "admin"` returns every lodge (admin
 * pages pass their own endpoint data instead where they already load it).
 *
 * `failed` and `reload` exist so a caller can tell a FAILED list apart from an
 * empty one (#2701). Before this the two were indistinguishable — a refused or
 * unreachable `/api/admin/lodges` produced `lodges: []` exactly like a club
 * with no active lodges, and on the bed-allocation board that silently became
 * an unscoped club-wide read nobody chose. Existing callers that destructure
 * only `lodges`/`loading` are unaffected: on failure they still see the empty
 * list they saw before.
 *
 * `forbidden` is kept SEPARATE from `failed`, because a refusal is a
 * permissions fact with a retry that can only refuse again, where a failure is
 * an outage worth retrying (PR #2885 review, HIGH 2). A caller can offer a
 * refused role the club-wide read-only view instead of a dead error.
 *
 * WHO can still be refused changed in #2925, and narrowed again in #2984.
 * `/api/admin/lodges` no longer needs `lodge:view`: it admits any admitted admin
 * (`permission: "any-admin"`) and narrows its payload instead, so the shipped
 * presets this state was written for — `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN`,
 * which hold `bookings: "view"` and no `lodge` entry — now get a 200 carrying
 * the lodge names. #2984 then made portal standing any ONE of the seven areas,
 * so a club-edited or custom role holding `bookings: "view"` with
 * `overview: "none"` is admitted too — that used to be the named example of a
 * caller this state still had to serve, and it is not one any more.
 *
 * `forbidden` is still NOT dead code, for reasons that no longer depend on any
 * particular grid: an ADMIN-scope caller whose roles were revoked mid-session
 * gets a 403 on the next poll, and the MEMBER scope of this hook reads
 * `/api/lodges`, which has its own gate. A refusal is a permissions fact and a
 * failure is an outage; collapsing them would offer a retry that can only
 * refuse again. So the state stays, and so does every caller's handling of it.
 */
export function useLodgeOptions(scope: "member" | "admin" = "member") {
  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const url = scope === "admin" ? "/api/admin/lodges" : "/api/lodges";
    setLoading(true);
    setFailed(false);
    setForbidden(false);
    fetch(url)
      .then(async (response) => {
        // A refusal is not an empty club. Previously this returned
        // `{ lodges: [] }` and the caller could not tell the difference.
        if (response.status === 403) {
          if (!cancelled) {
            setLodges([]);
            setForbidden(true);
          }
          return null;
        }
        if (!response.ok) throw new Error(`lodge options ${response.status}`);
        return (await response.json()) as {
          lodges?: Array<LodgeOption & { active?: boolean }>;
        };
      })
      .then((data) => {
        if (cancelled || data === null) return;
        const rows = (data.lodges ?? []).filter(
          (lodge) => !("active" in lodge) || lodge.active !== false,
        );
        setLodges(rows.map(({ id, name, travelNote }) => ({ id, name, travelNote })));
      })
      .catch(() => {
        if (cancelled) return;
        setLodges([]);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  return { lodges, loading, failed, forbidden, reload };
}
