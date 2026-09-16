"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";

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

export interface UseSectionEditStateOptions<T extends object> {
  /**
   * Seed value for props-seeded cards, and the value a card with a `load` falls
   * back to while (or after a failed) load. Omit it for cards that render
   * nothing until their fetch resolves — `draft` is then `null` until it does.
   */
  initial?: T;
  /**
   * Fetch the persisted value. When provided it runs once on mount (and again
   * via `reload`), and `loading` starts `true`. The `AbortSignal` is aborted on
   * unmount; an `AbortError` is swallowed rather than surfaced as an error.
   *
   * NOTE: this runs on mount only. A section whose fetch is keyed on some other
   * state (a lodge scope, say) must re-fetch through `reload` itself.
   */
  load?: (signal: AbortSignal) => Promise<T>;
  /**
   * Persist `draft` and return the AUTHORITATIVE value to re-seed both the
   * draft and the snapshot from — the parsed server response wherever the write
   * returns one. `saved` is the current snapshot, so a callback can skip an
   * endpoint whose slice of the draft did not change. Throw
   * {@link ForbiddenSaveError} for a 403; throw any other `Error` to surface
   * its message.
   */
  save: (draft: T, saved: T | null) => Promise<T>;
  /** Success message, or a function of the saved value when it is conditional. */
  successMessage: string | ((saved: T) => string);
  /** Message for a non-`Error` throw from `save`. */
  saveErrorFallback?: string;
  /** Message for a non-`Error` throw from `load`. */
  loadErrorFallback?: string;
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
}

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
  startEditing: () => void;
  /**
   * Counts explicit `startEditing` calls, starting at `0`. Hand it to
   * `useRevealAttention` (`@/hooks/use-scroll-to-feedback`) to bring the
   * section into view and focus when the admin clicks Edit — and only then:
   * a re-render with `editing` already `true` leaves it unchanged, so the
   * editor is never focused because content re-rendered (#2934).
   */
  editRequestKey: number;
  /** Restore every field from the snapshot and leave edit mode. */
  cancelEditing: () => void;
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
  const [editRequestKey, setEditRequestKey] = useState(0);
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
    const load = callbacks.current.load;
    if (!load) return;
    setLoading(true);
    try {
      const next = await load(signal);
      if (signal.aborted) return;
      setSaved(next);
      setDraftState(next);
      setEditing(false);
    } catch (loadError) {
      if (isAbortError(loadError) || signal.aborted) return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : (callbacks.current.loadErrorFallback ?? "Unknown error"),
      );
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

  const startEditing = useCallback(() => {
    setEditing(true);
    setEditRequestKey((key) => key + 1);
  }, []);

  const cancelEditing = useCallback(() => {
    // Restoring the snapshot object wholesale is the point of the hook: no
    // field can be missed the way a field-by-field revert can miss one.
    setDraftState((current) => (saved === null ? current : saved));
    setEditing(false);
  }, [saved]);

  const save = useCallback(async () => {
    if (draft === null || saving || !valid) return;
    if (!dirty && !allowPristineSave) return;
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
      const message = callbacks.current.successMessage;
      setSuccess(typeof message === "function" ? message(next) : message);
    } catch (saveError) {
      if (saveError instanceof ForbiddenSaveError) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
      } else {
        setError(
          saveError instanceof Error
            ? saveError.message
            : (callbacks.current.saveErrorFallback ?? "Unknown error"),
        );
      }
    } finally {
      setSaving(false);
    }
    // `save` / `successMessage` are read from the latest-ref, so only the
    // guards need to be dependencies.
  }, [draft, saved, saving, valid, dirty, allowPristineSave]);

  return {
    draft,
    saved,
    loading,
    saving,
    editing,
    editRequestKey,
    dirty,
    valid,
    error,
    success,
    setError,
    setSuccess,
    setDraft,
    startEditing,
    cancelEditing,
    save,
    reload,
  };
}
