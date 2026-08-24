"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CLUB_TIME_ZONE_MAX_LENGTH,
  listSelectableClubTimeZones,
} from "@/lib/club-time-zone";
import { formatNZDateTime } from "@/lib/nzst-date";

/**
 * The club-timezone maintenance panel (CT-1, #2989; epic #2988).
 *
 * WHY THIS SURFACE DOES NOT USE `ViewOnlyActionButton` /
 * `AdminViewOnlySectionBanner`, and please do not "fix" it to. Those are the
 * canonical furniture for a section with a VIEW tier and an EDIT tier: they
 * resolve `useAdminAreaEditAccess(area)` and explain that this admin can look but
 * not change, because their access role grants the area at `view`. This screen has
 * exactly one permission level — Full Admin, enforced in the route by
 * `requireAdmin({ permission: false })` — so there is no area-edit tier to
 * describe, and rendering that banner here would state a REASON that is not the
 * reason. `/admin/club-time`'s page shell therefore does what
 * `/admin/config-transfer` does: it tests `isFullAdmin` and shows a short
 * "available to full administrators only" panel instead of this one.
 *
 * IT STILL FOLLOWS THE STAGED-EDIT MODEL (`docs/ARCHITECTURE.md` -> "Admin/member
 * layer"). The panel mounts READ-ONLY showing the configured zone; changing it is
 * Edit -> choose -> acknowledge -> Save. Nothing persists on selection, and the
 * acknowledgement is not decoration — the API refuses an unconfirmed change, so a
 * caller that skips this panel gets the same refusal.
 *
 * THE BROWSER NEVER DECIDES THE TIMEZONE. The configured zone always arrives from
 * the server (`GET /api/admin/club-time-zone`). `Intl.DateTimeFormat()
 * .resolvedOptions().timeZone` — the viewer's own clock — is never read here, for
 * anything, not even as a default before the fetch settles: a member in London and
 * a member in Ohakune have to see the same club time. The 418-entry OPTION LIST
 * does come from this runtime (`listSelectableClubTimeZones`), which is a list of
 * choices rather than a decision, and every choice is re-validated server-side.
 *
 * WHAT THIS SCREEN MAY CLAIM, which is narrower than it reads (#2989 review).
 * CT-1 RECORDS the zone and nothing more: no production code path reads
 * `getClubTimeZone()` yet, so every displayed time and every club-local schedule
 * still follows the deployment's `TZ`. So the copy below says the setting is
 * recorded here and asks the operator to keep the two in step. It must not tell
 * them that saving changes what members see, because today it does not — and if
 * you are the change that makes it true, this copy is part of your diff.
 */

type ClubTimeZoneSource =
  | "persisted"
  | "persisted-unusable"
  | "environment"
  | "default";

type ClubTimeZoneState = {
  timeZone: string;
  source: ClubTimeZoneSource;
  updatedAt: string | null;
  updatedByName: string | null;
  /** Non-null only for `persisted-unusable`; see `describeSource`. */
  unusableStoredValue: string | null;
};

/**
 * The provenance words the operator guide uses, and the sentence behind each.
 * `docs/guides/club-time.md` names them verbatim, so they are the labels rather
 * than a paraphrase — a screen and a guide that describe the same state in
 * different words is how an operator stops trusting the guide.
 */
const SOURCE_LABEL: Record<ClubTimeZoneSource, string> = {
  persisted: "Configured",
  "persisted-unusable": "Not usable",
  environment: "From the environment",
  default: "Default",
};

const SOURCE_EXPLANATION: Record<
  Exclude<ClubTimeZoneSource, "persisted-unusable">,
  string
> = {
  persisted: "Recorded in this installation's settings — the club has chosen it.",
  environment:
    "Nothing has been recorded yet, so this is the zone the server was started " +
    "with. Restarting the app records it; so does saving below.",
  default:
    "Nothing has been recorded and the server says nothing either, so this is " +
    "the shipped default. Saving below records the club's own choice.",
};

/**
 * A stored value that failed validation, made safe to print. It never came
 * through the validated write path — only a hand-edit, a bad restore or an ICU
 * that dropped the zone gets a value here — so control characters are replaced
 * and the text is capped. Same reasoning and same treatment as the setup
 * checklist's `describeInvalidStoredTimeZone`.
 */
