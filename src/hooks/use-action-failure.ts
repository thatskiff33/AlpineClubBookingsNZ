"use client";

import { useCallback, useState } from "react";

/**
 * The failure half of an admin action, shaped for `FocusedActionError` (#4975).
 *
 * `fail` records the message AND bumps `attentionKey`, so a failure that
 * repeats word for word still takes focus and is announced again — a plain
 * string state would not change, and the alert would stay silent. `clear`
 * empties the message without bumping. A background load failure does not
 * belong here: it stays a passive box that never takes focus.
 *
 * ```tsx
 * const failure = useActionFailure();
 * // in the action: failure.clear(); … catch → failure.fail(message)
 * <FocusedActionError id="…" error={failure.error} attentionKey={failure.attentionKey} />
 * ```
 */
export function useActionFailure() {
  const [state, setState] = useState({ error: "", attentionKey: 0 });

  const fail = useCallback((message: string) => {
    setState((previous) => ({
      error: message,
      attentionKey: previous.attentionKey + 1,
    }));
  }, []);

  const clear = useCallback(() => {
    setState((previous) =>
      previous.error ? { ...previous, error: "" } : previous,
    );
  }, []);

  return {
    error: state.error,
    attentionKey: state.attentionKey,
    fail,
    clear,
  };
}

export type ActionFailure = ReturnType<typeof useActionFailure>;
