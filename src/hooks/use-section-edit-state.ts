"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import {
  ApiRefusalError,
  apiErrorMessageFromBody,
  readApiErrorBody,
  refusalMessageOr,
  wordedForbiddenRefusal,
} from "@/lib/api-error-message";
import { useEditorFocusReturn } from "@/hooks/use-editor-focus-return";
import {
  captureFocusReturn,
  useReturnAttention,
  type FocusReturnAnchor,
} from "@/hooks/use-scroll-to-feedback";

/**
 * Shared state for the canonical admin settings-section pattern (#2136).
 *
 * `AGENTS.md` makes the pattern binding for new or modified admin settings
 * sections: the section loads read-only, a per-section Edit reveals
 * Save/Cancel, no individual control auto-persists, Cancel reverts to the saved
 * snapshot, and Save persists once. Every card that implements it by hand ends
 * up re-deriving the same draft/snapshot pair, and the two details that are
 * easiest to get subtly wrong are exactly the ones this hook centralises:
 *
 *  1. Cancel must restore EVERY field from the snapshot. Hand-rolled cards do
 *     this field-by-field, so a field added later is easy to forget.
 *  2. Save must re-seed BOTH the draft and the snapshot from the AUTHORITATIVE
 *     value the server returned — never from the local draft. A server that
 *     clamps, normalises, or otherwise adjusts the submitted value would
 *     otherwise leave the card showing something the server never stored.
 *
 * What this hook deliberately does NOT own: the feedback presentation and its
 * clearing rules. Booking-policy sections render `<PolicyFeedback>` while the
 * security cards render `<Alert>`, and each card clears its messages at
 * slightly different moments (some on Edit, some on Cancel, some on neither).
 * Folding those differences in would have meant a boolean option per card, so
 * the hook only owns the one clearing rule every card already shares — both
 * messages are cleared at the start of a save — and exposes `setError` /
 * `setSuccess` so each card keeps its existing behaviour explicitly.
 *
 * What it DOES own is where focus goes when the editor opens and closes. Edit
 * unmounts the button that held focus, so `startEditing` moves focus into the
 * section once the editor has rendered — to the first control the edit made
 * editable, or to the card marked with `sectionRegionProps` when it made none
 * — with no wiring in the section (#4115).
 *
 * Save and
 * Cancel unmount the button that held focus, which dropped a keyboard user to
 * `<body>` (#4087). The hook records the focused element when `startEditing` runs and,
 * after Cancel or a successful save, hands focus back to it — or to the Edit
 * rendered in its place, found by `editTriggerProps`, or to the card marked
 * with `sectionRegionProps` and named by the title carrying `titleProps` —
 * through `useEditorFocusReturn`. That is where
 * focus ends after Cancel. After a successful save it is where focus ends
 * UNLESS the card also positions its success (`useActionAttention` with a
 * `successTarget`, as member fields does): that runs in the same commit, after
 * the return, and the success target is where the admin lands. A FAILED save
 * keeps edit mode open; if the disabled-while-saving Save dropped focus to the
 * page, focus goes back to the control that started the save, and any failure
 * position the card takes for its error still wins.
 *
 * What a failure SAYS is the section's choice, and it is made in one way only:
 * the hook shows an `ApiRefusalError`'s message (the route's own sentence, or a
 * sentence the section chose) and the section's `loadErrorFallback` /
 * `saveErrorFallback` for anything else. A request that never got an answer
 * rejects with the browser's own words — "Failed to fetch", Safari's "Load
 * failed" — and a JSON parse or code error carries an engine message; none of
 * those is a sentence for an officer, so a plain `Error` never reaches the
 * screen (#4976, ALP-650).
 *
 * The transport also stays in the caller's `save` callback, so idioms that are
 * genuinely per-card survive untouched: the security cards' GET-fresh-settings-
 * then-merge step (never clobber a module another card changed since page
 * load), multi-endpoint saves, and per-endpoint failure messages.
 *
 * Reference adopter: `src/components/admin/booking-policies/group-discount-section.tsx`.
 */

