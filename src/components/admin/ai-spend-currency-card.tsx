"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClubTime } from "@/components/club-time-provider";
import {
  ADMIN_VIEW_ONLY_ACTION_REASON,
  useAdminAreaEditAccess,
} from "@/hooks/use-admin-area-edit-access";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  RATE_INPUT_RULE,
  describeRateInputRule,
  formatClubUnitsPerNzd,
  parseClubUnitsPerNzdToMicros,
} from "@/lib/ai-spend-currency";
import { requireInstant } from "@/lib/club-time";

/**
 * THE NZD -> CLUB-CURRENCY RATE FOR AI SPEND (#3354, owner decision 12 Sep 2026),
 * shown and edited. ONE component rendered on BOTH AI settings pages (the
 * page-help assistant and AI Diagnostics), because the rate is one setting
 * shared by both modules — two cards would be two places to state one fact.
 *
 * WHAT IT SAYS. Both modules price provider tokens in New Zealand cents and
 * convert each estimate through this rate before booking it or comparing it
 * with the monthly cap, so a club outside New Zealand enters and reads its cap
 * in its own money. A stale rate drifts silently, which is why the card shows
 * WHEN the rate was last set (owner's accepted cost). For an NZD club nothing
 * converts: the card says so in one sentence and renders no editor.
 *
 * THE SERVER OWNS THE NUMBER: the only local state is the draft while somebody
 * is typing, and a save re-reads rather than trusting what was typed. The
 * canonical settings pattern (docs/ARCHITECTURE.md -> "Admin/member layer"):
 * read-only on mount, a staged Edit -> Save/Cancel step, Save dirty-gated, every
 * edit affordance a `ViewOnlyActionButton` headed by ONE
 * `AdminViewOnlySectionBanner` mounted above the loading early-return so its
 * live region exists from first paint.
 *
 * THE CLIENT-SIDE CHECKS ARE A COURTESY, NOT THE GATE: the PUT is gated on
 * `support:edit` server-side and re-parses the decimal with the same canonical
 * parser, and a 403 is surfaced here rather than swallowed.
 */

const RATE_URL = "/api/admin/ai-spend-currency";

type RateResponse = {
  clubCurrency: string;
  isNzd: boolean;
  isConfigured: boolean;
  clubUnitsPerNzdMicros: number;
  clubUnitsPerNzd: string;
  rateSetAt: string | null;
  rateSetByMemberId: string | null;
};

type RateState =
  | { kind: "loading" }
  | { kind: "not_permitted" }
  | { kind: "unavailable" }
  | { kind: "loaded"; data: RateResponse };

