"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatNZInstantOrRaw } from "@/lib/nzst-date";
import {
  EnvironmentXeroContainment,
  type DeclarationKind,
  type EnvironmentRole,
  type XeroContactContainment,
} from "@/components/admin/environment-xero-containment";

/**
 * The environment-safety panel (ENV-SAFETY 1, #3034; epic #2986).
 *
 * WHY THIS SURFACE DOES NOT USE `ViewOnlyActionButton` /
 * `AdminViewOnlySectionBanner`, and please do not "fix" it to. Those are the
 * canonical furniture for a section with a VIEW tier and an EDIT tier: they
 * resolve `useAdminAreaEditAccess(area)` and explain that this admin can look but
 * not change, because their access role grants the area at `view`. This screen
 * has exactly one permission level — Full Admin, enforced in the route by
 * `requireAdmin({ permission: false })` — so there is no area-edit tier to
 * describe, and rendering that banner here would state a REASON that is not the
 * reason. `/admin/environment`'s page shell therefore does what
 * `/admin/club-time` and `/admin/config-transfer` do: it tests `isFullAdmin` and
 * shows a short "available to full administrators only" panel instead of this
 * one. `docs/ARCHITECTURE.md` -> "Admin/member layer" names this as the
 * acknowledged shape for a whole-screen-Full-Admin surface.
 *
 * IT STILL FOLLOWS THE STAGED-EDIT MODEL. The panel mounts READ-ONLY showing
 * what this installation is and which source decided it; changing the override is
 * Switch -> acknowledge -> Save. Nothing persists on a click, and the
 * acknowledgement is not decoration — the API refuses an unconfirmed change, so a
 * caller that skips this panel gets the same refusal.
 *
 * THE BROWSER NEVER DECIDES THE ROLE. Everything shown here arrives from
 * `GET /api/admin/environment-safety`. There is no `process.env` read in this
 * file and there cannot be a useful one: `APP_ENVIRONMENT_ROLE` is deliberately
 * not a `NEXT_PUBLIC_` variable, so a browser would read `undefined` and report
 * "nothing has declared this installation" while the server read `production`.
 * That is the split-brain second authority INV-CONFIG-003 exists to prevent, and
 * `environment-role-declaration.ts` is a named forbidden leaf in the
 * client/server boundary census for exactly this reason.
 *
 * WHAT THIS SCREEN MAY CLAIM. #3034 recorded and reported the role and this copy
 * said so; #3035 and #3036 are the changes that made the role ACT, so the copy
 * now says what actually happens. A confirmed copy does not email members
 * (#3035, INV-CONFIG-004), and every Xero contact it touches has its email
 * address replaced with a non-deliverable one so Xero cannot email members from
 * a copy either (#3036, INV-CONFIG-005).
 *
 * NOTE WHAT IT STILL MAY NOT CLAIM, because the previous version of this copy
 * was going to be wrong in exactly this way: a copy does NOT "stop writing to
 * the club's real Xero organisation". It keeps writing — invoices, credit notes
 * and contacts, all of it, deliberately, so settlement behaviour stays testable
 * — and what changes is that the contacts can no longer reach anybody. If it is
 * pointed at the club's REAL Xero organisation, containment REWRITES real
 * accounting records, which is why the block below reports how many.
 */

type DecidedBy =
  | "deployment-declaration"
  | "database-safer-override"
  | "unresolved";

/**
 * How much application email this installation has held back for
 * environment-safety reasons.
 *
 * Declared here rather than imported, like every other type in this file: the
 * module that builds the payload is `server-only`, so a client component cannot
 * import from it. `available: false` is deliberately its own case and NOT a zero
 * — see `src/lib/environment-safety-withheld.ts` for why "none held back" and
 * "not counted yet" must not render the same, and why no heuristic over the
 * database's contents can do this job.
 */
type WithheldApplicationEmail =
  | { available: false }
  | {
      available: true;
      count: number;
      mostRecentAt: string | null;
      /**
       * The subset that is the club's LIVE site declaring a capture mailbox —
       * the one withhold reason a PRODUCTION installation can have, and the
       * reason this block renders there at all (#3035).
       */
      captureInProduction: number;
    };