/**
 * Throw this from a `save` callback when the write was rejected with 403. The
 * hook maps it to the shared {@link ADMIN_FORBIDDEN_SAVE_REASON} copy, which is
 * the defence-in-depth case behind the UI gating (#1927): a stale tab still
 * showing live editors because the actor's permissions were narrowed after the
 * page loaded.
 */
export class ForbiddenSaveError extends Error {}

/**
 * Read a refused save into the error a `save` callback throws, parsing the
 * body once and never as text (ALP-749). A 403 keeps the route's own worded
 * refusal ("Two-factor verification required") and otherwise — the bare word
 * "Forbidden", or an HTML page from the proxy in front of the app — becomes a
 * {@link ForbiddenSaveError}. Any other status throws the route's sentence, or
 * `fallback` when the body carries none.
 */
export async function saveRefusalFromResponse(
  response: Response,
  fallback: string,
): Promise<Error> {
  const body = await readApiErrorBody(response);
  if (response.status === 403) {
    return wordedForbiddenRefusal(body) ?? new ForbiddenSaveError();
  }
  return new ApiRefusalError(apiErrorMessageFromBody(body, fallback));
}

/**
 * A section with a `load` must word its failure; one without has none to word.
 */
type LoadOptions<T> =
  | {
      /**
       * Fetch the persisted value. When provided it runs once on mount (and
       * again via `reload`), and `loading` starts `true`. The `AbortSignal` is
       * aborted on unmount; an `AbortError` is swallowed rather than surfaced
       * as an error.
       *
       * NOTE: this runs on mount only. A section whose fetch is keyed on some
       * other state (a lodge scope, say) must re-fetch through `reload` itself.
       *
       * Throw an `ApiRefusalError` for a sentence the officer should read;
       * anything else shows `loadErrorFallback`.
       */
      load: (signal: AbortSignal) => Promise<T>;
      /** Shown for a failed load that is not an `ApiRefusalError`. */
      loadErrorFallback: string;
    }
  | { load?: undefined; loadErrorFallback?: undefined };

export type UseSectionEditStateOptions<T extends object> = LoadOptions<T> & {
  /**
   * Seed value for props-seeded cards, and the value a card with a `load` falls
   * back to while (or after a failed) load. Omit it for cards that render
   * nothing until their fetch resolves — `draft` is then `null` until it does.
   */
  initial?: T;
  /**
   * Persist `draft` and return the AUTHORITATIVE value to re-seed both the
   * draft and the snapshot from — the parsed server response wherever the write
   * returns one. `saved` is the current snapshot, so a callback can skip an
   * endpoint whose slice of the draft did not change. Throw
   * {@link ForbiddenSaveError} for a 403 and an `ApiRefusalError` for a
   * sentence the officer should read; anything else shows `saveErrorFallback`.
   */
  save: (draft: T, saved: T | null) => Promise<T>;
  /** Success message, or a function of the saved value when it is conditional. */
  successMessage: string | ((saved: T) => string);
  /**
   * Shown for a failed save that is not an `ApiRefusalError` or a 403. Required.
   * The options are a union on `load`, so on a card with no `load` the compiler
   * words a forgotten `saveErrorFallback` as a missing `load`; this is the
   * property to add.
   */
  saveErrorFallback: string;
  /**
   * Override the dirty check. The default is a shallow comparison of the
   * draft's own keys, which is correct for flat scalar drafts; a draft holding
   * an array or nested object needs a deep comparator here.
   */
  isDirty?: (draft: T, saved: T) => boolean;
  /** Gate Save on draft validity. Defaults to always valid. */
  isValid?: (draft: T) => boolean;
  /**
   * Let Save run when the draft matches the snapshot. Defaults to `false`:
   * every card that currently uses this hook disables Save while pristine, so
   * an unchanged draft never re-PUTs.
   *
   * NO CURRENT ADOPTER SETS THIS. It is retained as a deliberate escape hatch
   * for a future card whose write endpoint is a meaningful action rather than a
   * state update — a "re-send", "re-sync", or "re-apply" whose whole point is to
   * fire again with identical input. Reach for it only in that case: for an
   * ordinary settings PUT, a pristine save writes a misleading audit entry and
   * busts caches for a change that never happened (#2143).
   */
  allowPristineSave?: boolean;
  /**
   * The section's name, for a card with no visible title of its own to point
   * `titleProps` at (#4087). Omit it everywhere else: the card is then named
   * by its title, so the two cannot drift.
   */
  regionLabel?: string;
  /**
   * Reveal this element on Edit instead of the first control the edit made
   * editable (#4115). It exists ONLY for the two sections whose card reveal
   * predates #4115 — allocation preferences and club identity, pinned by
   * `section-edit-focus-return-census.test.ts` — which focus and scroll to
   * their named card, as they did before. A new section omits it.
   */
  revealTarget?: RefObject<HTMLElement | null>;
};