export function AiSpendCurrencyCard() {
  const clubTime = useClubTime();
  const canEdit = useAdminAreaEditAccess("support");
  const inputId = useId();
  const hintId = useId();

  const [state, setState] = useState<RateState>({ kind: "loading" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(RATE_URL, { cache: "no-store" });
      if (response.status === 401 || response.status === 403) {
        setState({ kind: "not_permitted" });
        return;
      }
      if (!response.ok) {
        setState({ kind: "unavailable" });
        return;
      }
      setState({ kind: "loaded", data: (await response.json()) as RateResponse });
    } catch {
      setState({ kind: "unavailable" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const banner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Support view access can see the rate. Support edit access is required to
      change it.
    </AdminViewOnlySectionBanner>
  );

  if (state.kind === "loading") {
    return (
      <div>
        {banner}
        <p className="text-sm text-muted-foreground" data-testid="spend-currency-loading">
          Reading the currency setting…
        </p>
      </div>
    );
  }

  if (state.kind === "not_permitted") {
    return (
      <div>
        {banner}
        <p className="text-sm text-muted-foreground" data-testid="spend-currency-denied">
          The currency setting is not shown to your admin role. Someone with
          support access can see and change it.
        </p>
      </div>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <div>
        {banner}
        <p
          className="text-sm text-muted-foreground"
          data-testid="spend-currency-unavailable"
        >
          The currency setting could not be read just now. Try again shortly.
        </p>
      </div>
    );
  }

  const { data } = state;

  if (data.isNzd) {
    // Nothing to convert and nothing to edit: the banner still heads the
    // section so a view-only admin is told the same thing on every section.
    return (
      <div>
        {banner}
        <p className="text-sm text-muted-foreground" data-testid="spend-currency-nzd">
          This club&apos;s currency is New Zealand dollars, the currency AI
          usage is priced in, so no conversion applies and there is no rate to
          set.
        </p>
      </div>
    );
  }

  const startEditing = () => {
    setDraft(data.isConfigured ? data.clubUnitsPerNzd : "");
    setError(null);
    setSuccess(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setError(null);
  };

  const draftMicros = parseClubUnitsPerNzdToMicros(draft);
  const dirty =
    draftMicros !== null &&
    (!data.isConfigured || draftMicros !== data.clubUnitsPerNzdMicros);

  const save = async () => {
    if (draftMicros === null) {
      setError(describeRateInputRule(data.clubCurrency));
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(RATE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubUnitsPerNzd: draft.trim() }),
      });
      if (response.status === 401 || response.status === 403) {
        setError(ADMIN_VIEW_ONLY_ACTION_REASON);
        return;
      }
      if (!response.ok) {
        let message = "The rate could not be saved. Try again shortly.";
        try {
          const body = (await response.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // keep the generic message
        }
        setError(message);
        return;
      }
      // Re-read rather than trust what was typed: the server is the source of
      // truth, and it is the server's "set at" instant that is shown.
      await load();
      setEditing(false);
      setSuccess("Rate saved.");
    } catch {
      setError("The rate could not be saved. Try again shortly.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {banner}
      <div className="space-y-4 text-sm" data-testid="spend-currency-card">
        <p className="text-muted-foreground">
          AI usage is priced in New Zealand dollars. This rate converts each
          estimate into {data.clubCurrency} before it is counted against the
          monthly caps on this page and the other AI settings page, so the caps
          are compared in {data.clubCurrency}. Check it now and then — a rate
          that drifts makes the caps silently too loose or too tight.
        </p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Club currency</dt>
          <dd data-testid="spend-currency-code">{data.clubCurrency}</dd>
          <dt className="text-muted-foreground">Rate</dt>
          <dd className="tabular-nums" data-testid="spend-currency-rate">
            {data.isConfigured ? (
              <>
                1 NZD = {formatClubUnitsPerNzd(data.clubUnitsPerNzdMicros)}{" "}
                {data.clubCurrency}
              </>
            ) : (
              <>
                Not set — spend is being counted as if 1 NZD = 1{" "}
                {data.clubCurrency}.
              </>
            )}
          </dd>
          {data.isConfigured && data.rateSetAt ? (
            <>
              <dt className="text-muted-foreground">Last set</dt>
              <dd data-testid="spend-currency-set-at">
                {clubTime.instantDateTime(requireInstant(data.rateSetAt))}
              </dd>
            </>
          ) : null}
        </dl>

        {editing ? (
          <div className="space-y-2">
            <div className="grid gap-2 sm:max-w-xs">
              <Label htmlFor={inputId}>
                {data.clubCurrency} per New Zealand dollar
              </Label>
              <Input
                id={inputId}
                type="text"
                inputMode="decimal"
                value={draft}
                aria-describedby={hintId}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
                data-testid="spend-currency-input"
              />
              <p id={hintId} className="text-xs text-muted-foreground">
                For example 0.92 means one New Zealand dollar buys 0.92{" "}
                {data.clubCurrency}. The rate must {RATE_INPUT_RULE}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                disabled={saving || !dirty}
                onClick={() => void save()}
                data-testid="spend-currency-save"
              >
                {saving ? "Saving…" : "Save rate"}
              </ViewOnlyActionButton>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                disabled={saving}
                onClick={cancelEditing}
                data-testid="spend-currency-cancel"
              >
                Cancel
              </ViewOnlyActionButton>
            </div>
          </div>
        ) : (
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            variant="outline"
            onClick={startEditing}
            data-testid="spend-currency-edit"
          >
            {data.isConfigured ? "Change rate" : "Set rate"}
          </ViewOnlyActionButton>
        )}

        <div role="status" aria-live="polite">
          {error ? (
            <p className="text-xs text-danger" data-testid="spend-currency-error">
              {error}
            </p>
          ) : success ? (
            <p className="text-xs text-success" data-testid="spend-currency-saved">
              {success}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