type EnvironmentSafetyState = {
  role: EnvironmentRole;
  decidedBy: DecidedBy;
  declaration: { kind: DeclarationKind; raw: string | null };
  override: {
    on: boolean;
    readable: boolean;
    updatedAt: string | null;
    updatedByName: string | null;
  };
  withheldEmail: WithheldApplicationEmail;
  xeroContactContainment: XeroContactContainment;
  notes: string[];
};

/** The words the operator guide uses, so the screen and the guide agree. */
const ROLE_LABEL: Record<EnvironmentRole, string> = {
  PRODUCTION: "Production — the club's live site",
  NON_PRODUCTION: "Non-production — a copy",
  UNKNOWN: "Not configured",
};

const ROLE_TONE: Record<EnvironmentRole, string> = {
  PRODUCTION: "border-warning-6 bg-warning-2",
  NON_PRODUCTION: "border-border bg-muted",
  UNKNOWN: "border-danger-6 bg-danger-3",
};

const DECIDED_BY_LABEL: Record<DecidedBy, string> = {
  "deployment-declaration": "Decided by this deployment's configuration",
  "database-safer-override": "Decided by the safer override below",
  unresolved: "Nothing has decided it",
};

function describeDeclaration(state: EnvironmentSafetyState): string {
  switch (state.declaration.kind) {
    case "production":
      return "This deployment says production.";
    case "non-production":
      return "This deployment says non-production.";
    case "invalid":
      return `This deployment sets APP_ENVIRONMENT_ROLE to "${state.declaration.raw ?? ""}", which is not one of the two accepted values (production, non-production), so it is refused rather than guessed at.`;
    case "absent":
      return "This deployment does not set APP_ENVIRONMENT_ROLE at all.";
  }
}

/**
 * The withheld-email sentence.
 *
 * THIS IS THE SIGNAL THAT SEPARATES the two cases nothing else can tell apart: a
 * live club installation that is not sending — because it has been wrongly
 * declared a copy, or left undeclared — and a copy nobody is using. A copy
 * restored from the live database holds the club's real members and their real
 * addresses, so no inspection of the DATA can distinguish them; what distinguishes
 * them is consequence. A real club in either of those states holds back a steady
 * stream of member mail; an idle copy holds back almost nothing.
 *
 * The three states must read differently. "None" and "could not be counted" look
 * identical at a glance and mean opposite things: one says nobody is using this
 * installation, the other says nobody knows. The numbers come from
 * `src/lib/environment-safety-withheld.ts`, which counts what #3035's delivery
 * boundary records.
 *
 * NO SENTENCE HERE MAY NAME ONE STATE'S REASON, because this block renders under
 * two — a confirmed copy and an installation nobody has declared. Telling the
 * operator of an undeclared LIVE site that its mail is held back "because it is
 * treated as a copy" sends them looking for the safer override instead of the
 * missing declaration, and the override is not what is holding their mail. The
 * role is displayed directly above this block and says which state applies; this
 * block says how much and how lately, in words true of both (#3035).
 */
function describeWithheldEmail(state: EnvironmentSafetyState): {
  headline: string;
  detail: string;
} {
  const withheld = state.withheldEmail;
  if (!withheld.available) {
    return {
      headline: "Could not be counted on this installation",
      detail:
        "This is not the same as none: one says nothing has been held back, the other says nobody knows. The count could not be read from the database — usually a migration that has not been applied here. Apply any pending migrations and check again; meanwhile this line cannot tell you whether this installation is quietly holding back mail the club's members are waiting for.",
    };
  }
  if (withheld.count === 0) {
    return {
      headline: "None held back",
      detail:
        "Nothing has been held back on this installation for environment-safety reasons, which is what an installation nobody is using looks like.",
    };
  }
  /*
    THE LIVE-SITE-IN-CAPTURE-MODE CASE GETS ITS OWN SENTENCE, because the generic
    one is wrong here in the expensive direction: "wrongly declared a copy, or
    left undeclared" would send this operator to check a declaration that is
    perfectly correct, while the actual fault is two lines further down the same
    env file. Named separately rather than folded in, since it is the one state a
    PRODUCTION installation can be in and the repair is different.
  */
  if (withheld.captureInProduction > 0) {
    const recently = withheld.mostRecentAt
      ? ` Most recently ${formatNZInstantOrRaw(withheld.mostRecentAt)}.`
      : "";
    return {
      headline: `${withheld.captureInProduction} message${withheld.captureInProduction === 1 ? "" : "s"} refused: this installation says it is BOTH the live site and a mail capture`,
      detail: `Those cannot both be true — a live site in capture mode would accept every message and deliver none of them — so nothing was sent rather than being silently swallowed.${recently} Set USE_AWS_SES or USE_SMTP_RELAY and remove USE_LOCAL_CAPTURE (or set it to false). Messages whose contents are stored then go out by themselves; ones carrying a sign-in link, a door code or a payment link keep no stored copy and are listed for a manual re-send.`,
    };
  }
  return {
    headline: `${withheld.count} message${withheld.count === 1 ? "" : "s"} held back`,
    detail: withheld.mostRecentAt
      ? `Most recently ${formatNZInstantOrRaw(withheld.mostRecentAt)}. A steady and recent count is what a LIVE club looks like when it has been wrongly declared a copy, or left undeclared. If members are waiting for that mail, the answer above is wrong.`
      : "A steady and recent count is what a LIVE club looks like when it has been wrongly declared a copy, or left undeclared. If members are waiting for that mail, the answer above is wrong.",
  };
}