export interface SectionEditState<T extends object> {
  /** Live form value. `null` only before a `load`-only section has resolved. */
  draft: T | null;
  /** Last persisted value, restored by `cancelEditing`. */
  saved: T | null;
  loading: boolean;
  saving: boolean;
  editing: boolean;
  /** Draft differs from the snapshot. `false` while either is `null`. */
  dirty: boolean;
  /** `isValid(draft)`, or `false` while `draft` is `null`. */
  valid: boolean;
  error: string;
  success: string;
  setError: (message: string) => void;
  setSuccess: (message: string) => void;
  /** Update the draft. Ignored while `draft` is `null`. */
  setDraft: (update: Partial<T> | ((current: T) => T)) => void;
  /**
   * Open the editor. Once it has rendered, focus moves to the first control it
   * made editable, or to the section — only for this explicit call, never
   * because the section re-rendered (#2934, #4115).
   */
  startEditing: () => void;
  /**
   * Restore every field from the snapshot and leave edit mode. Focus returns to
   * where `startEditing` was called from, as it does after a successful `save`.
   */
  cancelEditing: () => void;
  /**
   * Spread on the section's Edit control (#4087). Edit is unmounted while the
   * editor is open, so this per-instance marker is how the return finds the
   * one rendered in its place.
   */
  editTriggerProps: Record<"data-return-focus-trigger", string>;
  /**
   * Spread on the section's card: where Edit looks for the controls it made
   * editable, where focus goes when it made none, and where focus returns when
   * Edit is missing or disabled for a view-only admin. It makes the card a
   * `region` named by the
   * element carrying `titleProps` (or by `regionLabel`), so a keyboard user who
   * lands on it hears the section's name.
   */
  sectionRegionProps: {
    "data-return-focus-region": string;
    role: "region";
    "aria-label"?: string;
    "aria-labelledby"?: string;
  };
  /** Spread on the card's visible title: the name `sectionRegionProps` points at. */
  titleProps: { id: string };
  save: () => Promise<void>;
  /** Re-run `load`, clearing both messages first. No-op without a `load`. */
  reload: () => Promise<void>;
}

