"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import {
  BUILT_IN_DISPLAY_LAYOUTS,
  BUILT_IN_DISPLAY_TEMPLATES,
} from "@/lib/lodge-display/built-in-seeds";
import { unverifiedWriteMessage } from "@/lib/unverified-write-copy";

// "Restore built-in boards" + the honest empty state for the Templates gallery
// (#2247). The behaviour lives here rather than in `templates/page.tsx` so that
// (already large) page takes a small diff — #2248 rewrites it next — and so the
// empty-state reasoning can be unit-tested on its own.
//
// The built-in boards are created ONLY by the database seed, and no deploy or
// upgrade path re-runs the seed, so a club whose database predates the
// lobby-display feature has no built-in rows at all: the gallery is empty, says
// nothing, and offers no way out. This is the way out.

const LAYOUT_COUNT = BUILT_IN_DISPLAY_LAYOUTS.length;
const TEMPLATE_COUNT = BUILT_IN_DISPLAY_TEMPLATES.length;

/**
 * Why the templates list is empty, as far as the BROWSER can honestly tell.
 *
 * The causes are told apart by the status the templates GET returns, because
 * that response is the only evidence this page has:
 *  • `unreachable` — the fetch itself failed, so there is no status. Without
 *    this the page sat on "Loading…" for ever, which is the very blank screen
 *    this issue exists to remove.
 *  • `signed-out` — 401. Retained because the mapping is a pure function that
 *    any caller may reuse, but `/api/admin/display/*` is module-gated, and a
 *    gated route answers an anonymous caller with 404 rather than 401 (see
 *    `moduleGatedNotFoundResponse` in `src/lib/session-guards.ts`) so that a
 *    single anonymous probe cannot read which optional modules a club runs.
 *    This page therefore lands in `module-off` for an expired session too.
 *  • `forbidden` — 403 from the route's `lodge:view` guard. The browser is told
 *    only that the request was refused, never WHICH permission was missing, so
 *    the copy names the likely cause and says how it was inferred instead of
 *    asserting a role state it cannot read.
 *  • `module-off` — 404, and the ambiguity is deliberate rather than a gap. All
 *    of `/api/admin/display/*` answers 404 while the `lobbyDisplay` module is
 *    off (and it is off by default), and an expired session on the same gated
 *    address answers the same 404 on purpose. The page cannot tell them apart
 *    and must not guess, so the copy names both and gives the one action that
 *    settles it — sign in again and reload — before the module switch.
 *  • `loaded` — the list came back fine. If it is ALSO empty, that is the
 *    never-seeded case the restore action fixes.
 *  • `error` — anything else, named as unknown rather than blamed on a guess.
 */
export type TemplatesLoadState =
  | "loading"
  | "loaded"
  | "unreachable"
  | "signed-out"
  | "module-off"
  | "forbidden"
  | "error";

/**
 * Map the templates GET status to the load state. Pass `0` (the shape a failed
 * fetch is normalised to) when no response was produced at all.
 */
export function templatesLoadStateForStatus(
  status: number
): TemplatesLoadState {
  if (status === 401) return "signed-out";
  if (status === 403) return "forbidden";
  if (status === 404) return "module-off";
  if (status >= 200 && status < 300) return "loaded";
  if (status < 100) return "unreachable";
  return "error";
}

/**
 * Whether to offer the restore at all.
 *
 * In `module-off`, `forbidden`, `signed-out` and `unreachable` the POST would
 * fail by construction — the same proxy, guard or transport that refused the
 * list refuses the restore — and the empty-state copy tells the operator to do
 * something else first. Offering a button that cannot work would contradict it.
 */
export function shouldOfferBuiltInRestore(state: TemplatesLoadState): boolean {
  return state === "loaded";
}

/**
 * The gallery's empty state. Rendered only when the list came back with nothing
 * in it; `state` says which of the causes above produced that.
 */
export function DisplayTemplatesEmptyState({
  state,
  canEdit,
}: {
  state: TemplatesLoadState;
  /** Tri-state (#2065): `undefined` while the session is still resolving. */
  canEdit: boolean | undefined;
}) {
  if (state === "loading") return null;

  if (state === "unreachable") {
    return (
      <EmptyStateBox heading="The templates list could not be fetched.">
        The request never reached the server, so this is a connection problem
        rather than anything about your club&apos;s boards. Check the network
        and reload the page.
      </EmptyStateBox>
    );
  }

  if (state === "signed-out") {
    return (
      <EmptyStateBox heading="Your session has expired.">
        The templates list returned <strong>401 Unauthorised</strong>. Sign in
        again and reopen this page — nothing is wrong with the boards
        themselves.
      </EmptyStateBox>
    );
  }

  if (state === "module-off") {
    return (
      <EmptyStateBox heading="Your sign-in may have expired, or the Lobby TV display module is switched off.">
        The templates list returned <strong>404 Not found</strong>. Every{" "}
        <code className="bg-muted rounded px-1">/admin/display</code> address
        answers that way both while the module is off — and it is off by
        default — and when the sign-in behind an open tab has expired, so this
        page cannot tell you which it is. Sign in again (another tab is fine)
        and reload. If it still says this, turn{" "}
        <strong>Lobby TV display</strong> on under{" "}
        <strong>Admin → Setup → Modules</strong>.
      </EmptyStateBox>
    );
  }

  if (state === "forbidden") {
    return (
      <EmptyStateBox heading="Your admin role can’t see the display templates.">
        The templates list returned <strong>403 Forbidden</strong>. That is what
        a missing <strong>lodge view</strong> permission looks like from here —
        the browser is told only that the request was refused, not which
        permission was missing — so if your role does have lodge access, ask an
        administrator to check the server log for the real reason. Templates are
        club-wide, so this is never about which lodge you can see.
      </EmptyStateBox>
    );
  }

  if (state === "error") {
    return (
      <EmptyStateBox heading="The templates list could not be loaded.">
        The server did not say why. Reload the page; if it keeps happening, the
        server log for{" "}
        <code className="bg-muted rounded px-1">
          /api/admin/display/templates
        </code>{" "}
        will have the reason.
      </EmptyStateBox>
    );
  }

  // state === "loaded": the list loaded fine and there is genuinely nothing in
  // it — the never-seeded case.
  return (
    <EmptyStateBox heading="No display templates yet — not even the built-in boards.">
      The {TEMPLATE_COUNT} built-in boards are created by the database seed, and
      upgrading the app does not re-run the seed — so a club whose database
      predates the lobby display starts with none.{" "}
      {canEdit === false ? (
        <>
          <strong>Restore built-in boards</strong> below would create them, but
          it is disabled for your role: restoring needs lodge edit access, so
          ask an administrator who has it to press it.
        </>
      ) : (
        <>
          Use <strong>Restore built-in boards</strong> below to create them.
        </>
      )}
    </EmptyStateBox>
  );
}