function printableStoredValue(value: string | null): string {
  if (!value) return "(empty)";
  const printable = value.replace(/[^\x20-\x7E]/g, "?");
  return printable.length > CLUB_TIME_ZONE_MAX_LENGTH
    ? `${printable.slice(0, CLUB_TIME_ZONE_MAX_LENGTH)}…`
    : printable;
}

/**
 * The provenance sentence shown under the zone.
 *
 * `persisted-unusable` is built rather than looked up, for two reasons. It has
 * to NAME the stored value, because "the stored time zone is not usable" is
 * unactionable without saying which one. And its instruction is different in
 * kind: this state used to be reported as "from the environment", which told the
 * reader that restarting the app would record it — and restarting never does,
 * because the boot backfill's presence check is row-level, so the bad row counts
 * as present and the backfill is skipped for good. Saving here IS the repair, so
 * that is what it says. Worded to match the setup checklist's equivalent step,
 * which an operator may well be reading in the same sitting.
 */
function describeSource(state: ClubTimeZoneState): string {
  if (state.source === "persisted-unusable") {
    return (
      `Something is recorded that this app cannot use — ` +
      `"${printableStoredValue(state.unusableStoredValue)}" — so it is falling ` +
      `back to ${state.timeZone}. Restarting will not repair it. Set the club's ` +
      `time zone again below.`
    );
  }
  return SOURCE_EXPLANATION[state.source];
}

/**
 * "Last changed", in the same zone as every other admin timestamp.
 *
 * Deliberately NOT the club's configured zone, even though the configured zone
 * is what this screen is about. `/admin/audit-log` renders the very same class of
 * timestamp — the audit row this save writes — through `APP_TIME_ZONE`, and one
 * screen quietly spelling an instant in a different zone from the screen beside
 * it, with nothing on either saying which, is worse than both sitting on the
 * transitional constant. CT-4 moves every admin timestamp onto the configured
 * zone in one change, and this line moves with them. `formatNZDateTime` pins
 * locale and zone together, which is what INV-DATE-015 and the ESLint date guard
 * require of any formatter here.
 */
function formatChangedAt(iso: string): string {
  const changedAt = new Date(iso);
  return Number.isNaN(changedAt.getTime()) ? iso : formatNZDateTime(changedAt);
}

/** Match on the identifier with underscores read as spaces: "new york" finds America/New_York. */
function matchesFilter(zone: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return zone.toLowerCase().replace(/_/g, " ").includes(needle.replace(/_/g, " "));
}

