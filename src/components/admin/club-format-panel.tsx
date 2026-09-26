"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClubTime } from "@/components/club-time-provider";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  ADMIN_FULL_ADMIN_ONLY_ACTION_REASON,
  useFullAdminEditAccess,
} from "@/hooks/use-admin-area-edit-access";
import {
  CLUB_LOCALE_EXAMPLES,
  CLUB_LOCALE_MAX_LENGTH,
  listSelectableClubCurrencyCodes,
} from "@/lib/club-format";
import {
  CLUB_FORMAT_AI_RATE_CLEARED,
  CLUB_FORMAT_NOTHING_REWRITTEN,
  CLUB_FORMAT_REACH,
  CLUB_FORMAT_SERVER_SETTINGS,
} from "@/lib/club-format-copy";
import {
  ClubFormatCurrencyChange,
  type ClubFormatInFlightCardPayments,
} from "@/components/admin/club-format-currency-change";

/**
 * The club currency and locale maintenance panel (stage 1 of programme #3205,
 * #3563). INV-CONFIG-006.
 *
 * EVERY ADMIN SEES IT; ONLY A FULL ADMIN CAN CHANGE IT (owner decision on
 * #3596). So this surface now carries the canonical view-only furniture
 * (`docs/ARCHITECTURE.md` -> "Admin/member layer"): one
 * `AdminViewOnlySectionBanner` at the top, and every edit affordance through
 * `ViewOnlyActionButton` with `describeReason={false}`. Stage 1 (#3563)
 * refused both, on the ground that the screen had "no view tier" — every
 * visitor was a Full Admin, so a banner explaining view-only access would have
 * stated a reason that was not the reason. #3596 gave it a view tier, which
 * reverses that ground rather than overriding it.
 *
 * THE EDIT TIER IS FULL ADMIN, NOT AN AREA LEVEL, which is why `canEdit` comes
 * from `useFullAdminEditAccess` and not from `useAdminAreaEditAccess`. The
 * route's write is `requireAdmin({ permission: false })`: an admin holding
 * every area at `edit` is still refused, so an area check here would offer
 * them a Save the server turns down. The banner therefore names Full Admin in
 * its own words, the way the video-meetings and Alpine Server setup screens
 * do for their Full-Admin-only writes. The server is still the enforcement:
 * this only decides what the screen offers.
 *
 * IT STILL FOLLOWS THE STAGED-EDIT MODEL (`docs/ARCHITECTURE.md` ->
 * "Admin/member layer"). The panel mounts READ-ONLY showing the configured
 * values; changing them is Edit -> choose -> acknowledge -> Save. Nothing
 * persists on selection, and the acknowledgement is not decoration — the API
 * refuses an unconfirmed change, so a caller that skips this panel gets the
 * same refusal.
 *
 * THE BROWSER NEVER DECIDES EITHER VALUE. Both always arrive from the server
 * (`GET /api/admin/club-format`). `navigator.language` — the viewer's own
 * locale — is never read here, for anything, not even as a default before the
 * fetch settles: a member in London and a member in Ohakune have to see the
 * same club. The currency OPTION LIST does come from this runtime
 * (`listSelectableClubCurrencyCodes`), which is a list of choices rather than a
 * decision, and every choice is re-validated server-side.
 *
 * THE LOCALE IS A TEXT FIELD AND THE CURRENCY IS A SELECT, and the asymmetry is
 * the platform's rather than a design choice: `Intl.supportedValuesOf` has a
 * `"currency"` key and no `"locale"` one, and ECMA-402 exposes no way to
 * enumerate the tags a runtime knows. So the locale takes a validated tag with
 * worked examples beside it. `CLUB_LOCALE_EXAMPLES` is a list of examples for
 * this form and never a supported-locale list: a club whose tag is not among
 * them types it and it is accepted.
 *
 * WHAT THIS SCREEN MAY CLAIM. Since #3565 (money) and #3566 (dates, emails,
 * AI spend, sorting) the setting reaches everything the site writes except a
 * few English labels the guide lists, and since #3567 card payments are charged
 * in it too — so a CURRENCY change carries a second, counted confirmation
 * (`ClubFormatCurrencyChange`). The consequences list renders that from
 * `@/lib/club-format-copy`, the one home the page blurb and the contextual help
 * share, so the next stage that moves a caveat moves it once.
 */

type ClubFormatFieldSource =
  | "persisted"
  | "persisted-unusable"
  | "environment"
  | "default";

type ClubFormatState = {
  currencyCode: string;
  locale: string;
  currencySource: ClubFormatFieldSource;
  localeSource: ClubFormatFieldSource;
  updatedAt: string | null;
  updatedByName: string | null;
  /** Non-null only for `persisted-unusable`; see `describeSource`. */
  unusableStoredCurrency: string | null;
  unusableStoredLocale: string | null;
};

