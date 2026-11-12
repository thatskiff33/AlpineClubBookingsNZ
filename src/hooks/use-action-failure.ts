"use client";

import { useCallback, useState } from "react";

/**
 * The failure half of an admin surface that also loads data in the background.
 *
 * A load failure and an action failure are different events (#2934): a list
 * that could not be read is a passive notice that moves nothing, while a Save,
 * Retry or Sync that failed is what the admin has to act on next, so it takes
 * focus. Keep the load error in its own state and render this one through
 * `FocusedActionError` with `attentionKey`:
 *
 *     const { actionError, attentionKey, failAction, clearActionError } = useActionFailure()
 *     <FocusedActionError id="…" error={actionError} attentionKey={attentionKey} />
 *
 * `failAction` bumps `attentionKey` on every call, so a retry that fails with the
 * IDENTICAL message takes focus again; a bare `setState(message)` would be one
 * arrival and leave focus on the re-enabled button.
 */
export function useActionFailure() {
  const [actionError, setActionError] = useState("");
  const [attentionKey, setAttentionKey] = useState(0);

  const failAction = useCallback((message: string) => {
    setActionError(message);
    setAttentionKey((key) => key + 1);
  }, []);

  const clearActionError = useCallback(() => setActionError(""), []);

  return { actionError, attentionKey, failAction, clearActionError };
}