function describeOverride(state: EnvironmentSafetyState): string {
  if (!state.override.readable) {
    return "Could not be read from the database — the migration has probably not been applied here yet.";
  }
  return state.override.on
    ? "On — this installation is forced to be treated as a copy, whatever the deployment says."
    : "Off — the deployment's own setting decides.";
}

export function EnvironmentSafetyPanel() {
  const [state, setState] = useState<EnvironmentSafetyState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acknowledgeId = useId();

  function load() {
    setLoadFailed(false);
    void fetch("/api/admin/environment-safety")
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        const payload = (await response.json()) as {
          state: EnvironmentSafetyState;
        };
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
          Could not load this installation&apos;s environment setting.
        </p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  if (!state) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading environment setting…
      </p>
    );
  }

  const target = !state.override.on;

  function startEditing() {
    setAcknowledged(false);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setAcknowledged(false);
    setError(null);
  }

  async function save() {
    if (!acknowledged) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/environment-safety", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forceNonProduction: target, confirmed: true }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { state?: EnvironmentSafetyState; error?: string }
        | null;
      if (!response.ok || !payload?.state) {
        setError(payload?.error ?? "Could not save the change.");
        return;
      }
      setState(payload.state);
      cancelEditing();
    } catch {
      setError("Could not save the change.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div
        className={`space-y-1 rounded-md border p-6 ${ROLE_TONE[state.role]}`}
      >
        <p className="text-sm text-muted-foreground">This installation is</p>
        <p className="text-lg font-semibold" data-testid="environment-role">
          {ROLE_LABEL[state.role]}
        </p>
        <p className="text-sm">{DECIDED_BY_LABEL[state.decidedBy]}</p>
      </div>

      {/*
        Directly under the role, whenever delivery is being held back — which is
        NON_PRODUCTION *and* UNKNOWN. The first version showed it only for a
        confirmed copy, on the premise that "nothing is being held back" otherwise;
        a third review lens pointed out this codebase says the opposite about
        UNKNOWN in three places (the boot advisory, the deploy script, and the
        readiness step's own next sentence), and that UNKNOWN is precisely the
        state a live installation reaches by upgrading without the declaration —
        the scenario this whole issue exists for. Withholding the count from that
        operator is the worst place to withhold it.

        AND FOR PRODUCTION TOO, but only when the fifth outcome has actually
        happened — a live site that ALSO declares a capture mailbox is in a total
        mail outage, and this panel used to show PRODUCTION with no withheld line
        while every message was being refused (#3035 review). Keyed on the
        capture-in-production count rather than the total, because
        SKIPPED_NON_PRODUCTION rows are terminal: an installation that spent an
        afternoon as a forced copy carries them for ever, and a permanent banner
        on a healthy live site is a line an operator learns to scroll past.
      */}
      {state.role === "NON_PRODUCTION" ||
      state.role === "UNKNOWN" ||
      (state.withheldEmail.available &&
        state.withheldEmail.captureInProduction > 0) ? (
        <div
          className="space-y-1 rounded-md border bg-card p-6"
          data-testid="environment-withheld-email"
        >
          <p className="text-sm font-semibold">
            Application email held back for environment safety
          </p>
          <p className="text-base">{describeWithheldEmail(state).headline}</p>
          <p className="text-sm text-muted-foreground">
            {describeWithheldEmail(state).detail}
          </p>
        </div>
      ) : null}

      <EnvironmentXeroContainment
        role={state.role}
        declarationKind={state.declaration.kind}
        overrideReadable={state.override.readable}
        containment={state.xeroContactContainment}
      />

      <div className="space-y-4 rounded-md border bg-card p-6">
        <div className="space-y-1">
          <p className="text-sm font-semibold">
            What this deployment&apos;s configuration says
          </p>
          <p className="text-sm text-muted-foreground">
            {describeDeclaration(state)}
          </p>
          <p className="text-xs text-muted-foreground">
            It is set outside the app, in this deployment&apos;s environment
            (APP_ENVIRONMENT_ROLE), and cannot be changed from here — which is
            the point: a copy of the live database must not be able to declare
            itself the live site. Note that this is not APP_RUNTIME_ROLE, which
            names which container slot this is and is never read for this.
          </p>
        </div>

        <div className="space-y-1 border-t pt-4">
          <p className="text-sm font-semibold">Safer override</p>
          <p className="text-sm text-muted-foreground">
            {describeOverride(state)}
          </p>
          {state.override.updatedAt ? (
            <p className="text-xs text-muted-foreground">
              {`Last changed ${formatNZInstantOrRaw(state.override.updatedAt)}`}
              {state.override.updatedByName
                ? ` by ${state.override.updatedByName}`
                : null}
            </p>
          ) : null}
        </div>

        {state.notes.length > 0 ? (
          <ul className="list-disc space-y-1 border-t pl-5 pt-4 text-sm text-muted-foreground">
            {state.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="space-y-4 rounded-md border bg-card p-6">
        {!editing ? (
          <>
            <p className="text-sm text-muted-foreground">
              {state.override.on
                ? "Switching the override off hands the decision back to this deployment's own setting. It does not make this installation the live site."
                : "Switching the override on forces this installation to be treated as a copy, whatever this deployment's setting says. Use it when you have restored a copy of the live database and want to be certain nothing reaches real members. It is stored in this database, so restoring the live database again removes it — the durable fix is APP_ENVIRONMENT_ROLE=non-production in this deployment's own environment."}
            </p>
            <Button onClick={startEditing} disabled={!state.override.readable}>
              {state.override.on
                ? "Switch the override off"
                : "Switch the override on"}
            </Button>
            {!state.override.readable ? (
              <p className="text-sm text-danger">
                The setting cannot be read, so it cannot be changed. Apply the
                pending database migrations and reload.
              </p>
            ) : null}
          </>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3 rounded-md border border-warning-6 bg-warning-2 p-4">
              <p className="text-sm font-semibold">
                {target
                  ? "Force this installation to be treated as a copy"
                  : "Stop forcing this installation to be treated as a copy"}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                <li>
                  Nothing already recorded changes. No booking, payment, member
                  or invoice is touched — what changes is how this installation
                  behaves from now on.
                </li>
                <li>
                  {target
                    ? "A copy sends no email to members, and every Xero contact it touches has its email address replaced with one that cannot be delivered — so Xero cannot email a member from here either. Switching this on is what STARTS that replacement, not what stops it: containment runs only on an installation confirmed to be a copy. So if this installation is connected to the club's REAL Xero organisation, switching this on begins editing real accounting records — disconnect Xero here first, or point it at a test organisation."
                    : "The decision goes back to this deployment's own APP_ENVIRONMENT_ROLE setting. If that setting says nothing, this installation becomes \"not configured\" — it does NOT become the live site, and while it says nothing this application writes nothing to Xero at all."}
                </li>
                <li>
                  The change is recorded in the audit log with your name and the
                  value before and after.
                </li>
              </ul>
              <div className="flex items-start gap-2">
                <Checkbox
                  id={acknowledgeId}
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked)}
                />
                <Label htmlFor={acknowledgeId} className="text-sm font-normal">
                  {target
                    ? "I understand this forces the installation to be treated as a copy, and that nothing already recorded is changed."
                    : "I understand this hands the decision back to the deployment's own setting, that it does not make this installation the live site, and that nothing already recorded is changed."}
                </Label>
              </div>
            </div>

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <div className="flex gap-2">
              <Button
                onClick={() => void save()}
                disabled={!acknowledged || saving}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="outline"
                onClick={cancelEditing}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
