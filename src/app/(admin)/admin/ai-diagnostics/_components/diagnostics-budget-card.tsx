"use client";

import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";

import {
  ADMIN_VIEW_ONLY_ACTION_REASON,
  useAdminAreaEditAccess,
} from "@/hooks/use-admin-area-edit-access";
import { parseDecimalDollarsToCents } from "@/lib/money-input";
import { formatCents } from "@/lib/utils";

/**
 * THE MONTHLY DIAGNOSTICS BUDGET, shown and edited (AID-7, #2378, owner decision 3).
 *
 * "Show the Diagnostics budget on the Diagnostics page and allow editing only while
 * the `aiDiagnostics` module is enabled, using the existing authorised configuration-
 * write semantics. Module off shows the state and a route/link to Feature modules
 * rather than an active budget editor."
 *
 * THE SERVER OWNS THE NUMBER, and this component never caches a second copy of it
 * (#2378: "do not duplicate the budget source of truth in UI-local state/config").
 * The only local state is the text in the input while somebody is typing; the saved
 * value is whatever the last server response said, and a save replaces it with the
 * server's own echo rather than with what was typed.
 *
 * EVERY NON-EDITABLE STATE IS AN HONEST REFUSAL, and none of them is silence. #2378
 * requires that the UI "represent permission denial honestly rather than hiding
 * tools as if the evidence did not exist". The states are the `BudgetState` union
 * below — a hand-written count here drifted inside its own PR ("three", with four
 * shipped; contract review, 13 Aug 2026), so the union is the census and this list
 * just says what each refusal tells the operator:
 *
 *   - module off  -> the budget cannot be read or changed; link to Feature modules.
 *     (`/api/admin/ai-diagnostics/settings` is hard-gated on the flag and 404s.)
 *   - module flag UNREADABLE (`null`, #2803) -> could not be established; explicitly
 *     not the same as off, and explicitly do not go switch the module on.
 *   - no `support:view`  -> say the budget is not shown and who can see it, rather
 *     than render an empty card that reads as "there is no budget".
 *   - `support:view` but not `support:edit` -> the figure, read-only, with the
 *     standard view-only reason.
 *   - read failed -> the budget could not be read; NEVER a zero, because zero is a
 *     real setting that hard-offs every paid call.
 *
 * THE CLIENT-SIDE EDIT CHECK IS A COURTESY, NOT THE GATE. `useAdminAreaEditAccess`
 * decides whether the control is enabled so a view-only admin is not invited to type
 * into a box that will reject them; the PUT is still gated on `support:edit` server-
 * side, and a 403 is surfaced here rather than swallowed.
 */

type BudgetState =
  | { kind: "loading" }
  | { kind: "module_off" }
  | { kind: "module_unknown" }
  | { kind: "not_permitted" }
  | { kind: "unavailable"; message: string }
  | {
      kind: "loaded";
      monthlyBudgetCents: number;
      maxMonthlyBudgetCents: number;
      settledCents: number;
      activeReservedCents: number;
      requestCount: number;
    };

/**
 * Cents to the dollar string the input shows. Money stays in integer cents.
 * `formatCents`'s `{ style: "plain" }` (#3302) — same arithmetic as the AI
 * assistant budget box's `centsToDollars`, one definition for both.
 */
function centsToDollars(cents: number): string {
  return formatCents(cents, { style: "plain" });
}

/**
 * Dollars typed by a human to integer cents, or null when it is not an amount.
 *
 * A leading "$" is tolerated because people paste one; everything after that is
 * the canonical exact parser's job (#2685), which is also what refuses "12.005"
 * outright rather than quietly deciding which cent the person meant.
 */
function dollarsToCents(value: string): number | null {
  return parseDecimalDollarsToCents(value.trim().replace(/^\$/, ""));
}

