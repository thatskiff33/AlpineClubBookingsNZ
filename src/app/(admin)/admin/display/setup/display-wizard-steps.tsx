"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CopyField } from "@/components/admin/integration-wizard";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";
import { requireInstant } from "@/lib/club-time";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";
import { useRestoreBuiltInBoards } from "../templates/restore-built-ins";
import {
  DISPLAY_TERM_BOARD,
  DISPLAY_TERM_LAYOUT,
  DISPLAY_TERM_TEMPLATE,
} from "@/lib/lodge-display/display-terminology";
import {
  DISPLAY_WIZARD_SHARED_CURSOR_NOTE,
  boundTemplateId,
  isLodgeUnresolved,
  liveDevicesForLodge,
  pendingDeviceForLodge,
  savedConfigKeys,
  type DisplayWizardContext,
  type DisplayWizardTemplate,
} from "./display-wizard-state";

/**
 * The six step bodies of the Lodge Display guided setup wizard (#2249), in the
 * owner's signed-off order: module check → built-in boards → pick a board →
 * lodge details → pair the TV → done.
 *
 * Every write here goes through an EXISTING admin route; the wizard adds no
 * server surface of its own, and every one of those routes re-checks the
 * permission independently, so the gating below is an affordance, never the
 * enforcement.
 */

/**
 * `ancestorRendersViewOnlyBanner` (#2324) is the shell's vouch, forwarded by the
 * wizard config from `helpers.ancestorRendersViewOnlyBanner`. It defaults to
 * false, so a step body rendered anywhere else keeps its own per-button reason.
 *
 * It covers the LODGE-gated controls only — that is the scope the wizard's
 * banner states. Step 1's module switch is gated on `support`, so it keeps its
 * own reason (see `ModuleStep`).
 */
interface StepProps extends AncestorViewOnlyBannerProps {
  context: DisplayWizardContext;
  helpers: WizardStepHelpers;
}

/**
 * The install-wide-cursor sentence. Rendered on every step because that is the
 * condition the owner attached to accepting the shared cursor (28 Jul 2026):
 * two admins share one position, and neither should discover that by surprise.
 */
export function SharedCursorNote() {
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="shared-cursor-note"
    >
      {DISPLAY_WIZARD_SHARED_CURSOR_NOTE}
    </p>
  );
}

function StepShell({
  heading,
  intro,
  children,
}: {
  heading: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">{heading}</h2>
        <p className="text-sm text-muted-foreground">{intro}</p>
      </div>
      {children}
      <SharedCursorNote />
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "success" | "warning" | "info";
  children: React.ReactNode;
}) {
  const className =
    tone === "success"
      ? "border-success-7 bg-success-3 text-success-11"
      : tone === "warning"
        ? "border-warning-7 bg-warning-3 text-warning-11"
        : "border-border bg-muted text-muted-foreground";
  return (
    <div className={`rounded-md border p-3 text-sm ${className}`}>
      {children}
    </div>
  );
}

/**
 * The blocking state for steps 3–6 when no lodge could be resolved.
 *
 * The wizard used to fall back to "any lodge" here, which quietly let another
 * lodge's screen satisfy this lodge's gates and let the pairing step adopt a
 * device belonging somewhere else. Reading nothing and saying so is the honest
 * answer (#2249 review M4).
 */
function LodgeUnresolvedNotice() {
  return (
    <Notice tone="warning">
      <p className="font-medium">Your lodges could not be read.</p>
      <p className="mt-1">
        This step will not read or change any screen until it knows which lodge
        it is setting up — a screen at another lodge is not this lodge&apos;s
        screen. Reload the page; if it keeps happening, check that your club has
        an active lodge on <strong>Admin → Lodges</strong>.
      </p>
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Waiting for the screen (steps 5 and 6)
// ---------------------------------------------------------------------------

/**
 * Steps 5 and 6 verify on facts only the TV can write: the screen claims its
 * own token on its own ~4-second poll, and stamps `lastSeenAt` the first time it
 * fetches state. Nothing in this page re-reads server truth by itself, so
 * without this the operator sat on a step that could never tick until they
 * reloaded — while the copy promised it would tick over on its own (#2249
 * review H1).
 *
 * BOUNDED on purpose: a fixed budget of polls (about two minutes) rather than a
 * timer running for the whole 15-minute pairing window. When the budget runs
 * out the step stops polling and says so, next to a "Check again" button. The
 * budget resets whenever the wait restarts — a fresh code armed, or the
 * operator asking — and the interval is cleared on unmount.
 */
export const WIZARD_WAIT_POLL_MS = 6_000;
export const WIZARD_WAIT_POLL_BUDGET = 20;

function useWaitForScreen(waiting: boolean, refresh: () => void) {
  const [attempts, setAttempts] = useState(0);
  // The budget is counted in a ref as well as in state: the ref is what the
  // tick itself checks, so the interval stops at the budget even if a re-render
  // has not landed between two ticks. State alone would let a busy tab overrun.
  const attemptsRef = useRef(0);
  // The shell hands a fresh `refresh` identity on most renders; keeping it in a
  // ref means the interval is created once per wait rather than restarted (and
  // its clock reset) on every re-render.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!waiting) {
      attemptsRef.current = 0;
      setAttempts(0);
    }
  }, [waiting]);

  const polling = waiting && attempts < WIZARD_WAIT_POLL_BUDGET;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      if (attemptsRef.current >= WIZARD_WAIT_POLL_BUDGET) return;
      attemptsRef.current += 1;
      setAttempts(attemptsRef.current);
      refreshRef.current();
    }, WIZARD_WAIT_POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);

  const checkAgain = useCallback(() => {
    attemptsRef.current = 0;
    setAttempts(0);
    refreshRef.current();
  }, []);

  return { polling, exhausted: waiting && !polling, checkAgain };
}