/**
 * The provenance words the operator guide uses, and the sentence behind each.
 * `docs/guides/club-format.md` names them verbatim, so they are the labels
 * rather than a paraphrase — a screen and a guide that describe the same state
 * in different words is how an operator stops trusting the guide.
 */
const SOURCE_LABEL: Record<ClubFormatFieldSource, string> = {
  persisted: "Configured",
  "persisted-unusable": "Not usable",
  environment: "From the server settings",
  default: "Default",
};

const SOURCE_EXPLANATION: Record<
  Exclude<ClubFormatFieldSource, "persisted-unusable">,
  string
> = {
  persisted: "Recorded in this installation's settings — the club has chosen it.",
  environment:
    "Nothing has been recorded yet, so this is what the server was started " +
    "with. Restarting the app records it; so does saving below.",
  default:
    "Nothing has been recorded and the server says nothing either, so this is " +
    "the shipped default. Saving below records the club's own choice.",
};

/**
 * A stored value that failed validation, made safe to print. It never came
 * through the validated write path — only a hand-edit, a bad restore or a
 * runtime that stopped accepting the value gets one here — so control
 * characters are replaced and the text is capped.
 */
function printableStoredValue(value: string | null): string {
  if (!value) return "(empty)";
  const printable = value.replace(/[^\x20-\x7E]/g, "?");
  return printable.length > CLUB_LOCALE_MAX_LENGTH
    ? `${printable.slice(0, CLUB_LOCALE_MAX_LENGTH)}…`
    : printable;
}

/**
 * The provenance sentence shown under one value.
 *
 * `persisted-unusable` is built rather than looked up, for two reasons. It has
 * to NAME the stored value, because "the stored currency is not usable" is
 * unactionable without saying which one. And its instruction is different in
 * kind: restarting never repairs it, because the boot backfill's presence check
 * is row-level, so the bad row counts as present and the backfill is skipped
 * for good. Saving here IS the repair, so that is what it says.
 */
function describeSource(
  source: ClubFormatFieldSource,
  inForce: string,
  unusableStored: string | null,
  noun: string,
): string {
  if (source === "persisted-unusable") {
    return (
      `Something is recorded that this app cannot use — ` +
      `"${printableStoredValue(unusableStored)}" — so it is falling back to ` +
      `${inForce}. Restarting will not repair it. Set the club's ${noun} again ` +
      `below.` +
      // #3567: an unusable stored CURRENCY also switches card payments off.
      (noun === "currency" ? " Until then no card payment can be taken." : "")
    );
  }
  return SOURCE_EXPLANATION[source];
}

/**
 * "Last changed", in the club's own zone like every other admin timestamp
 * (CT-4, #2870; INV-CONFIG-002). Read from the provider rather than from this
 * panel's own fetch so this screen agrees with the audit log beside it.
 */
function useChangedAtFormatter() {
  const clubTime = useClubTime();
  return (iso: string): string => {
    const changedAt = new Date(iso);
    return Number.isNaN(changedAt.getTime())
      ? iso
      : clubTime.instantDateTime(changedAt);
  };
}

function matchesFilter(code: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return code.toLowerCase().includes(needle);
}