export function DiagnosticsBudgetCard({
  moduleEnabled,
}: {
  /**
   * TRI-STATE (#2803): `true` on, `false` off, `null` when the club's module
   * settings could not be READ. `null` renders as "unknown", never as "off" — the
   * readiness contract is explicit that "the two send an operator to different
   * places", and telling someone to go and switch on a module that is already on
   * is the exact bug #2803 was filed for.
   */
  moduleEnabled: boolean | null;
}) {
  const [state, setState] = useState<BudgetState>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const canEdit = useAdminAreaEditAccess("support");
  const inputId = useId();
  const hintId = useId();

  const load = useCallback(async () => {
    if (moduleEnabled === null) {
      setState({ kind: "module_unknown" });
      return;
    }
    if (!moduleEnabled) {
      setState({ kind: "module_off" });
      return;
    }
    try {
      const response = await fetch("/api/admin/ai-diagnostics/settings");
      if (response.status === 404) {
        // The route is hard-gated on the module flag, so a 404 here means the flag
        // moved since the page rendered — not a missing endpoint.
        setState({ kind: "module_off" });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setState({ kind: "not_permitted" });
        return;
      }
      if (!response.ok) {
        setState({
          kind: "unavailable",
          message: "The budget could not be read just now.",
        });
        return;
      }
      const data = (await response.json()) as {
        monthlyBudgetCents: number;
        maxMonthlyBudgetCents: number;
        usage: {
          month: {
            settledCents: number;
            activeReservedCents: number;
            requestCount: number;
          };
        };
      };
      setState({
        kind: "loaded",
        monthlyBudgetCents: data.monthlyBudgetCents,
        maxMonthlyBudgetCents: data.maxMonthlyBudgetCents,
        settledCents: data.usage.month.settledCents,
        activeReservedCents: data.usage.month.activeReservedCents,
        requestCount: data.usage.month.requestCount,
      });
      setDraft(centsToDollars(data.monthlyBudgetCents));
    } catch {
      setState({
        kind: "unavailable",
        message: "The budget could not be read just now.",
      });
    }
  }, [moduleEnabled]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="budget-loading">
        Reading the budget…
      </p>
    );
  }

  if (state.kind === "module_off") {
    return (
      <div className="text-sm" data-testid="budget-module-off">
        <p className="text-muted-foreground">
          The budget cannot be read or changed while AI Diagnostics is switched
          off.
        </p>
        <p className="mt-2">
          <Link className="underline" href="/admin/modules">
            Open Feature modules
          </Link>
        </p>
      </div>
    );
  }

  if (state.kind === "module_unknown") {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="budget-module-unknown"
      >
        Whether AI Diagnostics is switched on could not be established, so the
        budget is not shown. This is not the same as the module being off — see the
        readiness section above, and do not switch the module on to fix it.
      </p>
    );
  }

  if (state.kind === "not_permitted") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="budget-denied">
        The monthly budget is not shown to your admin role. Someone with support
        access can see and change it.
      </p>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="budget-unavailable">
        {state.message} Try again shortly.
      </p>
    );
  }

  const handleSave = async () => {
    const cents = dollarsToCents(draft);
    if (cents === null) {
      // Names what is actually refused. A leading "$" is stripped before the
      // parser sees it, so it is not listed; a thousands separator and a leading
      // zero are refused and were previously unexplained (#2685 review).
      setSaveError(
        "Enter an amount in dollars and cents, for example 25.00 — no thousands separator or leading zero.",
      );
      return;
    }
    if (cents > state.maxMonthlyBudgetCents) {
      setSaveError(
        `The most that can be set is $${centsToDollars(state.maxMonthlyBudgetCents)}.`,
      );
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/admin/ai-diagnostics/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyBudgetCents: cents }),
      });
      if (response.status === 401 || response.status === 403) {
        setSaveError(ADMIN_VIEW_ONLY_ACTION_REASON);
        return;
      }
      if (!response.ok) {
        setSaveError("That could not be saved. Try again shortly.");
        return;
      }
      // Re-read rather than trust what was typed: the server is the source of
      // truth, and a re-read also refreshes the month's spend beside it.
      await load();
      setSavedAt(Date.now());
    } catch {
      setSaveError("That could not be saved. Try again shortly.");
    } finally {
      setSaving(false);
    }
  };

  const dirty = dollarsToCents(draft) !== state.monthlyBudgetCents;

  return (
    <div className="text-sm" data-testid="budget-card">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Spent this month</dt>
        <dd className="tabular-nums">
          ${centsToDollars(state.settledCents)} of $
          {centsToDollars(state.monthlyBudgetCents)}
        </dd>
        <dt className="text-muted-foreground">Questions asked</dt>
        <dd className="tabular-nums">{state.requestCount}</dd>
        {state.activeReservedCents > 0 ? (
          <>
            <dt className="text-muted-foreground">Held for questions in flight</dt>
            <dd className="tabular-nums">
              ${centsToDollars(state.activeReservedCents)}
            </dd>
          </>
        ) : null}
      </dl>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="font-medium">
            Monthly budget
          </label>
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            value={draft}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
            readOnly={!canEdit}
            data-testid="budget-input"
            className="w-32 rounded-md border border-border bg-background px-3 py-1.5 tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:opacity-60"
          />
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!canEdit || saving || !dirty}
          data-testid="budget-save"
          className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <p id={hintId} className="mt-2 text-xs text-muted-foreground">
        In New Zealand dollars, up to $
        {centsToDollars(state.maxMonthlyBudgetCents)}. Zero switches off every paid
        Diagnostics question without touching the module.
      </p>

      {/* Gated on `=== false`, never on `!canEdit`, so it does not flash while the
          client session is still resolving (see `useAdminAreaEditAccess`). */}
      {canEdit === false ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="budget-view-only">
          {ADMIN_VIEW_ONLY_ACTION_REASON}
        </p>
      ) : null}

      <div role="status" aria-live="polite">
        {saveError ? (
          <p className="mt-2 text-xs text-danger" data-testid="budget-error">
            {saveError}
          </p>
        ) : savedAt ? (
          <p className="mt-2 text-xs text-success" data-testid="budget-saved">
            Saved.
          </p>
        ) : null}
      </div>
    </div>
  );
}