/** The explicit "I am not waiting any longer" affordance beside the poll. */
function CheckAgainButton({
  polling,
  onCheckAgain,
}: {
  polling: boolean;
  onCheckAgain: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={onCheckAgain}>
        Check again
      </Button>
      <span className="text-xs text-muted-foreground">
        {polling
          ? "This page is re-reading your screens every few seconds while you wait."
          : "Automatic re-reading has stopped for now — press Check again to restart it."}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — module check
// ---------------------------------------------------------------------------

interface ModuleSettingsPayload {
  settings?: Record<string, boolean>;
}

/**
 * Turning the module on is a `support`-area write (`PUT /api/admin/modules`),
 * while everything else in this wizard is `lodge`. A lodge-only admin therefore
 * gets the explanation and the address of the switch instead of a dead control
 * — the route would refuse them anyway, and pretending otherwise is worse than
 * saying so.
 */
export function ModuleStep({ context, helpers }: StepProps) {
  const canEditModules = useAdminAreaEditAccess("support");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function turnOn() {
    setMessage(null);
    setBusy(true);
    // The modules PUT takes the WHOLE settings object under a strict schema, so
    // the current values must be read first — flipping one key blind would
    // reset every other module.
    const current = await fetch("/api/admin/modules", {
      cache: "no-store",
    }).catch(() => null);
    if (current?.status === 403) {
      setBusy(false);
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (!current?.ok) {
      setBusy(false);
      setMessage(
        "Could not read the current module settings, so nothing was changed. " +
          "Turn Lobby TV display on under Admin → Feature modules instead.",
      );
      return;
    }
    const body = (await current.json().catch(() => null)) as
      ModuleSettingsPayload | Record<string, boolean> | null;
    const settings = (body && "settings" in body ? body.settings : body) as
      Record<string, boolean> | undefined;
    if (!settings) {
      setBusy(false);
      setMessage(
        "Could not read the current module settings; nothing changed.",
      );
      return;
    }

    const response = await fetch("/api/admin/modules", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { ...settings, lobbyDisplay: true } }),
    }).catch(() => null);
    setBusy(false);

    if (response?.status === 403) {
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (!response?.ok) {
      const errorBody = (await response?.json().catch(() => null)) as {
        error?: string;
      } | null;
      setMessage(errorBody?.error ?? "Could not turn the module on.");
      return;
    }
    setMessage(null);
    helpers.refresh();
  }

  return (
    <StepShell
      heading="Turn the Lobby TV display module on"
      intro="The module gates every display page, the display API, and the screen endpoint itself. This setup page is the one exception — it stays open so you can turn the module on from here."
    >
      {context.moduleEnabled ? (
        <Notice tone="success">
          <p className="font-medium">
            <Check className="mr-1 inline h-4 w-4" aria-hidden />
            Lobby TV display is on.
          </p>
          <p className="mt-1">
            Screens can reach the display URL, and the Lobby Display section is
            visible to every admin with lodge access.
          </p>
        </Notice>
      ) : (
        <>
          <Notice tone="warning">
            <p className="font-medium">Lobby TV display is currently off.</p>
            <p className="mt-1">
              A screen visiting the display URL sees a &ldquo;not enabled&rdquo;
              page, and the rest of this wizard cannot read or change anything
              until the module is on.
            </p>
            {context.moduleBlockedReads ? (
              // The display API 404s its whole tree while the module is off, so
              // the later steps genuinely have nothing to show. Saying which of
              // the two it is ("blocked" rather than "empty") stops a first-time
              // operator reading step 2 as "this club has no boards" (#2249
              // review L8).
              <p className="mt-1" data-testid="module-blocked-reads">
                That is also why the later steps look empty: your boards, screens
                and lodge details are being refused for now, not missing. They
                appear as soon as the module is on.
              </p>
            ) : null}
          </Notice>
          {canEditModules === false ? (
            <p className="text-sm text-muted-foreground">
              Your admin role can run this wizard but cannot change modules —
              that needs system-settings (support) edit access. Ask an
              administrator who has it to turn on{" "}
              <strong>Lobby TV display</strong> under{" "}
              <strong>Admin → Feature modules</strong>, then come back here.
            </p>
          ) : (
            <div className="space-y-2">
              {/* KEEPS its own reason, and must (#2324). The shell's vouch
                  covers the wizard's own scope — `lodge` — but this switch is
                  gated on `support`. An admin with lodge edit and support
                  view-only gets NO banner at all (the banner only renders when
                  the LODGE access is view-only), so opting this control out
                  would leave it silently dead for exactly the person who hits
                  it. Same reasoning as `member-credit-card.tsx` under #2168:
                  scope decides, not proximity. */}
              <ViewOnlyActionButton
                canEdit={canEditModules}
                disabled={busy}
                onClick={() => void turnOn()}
              >
                {busy ? "Turning it on…" : "Turn the module on"}
              </ViewOnlyActionButton>
              <p className="text-xs text-muted-foreground">
                This is the same switch as{" "}
                <strong>Admin → Feature modules → Lobby TV display</strong>, and
                it is audited the same way.
              </p>
            </div>
          )}
        </>
      )}
      {message ? <Notice tone="warning">{message}</Notice> : null}
    </StepShell>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — restore the built-in boards
// ---------------------------------------------------------------------------

function TerminologyList() {
  return (
    <dl className="space-y-2 text-sm">
      {[DISPLAY_TERM_LAYOUT, DISPLAY_TERM_TEMPLATE, DISPLAY_TERM_BOARD].map(
        (term) => (
          <div key={term.term}>
            <dt className="font-medium text-foreground">{term.term}</dt>
            <dd className="text-muted-foreground">{term.oneLiner}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

/**
 * Runs the shipped restore action (#2247 / PR #2301) — restore-only, never an
 * auto-seed, and behind the same destructive confirmation the Templates page
 * shows. A club that already authored its own boards is verified here without
 * pressing anything.
 */
export function BoardsStep({
  context,
  helpers,
  ancestorRendersViewOnlyBanner = false,
}: StepProps) {
  const [message, setMessage] = useState<string | null>(null);
  const { run, running, confirmDialog } = useRestoreBuiltInBoards({
    onResult: (text, restored) => {
      setMessage(text);
      if (restored) helpers.refresh();
    },
  });

  return (
    <StepShell
      heading="Make sure the built-in boards exist"
      intro="The built-in boards are created by the database seed, and upgrading the app never re-runs it — so a club whose database predates the lobby display starts with none."
    >
      <TerminologyList />

      {context.templates.length > 0 ? (
        <Notice tone="success">
          <p className="font-medium">
            <Check className="mr-1 inline h-4 w-4" aria-hidden />
            {context.templates.length} board
            {context.templates.length === 1 ? "" : "s"} available.
          </p>
          <p className="mt-1">
            You can carry straight on — restoring is only needed if a built-in
            is missing or has been changed beyond repair.
          </p>
        </Notice>
      ) : (
        <Notice tone="warning">
          There are no boards at all yet, so there is nothing a screen could
          show. Restore the built-ins below, or author your own on the Visual
          builder first.
        </Notice>
      )}

      <div className="space-y-2">
        <ViewOnlyActionButton
          canEdit={helpers.canEdit}
          describeReason={!ancestorRendersViewOnlyBanner}
          variant="outline"
          onClick={() => void run()}
        >
          {running ? "Restoring…" : "Restore built-in boards"}
        </ViewOnlyActionButton>
        <p className="text-xs text-muted-foreground">
          Runs the same audited action as the Templates page, and states exactly
          what it overwrites before it runs.
        </p>
      </div>
      {confirmDialog}
      {message ? <Notice tone="info">{message}</Notice> : null}

      <p className="text-sm text-muted-foreground">
        Want something of your own instead?{" "}
        {/* Hard navigation: the builder's Live preview depends on a
            route-scoped `frame-src 'self'` relaxation that a soft <Link> would
            not pick up (#2246). */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the hard load is the point; see above. */}
        <a
          href="/admin/display/builder"
          className="font-medium underline underline-offset-4"
        >
          Open the Visual builder
        </a>{" "}
        — it writes a valid Layout and Template for you, then come back here.
      </p>
    </StepShell>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — pick the board (+ preview)
// ---------------------------------------------------------------------------

export function BoardStep({
  context,
  helpers,
  chosenTemplateId,
  onChoose,
  onSelectLodge,
}: StepProps & {
  chosenTemplateId: string | null;
  onChoose: (templateId: string) => void;
  onSelectLodge: (lodgeId: string) => void;
}) {
  const bound = boundTemplateId(context);
  const boundTemplate = context.templates.find((t) => t.id === bound) ?? null;
  const chosen =
    context.templates.find((t) => t.id === chosenTemplateId) ?? boundTemplate;

  return (
    <StepShell
      heading="Pick the board for the TV"
      intro={`${DISPLAY_TERM_BOARD.oneLiner} Start with a built-in — you can switch or customise later without re-pairing.`}
    >
      {isLodgeUnresolved(context) ? <LodgeUnresolvedNotice /> : null}

      {context.lodges.length > 1 ? (
        <div className="max-w-sm space-y-1">
          <Label htmlFor="wizard-lodge">Setting up the screen for</Label>
          <select
            id="wizard-lodge"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={context.lodgeId ?? ""}
            onChange={(event) => onSelectLodge(event.target.value)}
          >
            {context.lodges.map((lodge) => (
              <option key={lodge.id} value={lodge.id}>
                {lodge.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            The board is rendered for whichever lodge the screen is paired to,
            so the preview and the lodge details below follow this choice.
          </p>
        </div>
      ) : null}

      {context.templates.length === 0 ? (
        <Notice tone="warning">
          There are no boards to choose from yet — go back a step and restore
          the built-ins.
        </Notice>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {context.templates.map((template) => (
            <BoardTile
              key={template.id}
              template={template}
              selected={chosen?.id === template.id}
              isBound={bound === template.id}
              onChoose={() => onChoose(template.id)}
            />
          ))}
        </ul>
      )}

      {chosen ? (
        <div className="space-y-2">
          <p className="text-sm">
            The TV will be set to show <strong>{chosen.name}</strong> when you
            pair it, two steps from now. Nothing is bound yet, so browsing here
            changes nothing on any screen.
          </p>
          {/* The sandboxed preview lives on its own page because `frame-src
              'self'` is granted per-route by design (#2246/#2279) — widening it
              to this page to inline the same iframe would relax the policy for
              a whole extra admin surface. Opening in a new tab keeps the wizard
              exactly where it is. */}
          <a
            href={`/admin/display/preview?templateId=${encodeURIComponent(
              chosen.id,
            )}&templateName=${encodeURIComponent(chosen.name)}${
              context.lodgeId
                ? `&previewLodge=${encodeURIComponent(context.lodgeId)}`
                : ""
            }`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
          >
            Preview {chosen.name} as it will look on the TV
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </div>
      ) : null}

      {bound ? (
        <Notice tone="success">
          <Check className="mr-1 inline h-4 w-4" aria-hidden />A screen for this
          lodge is already showing{" "}
          <strong>{boundTemplate?.name ?? "a board"}</strong>.
        </Notice>
      ) : (
        <p className="text-xs text-muted-foreground">
          This step only ticks once a screen is actually showing the board,
          which happens when you pair the TV. Use <strong>Skip for now</strong>{" "}
          to carry your choice forward and keep going.
        </p>
      )}
      {helpers.acknowledged ? (
        <p className="text-xs text-warning-11">
          Skipped for now — it will tick itself once the TV is paired.
        </p>
      ) : null}
    </StepShell>
  );
}

function BoardTile({
  template,
  selected,
  isBound,
  onChoose,
}: {
  template: DisplayWizardTemplate;
  selected: boolean;
  isBound: boolean;
  onChoose: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onChoose}
        aria-pressed={selected}
        className={`flex min-h-16 w-full flex-col items-start gap-1 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
          selected
            ? "border-primary bg-accent"
            : "border-border hover:bg-accent"
        }`}
      >
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {template.name}
          {isBound ? <Badge variant="success">On the screen</Badge> : null}
          {selected && !isBound ? (
            <Badge variant="secondary">Chosen</Badge>
          ) : null}
        </span>
        <span className="text-xs text-muted-foreground">
          Built on the {template.layout.name} layout
          {template.deviceCount > 0
            ? ` · used by ${template.deviceCount} screen${
                template.deviceCount === 1 ? "" : "s"
              }`
            : ""}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — lodge details quick-set
// ---------------------------------------------------------------------------

/**
 * The handful of `{{config:…}}` keys the built-in boards actually reference, so
 * a first-time operator fills in the ones that would otherwise render as a
 * visible `⟨config:key?⟩` placeholder on the wall. Anything beyond these is
 * edited on the lodge's full display settings, which this step links out to
 * (owner decision, 29 Jul 2026: quick-set here, full editors linked).
 */
export const DISPLAY_QUICK_SET_FIELDS: Array<{
  key: string;
  label: string;
  hint: string;
}> = [
  {
    key: "wifi-name",
    label: "Wi-Fi network name",
    hint: "Shown as {{config:wifi-name}}.",
  },
  {
    key: "wifi-code",
    label: "Wi-Fi password",
    hint: "Shown as {{config:wifi-code}} — it is on a public wall, so use the guest network.",
  },
  {
    key: "checkout-time",
    label: "Checkout time",
    hint: "Shown as {{config:checkout-time}}, e.g. “midday” — the lodge handover is midday to midday.",
  },
  {
    key: "door-code",
    label: "Door code",
    hint: "Shown as {{config:door-code}}. Leave blank if the code should not be on a public screen.",
  },
];

export function ConfigStep({
  context,
  helpers,
  ancestorRendersViewOnlyBanner = false,
}: StepProps) {
  const saved = context.lodgeConfig;
  const [values, setValues] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Re-seed the form whenever the loaded lodge changes (including a lodge swap
  // on step 3). Local edits are intentionally discarded then: they belong to the
  // lodge they were typed against.
  const seedKey = `${saved?.lodgeId ?? ""}`;
  useEffect(() => {
    setValues(saved?.displayConfig ?? {});
    setNotice(saved?.displayNotice ?? "");
    setMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const extraKeys = useMemo(
    () =>
      savedConfigKeys(context).filter(
        (key) => !DISPLAY_QUICK_SET_FIELDS.some((field) => field.key === key),
      ),
    [context],
  );

  async function save() {
    if (!saved) return;
    setBusy(true);
    setMessage(null);
    // Send the FULL config object: the route replaces `displayConfig` wholesale,
    // so posting only the quick-set keys would delete every other key the lodge
    // has. `values` starts from the saved record for exactly this reason.
    const displayConfig: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value.trim() !== "") displayConfig[key] = value;
    }
    const response = await fetch("/api/admin/display/lodge-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lodgeId: saved.lodgeId,
        displayConfig,
        displayNotice: notice.trim() === "" ? null : notice,
      }),
    }).catch(() => null);
    setBusy(false);

    if (response?.status === 403) {
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (!response?.ok) {
      const body = (await response?.json().catch(() => null)) as {
        error?: string;
      } | null;
      setMessage(body?.error ?? "Could not save the lodge display details.");
      return;
    }
    setMessage("Saved. The screens pick this up on their next refresh.");
    helpers.refresh();
  }

  return (
    <StepShell
      heading="Fill in the details the boards show"
      intro="Boards print these values through {{config:…}} tokens. A value that is missing shows as a visible placeholder on the wall, so it is worth doing before the TV goes up."
    >
      {isLodgeUnresolved(context) ? (
        <LodgeUnresolvedNotice />
      ) : !saved ? (
        <Notice tone="warning">
          The lodge&apos;s display settings could not be read, so there is
          nothing to fill in here yet. Finish step 1 (the module gates this
          read), then come back.
        </Notice>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Editing <strong>{saved.lodgeName}</strong>.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {DISPLAY_QUICK_SET_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={`config-${field.key}`}>{field.label}</Label>
                <Input
                  id={`config-${field.key}`}
                  value={values[field.key] ?? ""}
                  maxLength={500}
                  disabled={helpers.canEdit !== true}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">{field.hint}</p>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <Label htmlFor="config-notice">Notice on the screen</Label>
            <Textarea
              id="config-notice"
              value={notice}
              maxLength={2000}
              rows={3}
              disabled={helpers.canEdit !== true}
              onChange={(event) => setNotice(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Optional. Most built-in boards carry a notice area; leave it blank
              and the area simply stays empty.
            </p>
          </div>

          {extraKeys.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              This lodge also has {extraKeys.length} other saved value
              {extraKeys.length === 1 ? "" : "s"} ({extraKeys.join(", ")}). They
              are kept exactly as they are; edit them on the lodge&apos;s
              display settings.
            </p>
          ) : null}

          {/* The one case where "kept exactly as they are" would be a lie: a
              value in the JSON column that is not text. The save route accepts
              text only and replaces the whole object, so such a value cannot
              survive this form either way — say so before the operator presses
              Save, rather than dropping it quietly (#2249 review L7). */}
          {saved.unrepresentableConfigKeys.length > 0 ? (
            <Notice tone="warning">
              <p className="font-medium" data-testid="unrepresentable-config">
                {saved.unrepresentableConfigKeys.length} saved value
                {saved.unrepresentableConfigKeys.length === 1 ? " is" : "s are"}{" "}
                not text ({saved.unrepresentableConfigKeys.join(", ")}).
              </p>
              <p className="mt-1" data-testid="unrepresentable-config-effect">
                Boards can only print text, and this form can only save text, so
                saving here would <strong>remove</strong> those values. If you
                need them, copy them somewhere first, or fix them on the
                lodge&apos;s full display settings — and skip this step.
              </p>
            </Notice>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <ViewOnlyActionButton
              canEdit={helpers.canEdit}
              describeReason={!ancestorRendersViewOnlyBanner}
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save lodge details"}
            </ViewOnlyActionButton>
            <Link
              href={`/admin/lodges/${saved.lodgeId}/display`}
              className="text-sm font-medium underline underline-offset-4"
            >
              Open the full display settings for this lodge
            </Link>
          </div>
          {message ? <Notice tone="info">{message}</Notice> : null}
        </>
      )}
    </StepShell>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — pair the TV
// ---------------------------------------------------------------------------

export function PairStep({
  context,
  helpers,
  chosenTemplateId,
  onChoose,
  ancestorRendersViewOnlyBanner = false,
}: StepProps & {
  chosenTemplateId: string | null;
  /** Set (or change) the board the screen will be bound to at pairing. */
  onChoose: (templateId: string) => void;
}) {
  // #2264 — the suggested screen name moves under the field. Parked inside the
  // box it read as a name already chosen, and it vanished on the first
  // keystroke; the interpolated lodge name is carried across unchanged.
  // Pairing expiry and last-seen are real INSTANTS (CT-4, #2870).
  const clubTime = useClubTime();
  const deviceNameHint = useFieldHint();
  const [deviceName, setDeviceName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [bindWarning, setBindWarning] = useState<string | null>(null);
  const [armedLocally, setArmedLocally] = useState(false);
  const [forceNewDevice, setForceNewDevice] = useState(false);
  const [displayUrl, setDisplayUrl] = useState("");

  // The screen record THIS step created. Held in STATE (not a ref) because the
  // render reads it too, and a ref read during render is both a lint error and a
  // real staleness hazard. Without it every retry after a failed pairing POSTed
  // another device: the context list has not refreshed yet, and the local
  // `pending` lookup was per-render — a mistyped code three times left three
  // half-created screens (#2249 review M1).
  const [createdDeviceId, setCreatedDeviceId] = useState<string | null>(null);

  useEffect(() => {
    setDisplayUrl(`${window.location.origin}/display`);
  }, []);

  const live = liveDevicesForLodge(context);
  const lodgeUnresolved = isLodgeUnresolved(context);
  const lodgeName =
    context.lodgeConfig?.lodgeName ??
    context.lodges.find((lodge) => lodge.id === context.lodgeId)?.name ??
    "this lodge";
  const chosen =
    context.templates.find((t) => t.id === chosenTemplateId) ?? null;
  const bound = boundTemplateId(context);

  // The device for this lodge that is awaiting pairing, if any: the wizard
  // creates ONE and re-arms it, so a mistyped code does not litter the club with
  // half-created screens. Never adopts a device at another lodge — an unresolved
  // lodge yields null rather than "anyone's screen" (#2249 review M4).
  //
  // A screen created BY this step always wins over the generic lookup, so
  // "create a new screen instead" cannot silently hand the next press back to
  // the older pending row it was chosen to leave alone.
  const pendingForLodge = pendingDeviceForLodge(context);
  const createdPending = createdDeviceId
    ? (context.devices.find(
        (device) =>
          device.id === createdDeviceId && !device.paired && !device.revoked,
      ) ?? null)
    : null;
  const pending = createdPending ?? (forceNewDevice ? null : pendingForLodge);

  // Once the screen this step created is paired (or has been revoked), forget
  // it: the next press is a new job, and re-arming a live screen from here would
  // be a surprise.
  useEffect(() => {
    if (!createdDeviceId) return;
    const row = context.devices.find((device) => device.id === createdDeviceId);
    if (row && (row.paired || row.revoked)) setCreatedDeviceId(null);
  }, [context.devices, createdDeviceId]);

  // Re-reading server truth while the code is armed is what makes this step tick
  // over on its own: the TV claims its token on its own ~4-second poll, and
  // nothing else in this page would notice (#2249 review H1).
  const armedFromServer = pending?.pairingArmedUntil != null;
  const waiting =
    !lodgeUnresolved && live.length === 0 && (armedFromServer || armedLocally);
  const { polling, exhausted, checkAgain } = useWaitForScreen(
    waiting,
    helpers.refresh,
  );

  // A resume (or a reload) loses the pick made on step 3 — it is component
  // state, by design, because nothing server-side records a chosen board before
  // it is bound. Rather than quietly pairing onto the club default and then
  // reporting "Screen live", the pick is offered again here; and when the club
  // has exactly one board there is nothing to choose, so it is seeded (#2249
  // review M3).
  const needsBoardPick =
    !lodgeUnresolved &&
    chosenTemplateId === null &&
    bound === null &&
    context.templates.length > 0;
  const onlyTemplateId =
    context.templates.length === 1 ? context.templates[0].id : null;
  useEffect(() => {
    if (needsBoardPick && onlyTemplateId) onChoose(onlyTemplateId);
  }, [needsBoardPick, onlyTemplateId, onChoose]);

  // Re-using a pending device that is already bound to a DIFFERENT board would
  // silently repurpose it. Disclose it, and offer the other choice (#2249
  // review M2).
  const overwriting =
    pending &&
    pending.templateId !== null &&
    chosenTemplateId !== null &&
    pending.templateId !== chosenTemplateId
      ? { from: pending.templateName ?? "another board", to: chosen?.name }
      : null;

  async function pair() {
    setBusy(true);
    setMessage(null);
    setBindWarning(null);
    // The row this step created wins: a retry must re-arm THAT screen, even
    // before the device list has caught up with it.
    let deviceId = createdDeviceId ?? pending?.id ?? null;
    let createdNow = false;

    if (!deviceId) {
      const created = await fetch("/api/admin/display/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: deviceName.trim() || `Lobby TV — ${lodgeName}`,
          ...(context.lodgeId ? { lodgeId: context.lodgeId } : {}),
        }),
      }).catch(() => null);
      if (created?.status === 403) {
        setBusy(false);
        setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!created?.ok) {
        const body = (await created?.json().catch(() => null)) as {
          error?: string;
        } | null;
        setBusy(false);
        setMessage(body?.error ?? "Could not create the screen record.");
        return;
      }
      const body = (await created.json()) as { device?: { id: string } };
      deviceId = body.device?.id ?? null;
      createdNow = deviceId !== null;
      // Remember it BEFORE anything else can fail, so a retry re-arms this row.
      setCreatedDeviceId(deviceId);
      if (forceNewDevice) setForceNewDevice(false);
    }

    if (!deviceId) {
      setBusy(false);
      setMessage("Could not create the screen record.");
      return;
    }

    // Bind the chosen board BEFORE arming pairing, so the screen shows the right
    // board the moment it claims its token rather than flashing the club default.
    // The response is checked: a silent failure here used to leave the step
    // promising a board the screen was never bound to (#2249 review M2).
    let bindFailed = false;
    if (chosenTemplateId) {
      const bindResponse = await fetch(
        `/api/admin/display/devices/${deviceId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ templateId: chosenTemplateId }),
        },
      ).catch(() => null);
      if (!bindResponse?.ok) {
        bindFailed = true;
        const body = (await bindResponse?.json().catch(() => null)) as {
          error?: string;
        } | null;
        setBindWarning(
          bindResponse?.status === 403
            ? `${ADMIN_FORBIDDEN_SAVE_REASON} The screen was not set to show ${
                chosen?.name ?? "the board you picked"
              }.`
            : bindResponse === null
              ? /*
                  #2668. A rejected `fetch` is not a refusal: the PATCH may have
                  bound the board and lost only its answer. The old wording went
                  straight on to say the screen "will come up on the club
                  default board", which is a statement about the stored binding
                  this side cannot make — and it is wrong precisely when the
                  bind DID land. Say what is unknown, and send them to the page
                  that holds the answer. Setting the board there again is safe.
                */
                `${unverifiedWriteMessage(
                  `this screen was set to show ${chosen?.name ?? "the board you picked"}`,
                  "Pairing carried on either way.",
                )} Check the screen's board on the Devices page.`
              : `${
                  body?.error ?? "The board could not be assigned to this screen."
                } Pairing carried on, so the screen will come up on ${
                  pending?.templateName ?? "the club default board"
                } — set the board on the Devices page.`,
        );
      }
    }

    const armed = await fetch(
      `/api/admin/display/devices/${deviceId}/pairing`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      },
    ).catch(() => null);
    setBusy(false);

    // Whatever happens next, the list must catch up: a device created moments
    // ago has to appear as THE pending screen so a retry re-arms it rather than
    // creating another one.
    if (createdNow || bindFailed) helpers.refresh();

    if (armed?.status === 403) {
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (armed?.status === 429) {
      setMessage(
        "Too many pairing attempts. Wait a minute, then read the code off the TV again — it changes when it expires.",
      );
      return;
    }
    if (!armed?.ok) {
      const body = (await armed?.json().catch(() => null)) as {
        error?: string;
      } | null;
      setMessage(
        body?.error ??
          "That code was not accepted. Check the six characters on the TV and try again.",
      );
      return;
    }

    setCode("");
    setArmedLocally(true);
    setMessage(
      "Code accepted. The screen claims its own token on its next check, about four seconds away — leave this page open and it ticks over by itself.",
    );
    helpers.refresh();
  }

  return (
    <StepShell
      heading="Pair the lodge TV"
      intro="Pairing survives reboots — you do this once per screen, until you revoke it."
    >
      {lodgeUnresolved ? (
        <LodgeUnresolvedNotice />
      ) : (
        <>
          <ol className="space-y-4 text-sm">
            <li className="space-y-2">
              <p className="font-medium">
                1. On the TV (or any browser on the screen device), open this
                address:
              </p>
              <CopyField
                label="Display URL"
                value={displayUrl}
                emptyHint="Loading the address…"
              />
            </li>
            <li className="space-y-2">
              <p className="font-medium">
                2. The screen shows a six-character pairing code. Type it here:
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="pair-code">Code on the TV</Label>
                  <Input
                    id="pair-code"
                    value={code}
                    maxLength={16}
                    autoComplete="off"
                    className="w-40 font-mono uppercase"
                    disabled={helpers.canEdit !== true}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </div>
                {!pending ? (
                  <div className="space-y-1">
                    <Label htmlFor="pair-name">Name this screen</Label>
                    <Input
                      id="pair-name"
                      value={deviceName}
                      disabled={helpers.canEdit !== true}
                      onChange={(event) => setDeviceName(event.target.value)}
                      {...deviceNameHint.fieldProps}
                    />
                    <FieldHint {...deviceNameHint.hintProps}>
                      {`Example: Lobby TV — ${lodgeName}`}
                    </FieldHint>
                  </div>
                ) : null}
                <ViewOnlyActionButton
                  canEdit={helpers.canEdit}
                  describeReason={!ancestorRendersViewOnlyBanner}
                  disabled={busy || code.trim() === ""}
                  onClick={() => void pair()}
                >
                  {busy ? "Pairing…" : "Pair this screen"}
                </ViewOnlyActionButton>
              </div>

              {needsBoardPick ? (
                <div className="max-w-sm space-y-1">
                  <Label htmlFor="pair-template">
                    Board this screen will show
                  </Label>
                  <select
                    id="pair-template"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value=""
                    disabled={helpers.canEdit !== true}
                    onChange={(event) => {
                      if (event.target.value) onChoose(event.target.value);
                    }}
                  >
                    <option value="">Choose a board…</option>
                    {context.templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    The choice made on <strong>Pick the board</strong> is not
                    saved anywhere until a screen is paired to it, so it is asked
                    for again here after a reload. Leave it unchosen and the
                    screen comes up on the club default board.
                  </p>
                </div>
              ) : null}

              <p className="text-xs text-muted-foreground">
                {pending
                  ? `Pairing “${pending.name}”, already created for ${lodgeName}.`
                  : `A screen record is created for ${lodgeName} the first time you press Pair.`}
                {/* Silent while a bind has just failed: the warning below says
                    what the screen will actually show, and repeating the promise
                    here would contradict it (#2249 review M2). */}
                {bindWarning
                  ? ""
                  : chosen
                    ? ` It will be set to show ${chosen.name}.`
                    : " It will show the club default board until you assign one."}
              </p>

              {overwriting ? (
                <Notice tone="warning">
                  <p className="font-medium">
                    “{pending?.name}” is already set to show{" "}
                    {overwriting.from}.
                  </p>
                  <p className="mt-1">
                    Pairing here re-uses that screen record and changes it to{" "}
                    <strong>{overwriting.to}</strong>. If it is a different TV,
                    create a second screen instead — nothing is changed until you
                    press Pair.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => setForceNewDevice(true)}
                  >
                    Create a new screen instead
                  </Button>
                </Notice>
              ) : null}

              {forceNewDevice && pendingForLodge ? (
                <p className="text-xs text-muted-foreground">
                  A new screen record will be created;{" "}
                  “{pendingForLodge.name}” is left exactly as it is.{" "}
                  <button
                    type="button"
                    className="font-medium underline underline-offset-4"
                    onClick={() => setForceNewDevice(false)}
                  >
                    Use that screen after all
                  </button>
                  .
                </p>
              ) : null}
            </li>
          </ol>

          {bindWarning ? <Notice tone="warning">{bindWarning}</Notice> : null}
          {message ? <Notice tone="info">{message}</Notice> : null}

          {waiting ? (
            <Notice tone="info">
              <p className="font-medium" data-testid="pairing-armed">
                <Badge variant="outline" className="mr-2">
                  Pairing armed
                </Badge>
                Waiting for the screen to claim it
                {pending?.pairingArmedUntil
                  ? ` — the code stops working at ${clubTime.instantTime(
                      requireInstant(pending.pairingArmedUntil),
                    )}`
                  : ""}
                .
              </p>
              <p className="mt-1">
                {exhausted
                  ? "Nothing has claimed the code yet. Check the TV is still on the display page, then check again — if the code on screen has changed, enter the new one."
                  : "The TV checks every few seconds, so this normally takes moments."}
              </p>
              <div className="mt-2">
                <CheckAgainButton
                  polling={polling}
                  onCheckAgain={checkAgain}
                />
              </div>
            </Notice>
          ) : null}

          {live.length > 0 ? (
            <Notice tone="success">
              <p className="font-medium">
                <Check className="mr-1 inline h-4 w-4" aria-hidden />
                {live.length} screen{live.length === 1 ? " is" : "s are"} paired
                for {lodgeName}.
              </p>
              <ul className="mt-1 space-y-0.5">
                {live.map((device) => (
                  <li key={device.id}>
                    {device.name} — showing{" "}
                    {device.templateName ?? "the club default board"}
                    {device.lastSeenAt
                      ? `, last seen ${clubTime.instantDateTime(requireInstant(device.lastSeenAt))}`
                      : ", not seen yet"}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <p className="text-sm text-muted-foreground">
            Managing several screens, or need to revoke one?{" "}
            <Link
              href="/admin/display/devices"
              className="font-medium underline underline-offset-4"
            >
              Open the Devices page
            </Link>
            .
          </p>
        </>
      )}
    </StepShell>
  );
}

// ---------------------------------------------------------------------------
// Step 6 — done
// ---------------------------------------------------------------------------

export function DoneStep({ context, helpers }: StepProps) {
  const clubTime = useClubTime();
  const live = liveDevicesForLodge(context);
  const seen = live.filter((device) => device.lastSeenAt !== null);
  const lodgeUnresolved = isLodgeUnresolved(context);

  // The last thing the wizard waits for is written by the TV, not by this page:
  // `lastSeenAt` is stamped when the screen first fetches its board. Poll while
  // that has not happened, so the step ticks over on its own as the copy says
  // (#2249 review H1).
  const { polling, exhausted, checkAgain } = useWaitForScreen(
    !lodgeUnresolved && seen.length === 0,
    helpers.refresh,
  );

  return (
    <StepShell
      heading="Done — and how to check it stays done"
      intro="This step ticks when a paired screen has actually fetched its board with its own token. That is the only proof the whole path works, rather than just the admin half of it."
    >
      {lodgeUnresolved ? (
        <LodgeUnresolvedNotice />
      ) : seen.length > 0 ? (
        <Notice tone="success">
          <p className="font-medium">
            <Check className="mr-1 inline h-4 w-4" aria-hidden />
            {seen.length === 1
              ? `${seen[0].name} is live`
              : `${seen.length} screens are live`}
            .
          </p>
          <ul className="mt-1 space-y-0.5">
            {seen.map((device) => (
              <li key={device.id}>
                {device.name} — showing{" "}
                {device.templateName ?? "the club default board"}, last seen{" "}
                {clubTime.instantDateTime(requireInstant(device.lastSeenAt as string))}
              </li>
            ))}
          </ul>
        </Notice>
      ) : live.length > 0 ? (
        <Notice tone="warning">
          <p>
            The screen is paired but has not fetched anything yet. Leave the TV
            on the display page:{" "}
            {polling
              ? "this page is re-reading your screens every few seconds and ticks itself over when the screen checks in."
              : "press Check again to look now."}{" "}
            {exhausted
              ? "Nothing has checked in for a couple of minutes, so the screen may have no route to this server."
              : "Screens fetch on their own refresh interval, so this usually takes under a minute."}
          </p>
          <div className="mt-2">
            <CheckAgainButton polling={polling} onCheckAgain={checkAgain} />
          </div>
        </Notice>
      ) : (
        <Notice tone="warning">
          <p>No screen is paired yet — go back a step and pair one.</p>
          <div className="mt-2">
            <CheckAgainButton polling={polling} onCheckAgain={checkAgain} />
          </div>
        </Notice>
      )}

      <div className="space-y-1 text-sm">
        <p className="font-medium text-foreground">
          Where things live from here
        </p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <Link
              href="/admin/display/devices"
              className="underline underline-offset-4"
            >
              Devices
            </Link>{" "}
            — swap a screen&apos;s board, change how often it refreshes, revoke
            a screen that has left the building.
          </li>
          <li>
            {/* Hard navigation for the builder's route-scoped CSP (#2246). */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the hard load is the point; see above. */}
            <a
              href="/admin/display/builder"
              className="underline underline-offset-4"
            >
              Visual builder
            </a>{" "}
            — change what a board shows, or make a new one.
          </li>
          {/* Only when the lodge is known: the href degraded to
              /admin/lodges//display — a dead link — whenever the config read had
              failed (#2249 review L6). */}
          {context.lodgeConfig ? (
            <li>
              <Link
                href={`/admin/lodges/${context.lodgeConfig.lodgeId}/display`}
                className="underline underline-offset-4"
              >
                Lodge display settings
              </Link>{" "}
              — the full set of values the boards print, plus the name-privacy
              setting.
            </li>
          ) : null}
        </ul>
      </div>

      <p className="text-sm text-muted-foreground">
        You can re-run this wizard any time — after a TV is replaced, for
        instance. It always reads the real state of your club, so nothing is
        undone by opening it again.
      </p>
    </StepShell>
  );
}