function shallowEqual<T extends object>(a: T, b: T) {
  if (Object.is(a, b)) return true;
  const aKeys = Object.keys(a) as (keyof T)[];
  const bKeys = Object.keys(b) as (keyof T)[];
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.is(a[key], b[key]));
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useSectionEditState<T extends object>(
  options: UseSectionEditStateOptions<T>,
): SectionEditState<T> {
  const { initial, allowPristineSave = false } = options;

  const [draft, setDraftState] = useState<T | null>(initial ?? null);
  const [saved, setSaved] = useState<T | null>(initial ?? null);
  const [loading, setLoading] = useState(Boolean(options.load));
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const editorFocus = useEditorFocusReturn({
    regionLabel: options.regionLabel,
    revealTarget: options.revealTarget,
  });
  // Where a FAILED save hands focus back to, recorded as the save starts.
  const saveFocusReturn = useRef<FocusReturnAnchor | null>(null);
  const [saveFailureKey, setSaveFailureKey] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Callbacks are held in a latest-ref so a caller does not have to memoise
  // them: the mount-time load must run exactly once regardless of the identity
  // churn of an inline arrow function. The ref is seeded at first render and
  // refreshed after every commit (this effect is declared before the load
  // effect, so it has already run by the time the load fires).
  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });

  const runLoad = useCallback(async (signal: AbortSignal) => {
    const options = callbacks.current;
    if (options.load === undefined) return;
    setLoading(true);
    try {
      const next = await options.load(signal);
      if (signal.aborted) return;
      setSaved(next);
      setDraftState(next);
      setEditing(false);
    } catch (loadError) {
      if (isAbortError(loadError) || signal.aborted) return;
      setError(refusalMessageOr(loadError, options.loadErrorFallback));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!callbacks.current.load) return;
    const controller = new AbortController();
    void runLoad(controller.signal);
    return () => controller.abort();
  }, [runLoad]);

  const reload = useCallback(async () => {
    if (!callbacks.current.load) return;
    setError("");
    setSuccess("");
    await runLoad(new AbortController().signal);
  }, [runLoad]);

  const dirty =
    draft !== null &&
    saved !== null &&
    (options.isDirty
      ? options.isDirty(draft, saved)
      : !shallowEqual(draft, saved));

  const valid =
    draft !== null && (options.isValid ? options.isValid(draft) : true);

  const setDraft = useCallback((update: Partial<T> | ((current: T) => T)) => {
    setDraftState((current) => {
      if (current === null) return current;
      return typeof update === "function"
        ? update(current)
        : { ...current, ...update };
    });
  }, []);

  useReturnAttention(saveFocusReturn, saveFailureKey);
  const { capture: captureEditFocus, close: returnEditFocus } = editorFocus;

  const startEditing = useCallback(() => {
    // Read before the render that unmounts the Edit button holding focus; the
    // capture also reveals the editor once that render has committed.
    captureEditFocus();
    setEditing(true);
  }, [captureEditFocus]);

  const cancelEditing = useCallback(() => {
    // Restoring the snapshot object wholesale is the point of the hook: no
    // field can be missed the way a field-by-field revert can miss one.
    setDraftState((current) => (saved === null ? current : saved));
    setEditing(false);
    returnEditFocus();
  }, [saved, returnEditFocus]);

  const save = useCallback(async () => {
    if (draft === null || saving || !valid) return;
    if (!dirty && !allowPristineSave) return;
    // Read before `saving` disables the Save that holds focus — a browser
    // drops focus from a disabled control to the page.
    saveFocusReturn.current = captureFocusReturn();
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      // Re-seed from what the callback returns — the server's authoritative
      // value — never from the submitted draft.
      const next = await callbacks.current.save(draft, saved);
      setSaved(next);
      setDraftState(next);
      setEditing(false);
      saveFocusReturn.current = null;
      returnEditFocus();
      const message = callbacks.current.successMessage;
      setSuccess(typeof message === "function" ? message(next) : message);
    } catch (saveError) {
      setSaveFailureKey((key) => key + 1);
      if (saveError instanceof ForbiddenSaveError) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
      } else {
        setError(
          refusalMessageOr(saveError, callbacks.current.saveErrorFallback),
        );
      }
    } finally {
      setSaving(false);
    }
    // `save` / `successMessage` are read from the latest-ref, so only the
    // guards need to be dependencies.
  }, [draft, saved, saving, valid, dirty, allowPristineSave, returnEditFocus]);

  return {
    draft,
    saved,
    loading,
    saving,
    editing,
    dirty,
    valid,
    error,
    success,
    setError,
    setSuccess,
    setDraft,
    startEditing,
    cancelEditing,
    editTriggerProps: editorFocus.triggerProps(),
    sectionRegionProps: editorFocus.regionProps,
    titleProps: editorFocus.titleProps,
    save,
    reload,
  };
}