function EmptyStateBox({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="text-muted-foreground space-y-2 text-sm">
      <p className="text-foreground font-medium">{heading}</p>
      <p>{children}</p>
    </div>
  );
}

/**
 * Runs the convergent built-in re-seed behind an explicit confirmation.
 *
 * The confirmation is not ceremony: `ensureBuiltInDisplays` REWRITES every row
 * under a reserved built-in key to its shipped definition, so an operator who
 * edited a built-in in place — or imported a customised one through a
 * config-transfer bundle — loses that content. The dialog states all of that
 * before it runs (#2247), and the server audits the action.
 *
 * Returned as a hook rather than a button so the button itself stays a
 * `ViewOnlyActionButton` in `templates/page.tsx`, under that page's single
 * view-only banner (the same-file coverage rule in
 * `view-only-banner-contract.test.ts`).
 */
export function useRestoreBuiltInBoards(options: {
  /** `restored` is true only when the built-ins were actually re-seeded. */
  onResult: (message: string, restored: boolean) => void;
}): { run: () => Promise<void>; running: boolean; confirmDialog: ReactNode } {
  const { confirm, confirmDialog } = useConfirm();
  const [running, setRunning] = useState(false);
  // Re-entrancy is guarded HERE rather than by disabling the trigger. Radix
  // restores focus to the trigger as the dialog closes; a trigger disabled in
  // that same turn cannot take focus, so focus falls to <body> and a keyboard
  // user loses their place — the exact failure the house rules call out for
  // gated controls leaving the tab order. The button therefore stays enabled
  // and only its label changes, and a second press mid-flight is dropped here.
  const runningRef = useRef(false);
  const { onResult } = options;

  const run = useCallback(async () => {
    if (runningRef.current) return;

    const confirmed = await confirm({
      title: "Restore the built-in boards?",
      description:
        `This rewrites the ${LAYOUT_COUNT} built-in layouts and ` +
        `${TEMPLATE_COUNT} built-in templates back to the designs that ship ` +
        `with the app. Missing ones are created; anything already saved under ` +
        `one of the seven reserved built-in keys is OVERWRITTEN — including a ` +
        `built-in edited in place, and one customised by an imported ` +
        `configuration bundle. Layouts and templates under your own keys are ` +
        `not touched, though a board of yours built on a built-in LAYOUT will ` +
        `follow that layout's restored shape. Screens stay bound to whatever ` +
        `they already show.`,
      confirmLabel: "Restore built-in boards",
      destructive: true,
    });
    if (!confirmed) return;

    runningRef.current = true;
    setRunning(true);
    const response = await fetch("/api/admin/display/built-ins/restore", {
      method: "POST",
    }).catch(() => null);
    runningRef.current = false;
    setRunning(false);

    if (!response) {
      // #2668. This used to claim "Nothing was changed". A `fetch` that rejects
      // covers both "the POST never arrived" and "the POST ran and the answer
      // was lost", and this side cannot tell them apart. The restore itself IS
      // idempotent — it rewrites the reserved built-in keys back to the shipped
      // designs — so a second press is genuinely harmless, and that is the one
      // thing here worth stating as fact.
      onResult(
        unverifiedWriteMessage(
          "the built-in boards were restored",
          "Reload the page to see their current state. Restoring again is safe.",
        ),
        false
      );
      return;
    }
    if (response.status === 403) {
      onResult(ADMIN_FORBIDDEN_SAVE_REASON, false);
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      onResult(body?.error ?? "Could not restore the built-in boards.", false);
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { layouts?: number; templates?: number }
      | null;
    onResult(
      `Restored the built-in boards — ${body?.layouts ?? LAYOUT_COUNT} ` +
        `layouts and ${body?.templates ?? TEMPLATE_COUNT} templates now match ` +
        `the designs that ship with the app.`,
      true
    );
  }, [confirm, onResult]);

  return { run, running, confirmDialog };
}