export function ClubFormatPanel() {
  const formatChangedAt = useChangedAtFormatter();
  const [state, setState] = useState<ClubFormatState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [currencyChoice, setCurrencyChoice] = useState<string | null>(null);
  const [localeChoice, setLocaleChoice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [currencyAcknowledged, setCurrencyAcknowledged] = useState(false);
  const [inFlight, setInFlight] = useState<ClubFormatInFlightCardPayments>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbiddenSave, setForbiddenSave] = useState(false);

  const filterId = useId();
  const currencyId = useId();
  const localeId = useId();
  const acknowledgeId = useId();

  // Built once, from this runtime's currency database. Offering the list is not
  // deciding the currency; see the module doc.
  const allCurrencies = useMemo(() => listSelectableClubCurrencyCodes(), []);

  /*
    Tri-state: `undefined` while the session resolves, which keeps the buttons
    below disabled and the banner empty rather than flashing either answer.
  */
  const canEdit = useFullAdminEditAccess();

  /*
    Hoisted above the early returns and rendered FIRST in every branch, so the
    banner's `role="status"` region is registered from the first paint rather
    than from whenever the fetch settles — a polite live region injected
    already populated is dropped by some screen-reader/browser pairings. Every
    branch returns a plain `<div>` with this as its first child, so React keeps
    the same region mounted across loading -> loaded.

    The `<div>` also keeps the wrapper OUT of the page's `space-y-6` stack.
    `space-y-6` gives every child after the first a `margin-top`; returned in a
    fragment, the banner's always-present wrapper and the card would BOTH be
    stack children, so a Full Admin — for whom the wrapper is empty and zero
    height — would get two stack margins between the heading and the card
    instead of one. Inside this `<div>` the panel is one stack child, and the
    only spacing between banner and card is the `mb-4` below, which
    `AdminViewOnlySectionBanner` puts on its inner box — the box that exists
    only when `canEdit === false`.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Every admin can see the club&apos;s currency and locale, but changing
      them needs Full Admin — they decide how every amount and date the club
      writes is shown. Ask a Full Admin if one of them looks wrong.
    </AdminViewOnlySectionBanner>
  );

  function load() {
    setLoadFailed(false);
    void fetch("/api/admin/club-format")
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        const payload = (await response.json()) as {
          state: ClubFormatState;
          inFlight?: ClubFormatInFlightCardPayments;
        };
        setState(payload.state);
        setInFlight(payload.inFlight ?? null);
      })
      .catch(() => setLoadFailed(true));
  }

  useEffect(() => {
    load();
  }, []);

  if (loadFailed) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-3 rounded-md border bg-card p-6">
          <p className="text-sm text-danger">
            Could not load the club&apos;s currency and locale.
          </p>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">
          Loading the club&apos;s currency and locale…
        </p>
      </div>
    );
  }

  const chosenCurrency = currencyChoice ?? state.currencyCode;
  const chosenLocale = localeChoice ?? state.locale;
  /*
    RECORDING THE VALUES THE CLUB IS ALREADY EFFECTIVELY ON IS A REAL SAVE, and
    it is the state a fresh install, an upgraded one, and one whose stored
    values cannot be used all arrive in. Until a USABLE row exists the answer is
    coming from the server settings or from the shipped defaults, and the point
    of this stage is that the club's own choice is recorded rather than
    inferred — so Save stays available even when the chosen pair equals the one
    displayed. The server agrees: with nothing usable persisted there is no
    before-value that can match, so the write happens and the audit row records
    whatever was there. Once a usable row exists, re-picking the same pair is
    the pristine re-save the dirty gate is there to refuse.
  */
  const nothingUsableRecorded =
    state.currencySource !== "persisted" || state.localeSource !== "persisted";
  const unchanged =
    chosenCurrency === state.currencyCode &&
    chosenLocale === state.locale &&
    !nothingUsableRecorded;
  // Card charges follow the currency (#3567), so changing it needs its own tick.
  const currencyChanges = chosenCurrency !== state.currencyCode;
  const readyToSave = acknowledged && (!currencyChanges || currencyAcknowledged);
  /*
    The chosen code is ALWAYS offered, even when the filter excludes it and even
    when this runtime's `supportedValuesOf` does not list it — ICU's currency
    list is whatever that build knows, so a perfectly good stored code can be
    absent. Without this the `<select>` would have no option matching its own
    value and would silently display a currency the club is not on.
  */
  const filteredCurrencies = allCurrencies.filter((code) =>
    matchesFilter(code, filter),
  );
  const visibleCurrencies = filteredCurrencies.includes(chosenCurrency)
    ? filteredCurrencies
    : [chosenCurrency, ...filteredCurrencies];

  function startEditing() {
    setCurrencyChoice(state?.currencyCode ?? null);
    setLocaleChoice(state?.locale ?? null);
    setFilter("");
    setAcknowledged(false);
    setCurrencyAcknowledged(false);
    setError(null);
    setForbiddenSave(false);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setCurrencyChoice(null);
    setLocaleChoice(null);
    setFilter("");
    setAcknowledged(false);
    setCurrencyAcknowledged(false);
    setError(null);
    setForbiddenSave(false);
  }

  async function save() {
    if (canEdit !== true || !readyToSave || unchanged) return;
    setSaving(true);
    setError(null);
    setForbiddenSave(false);
    try {
      const response = await fetch("/api/admin/club-format", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currencyCode: chosenCurrency,
          locale: chosenLocale,
          confirmed: true,
          currencyChangeConfirmed: currencyChanges && currencyAcknowledged,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { state?: ClubFormatState; error?: string }
        | null;
      if (response.status === 403) {
        /*
          The defence-in-depth case behind the gating above: a tab opened while
          this admin was a Full Admin, whose Full Admin was removed since. The
          route's own "Forbidden" says nothing useful, so the shared notice
          below carries the Full-Admin reason rather than its area-level default.
        */
        setForbiddenSave(true);
        return;
      }
      if (!response.ok || !payload?.state) {
        setError(
          payload?.error ?? "Could not save the club's currency and locale.",
        );
        return;
      }
      setState(payload.state);
      cancelEditing();
    } catch {
      setError("Could not save the club's currency and locale.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6 rounded-md border bg-card p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Currency</p>
            <p
              className="text-lg font-semibold"
              data-testid="current-club-currency"
            >
              {state.currencyCode}
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium">
                {SOURCE_LABEL[state.currencySource]}
              </span>
              {` — ${describeSource(
                state.currencySource,
                state.currencyCode,
                state.unusableStoredCurrency,
                "currency",
              )}`}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              Number and date format
            </p>
            <p className="text-lg font-semibold" data-testid="current-club-locale">
              {state.locale}
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium">
                {SOURCE_LABEL[state.localeSource]}
              </span>
              {` — ${describeSource(
                state.localeSource,
                state.locale,
                state.unusableStoredLocale,
                "number and date format",
              )}`}
            </p>
          </div>
        </div>

        {state.updatedAt ? (
          <p className="text-sm text-muted-foreground">
            {`Last changed ${formatChangedAt(state.updatedAt)}`}
            {state.updatedByName ? ` by ${state.updatedByName}` : null}
          </p>
        ) : null}

        {!editing ? (
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
            onClick={startEditing}
          >
            Change currency and format
          </ViewOnlyActionButton>
        ) : (
          <div className="space-y-4 border-t pt-4">
            <div className="space-y-2">
              <Label htmlFor={filterId}>Find a currency</Label>
              <Input
                id={filterId}
                value={filter}
                placeholder="Type a code, for example NZD"
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={currencyId}>Currency</Label>
              <select
                id={currencyId}
                value={chosenCurrency}
                onChange={(event) => setCurrencyChoice(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                {visibleCurrencies.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {visibleCurrencies.length} of {allCurrencies.length} currencies
                shown.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor={localeId}>Number and date format</Label>
              <Input
                id={localeId}
                value={chosenLocale}
                maxLength={CLUB_LOCALE_MAX_LENGTH}
                placeholder="en-NZ"
                onChange={(event) => setLocaleChoice(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                A language tag: the language, then the country, separated by a
                hyphen. For example {CLUB_LOCALE_EXAMPLES.slice(0, 5).join(", ")}.
                It decides how numbers and dates are written, not what language
                the site is in.
              </p>
            </div>

            <div className="space-y-3 rounded-md border border-warning-6 bg-warning-2 p-4">
              <p className="text-sm font-semibold">
                What changing these does, and what it does not
              </p>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Now</dt>
                  <dd className="font-medium" data-testid="confirm-current-format">
                    {state.currencyCode} · {state.locale}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">After saving</dt>
                  <dd className="font-medium" data-testid="confirm-chosen-format">
                    {chosenCurrency} · {chosenLocale}
                  </dd>
                </div>
              </dl>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                <li>{CLUB_FORMAT_REACH}</li>
                <li>{CLUB_FORMAT_AI_RATE_CLEARED}</li>
                <li>{CLUB_FORMAT_NOTHING_REWRITTEN}</li>
                <li>{CLUB_FORMAT_SERVER_SETTINGS}</li>
              </ul>
              <div className="flex items-start gap-2">
                <Checkbox
                  id={acknowledgeId}
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked)}
                />
                <Label htmlFor={acknowledgeId} className="text-sm font-normal">
                  I understand that this records the club&apos;s currency and
                  number format, that no amount already recorded is changed or
                  re-converted, and that the server settings stop deciding
                  either once this is saved.
                </Label>
              </div>
            </div>

            {currencyChanges ? (
              <ClubFormatCurrencyChange
                fromCurrency={state.currencyCode}
                toCurrency={chosenCurrency}
                inFlight={inFlight}
                acknowledged={currencyAcknowledged}
                onAcknowledgedChange={setCurrencyAcknowledged}
              />
            ) : null}

            {unchanged ? (
              <p className="text-sm text-muted-foreground">
                {chosenCurrency} and {chosenLocale} are already recorded. Choose
                something different to save a change.
              </p>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {forbiddenSave ? (
              /*
                The default copy names the wrong permission for this section
                ("can view this area but cannot make changes"): the write is
                Full Admin, not an area level, so the notice states that
                instead — the same reason the two buttons carry.
              */
              <AdminForbiddenSaveNotice>
                {`Nothing was saved. ${ADMIN_FULL_ADMIN_ONLY_ACTION_REASON} ` +
                  "Refresh the page to see the latest permissions."}
              </AdminForbiddenSaveNotice>
            ) : null}

            <div className="flex gap-2">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
                onClick={() => void save()}
                disabled={!readyToSave || unchanged || saving}
              >
                {saving ? "Saving…" : "Save currency and format"}
              </ViewOnlyActionButton>
              <Button variant="outline" onClick={cancelEditing} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