export function ClubTimeZonePanel() {
  const [state, setState] = useState<ClubTimeZoneState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterId = useId();
  const selectId = useId();
  const acknowledgeId = useId();

  // Built once, from this runtime's zone database. Offering the list is not
  // deciding the zone; see the module doc.
  const allZones = useMemo(() => listSelectableClubTimeZones(), []);

  function load() {
    setLoadFailed(false);
    void fetch("/api/admin/club-time-zone")
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        const payload = (await response.json()) as { state: ClubTimeZoneState };
        setState(payload.state);
      })
      .catch(() => setLoadFailed(true));
  }

  useEffect(() => {
    load();
  }, []);

  if (loadFailed) {
    return (
      <div className="space-y-3 rounded-md border bg-card p-6">
        <p className="text-sm text-danger">
          Could not load the club time zone.
        </p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  if (!state) {
    return (
      <p className="text-sm text-muted-foreground">Loading club time zone…</p>
    );
  }

  const chosen = choice ?? state.timeZone;
  /*
    RECORDING THE ZONE THE CLUB IS ALREADY EFFECTIVELY ON IS A REAL SAVE, and it
    is the state a fresh install, an upgraded one, and one whose stored value
    cannot be used all arrive in. Until a USABLE row exists the answer is coming
    from `TZ` or from the shipped default, and the whole point of CT-1 is that
    the club's own choice is recorded rather than inferred — so "Save" stays
    available even when the chosen zone equals the one displayed. The server
    agrees: with nothing usable persisted there is no before-value that can
    match, so the write happens and the audit row records whatever was there
    (`null`, or the unusable text). Once a usable row exists, re-picking the same
    zone is the pristine re-save the dirty gate is there to refuse.
  */
  const noUsableZoneRecorded = state.source !== "persisted";
  const unchanged = chosen === state.timeZone && !noUsableZoneRecorded;
  /*
    The chosen zone is ALWAYS offered, even when the filter excludes it and even
    when this runtime's `supportedValuesOf` does not list it — ICU disagrees with
    itself across versions about which spelling is canonical (`Asia/Calcutta` vs
    `Asia/Kolkata`), so a perfectly good stored zone can be absent from the list.
    Without this the `<select>` would have no option matching its own value and
    would silently display a zone the club is not on.
  */
  const filteredZones = allZones.filter((zone) => matchesFilter(zone, filter));
  const visibleZones = filteredZones.includes(chosen)
    ? filteredZones
    : [chosen, ...filteredZones];

  function startEditing() {
    setChoice(state?.timeZone ?? null);
    setFilter("");
    setAcknowledged(false);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setChoice(null);
    setFilter("");
    setAcknowledged(false);
    setError(null);
  }

  async function save() {
    if (!acknowledged || unchanged) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/club-time-zone", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeZone: chosen, confirmed: true }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { state?: ClubTimeZoneState; error?: string }
        | null;
      if (!response.ok || !payload?.state) {
        setError(payload?.error ?? "Could not save the club time zone.");
        return;
      }
      setState(payload.state);
      cancelEditing();
    } catch {
      setError("Could not save the club time zone.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 rounded-md border bg-card p-6">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">Club time zone</p>
        <p className="text-lg font-semibold" data-testid="current-club-time-zone">
          {state.timeZone}
        </p>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium">{SOURCE_LABEL[state.source]}</span>
          {` — ${describeSource(state)}`}
        </p>
        {state.updatedAt ? (
          <p className="text-sm text-muted-foreground">
            {`Last changed ${formatChangedAt(state.updatedAt)}`}
            {state.updatedByName ? ` by ${state.updatedByName}` : null}
          </p>
        ) : null}
      </div>

      {!editing ? (
        <Button onClick={startEditing}>Change time zone</Button>
      ) : (
        <div className="space-y-4 border-t pt-4">
          <div className="space-y-2">
            <Label htmlFor={filterId}>Find a time zone</Label>
            <Input
              id={filterId}
              value={filter}
              placeholder="Type a city or region, for example Auckland"
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={selectId}>Time zone</Label>
            <select
              id={selectId}
              value={chosen}
              onChange={(event) => setChoice(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            >
              {visibleZones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {visibleZones.length} of {allZones.length} time zones shown.
            </p>
          </div>

          <div className="space-y-3 rounded-md border border-warning-6 bg-warning-2 p-4">
            <p className="text-sm font-semibold">
              What changing the club time zone does
            </p>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Now</dt>
                <dd className="font-medium" data-testid="confirm-current-zone">
                  {state.timeZone}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">After saving</dt>
                <dd className="font-medium" data-testid="confirm-chosen-zone">
                  {chosen}
                </dd>
              </div>
            </dl>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>
                Dates and times already recorded are not rewritten or moved.
                Nothing in the database changes except this setting.
              </li>
              <li>
                What this changes today is the setting itself. The times the site
                shows, and when club-local scheduled jobs — reminders, nightly
                work, cut-offs — fire, still follow the TZ setting this
                deployment starts with, and move onto this one as the rest of the
                club-time work lands. So keep the two the same.
              </li>
              <li>
                Lodge nights keep the calendar dates they already have. A booking
                for the 14th is still a booking for the 14th.
              </li>
            </ul>
            <div className="flex items-start gap-2">
              <Checkbox
                id={acknowledgeId}
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked)}
              />
              <Label htmlFor={acknowledgeId} className="text-sm font-normal">
                I understand that this records the club&apos;s time zone, that
                displayed times and club-local scheduled jobs keep following the
                deployment&apos;s TZ setting until the rest of the club-time work
                lands, and that saving does not move any date or time already
                recorded.
              </Label>
            </div>
          </div>

          {unchanged ? (
            <p className="text-sm text-muted-foreground">
              {chosen} is already the club time zone. Choose a different one to
              save a change.
            </p>
          ) : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}

          <div className="flex gap-2">
            <Button
              onClick={() => void save()}
              disabled={!acknowledged || unchanged || saving}
            >
              {saving ? "Saving…" : "Save time zone"}
            </Button>
            <Button variant="outline" onClick={cancelEditing} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
