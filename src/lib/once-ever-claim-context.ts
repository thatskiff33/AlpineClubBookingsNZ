import { AsyncLocalStorage } from "node:async_hooks";

/**
 * #5255 (`INV-INT-041`): the once-ever claim a `sendAdminAlertOnceEver` send
 * runs under, handed to the alert's own emails so each one's row confirms the
 * claim (`confirmAlertCooldownSend`) in the transaction that writes it.
 *
 * The admin-alert senders take it ONCE (`takeOnceEverClaim`), before their
 * recipient loop, and pass it explicitly to their own `sendEmail` calls; the
 * mailer never reads this store. So only the first admin alert a send makes
 * carries the claim, and every other email in the callback - a second alert, a
 * member email - goes out exactly as it would outside one.
 *
 * `rowWritten` and `rowWriteFailed` are what the claim helper reads afterwards
 * to tell an alert with an email behind it from one that sent nothing.
 */
export type OnceEverClaimHandle = {
  readonly key: string;
  readonly claimedAt: Date;
  taken: boolean;
  /** An email row confirming this claim committed. */
  rowWritten: boolean;
  /** An email under this claim was refused: the claim was gone, or the write failed. */
  rowWriteFailed: boolean;
};

const claims = new AsyncLocalStorage<OnceEverClaimHandle>();

/** A fresh handle for the claim taken at `claimedAt`. */
export function newOnceEverClaimHandle(key: string, claimedAt: Date): OnceEverClaimHandle {
  return { key, claimedAt, taken: false, rowWritten: false, rowWriteFailed: false };
}

/** Run `send` with `handle` as its claim. */
export function runWithOnceEverClaim<T>(handle: OnceEverClaimHandle, send: () => Promise<T>): Promise<T> {
  return claims.run(handle, send);
}

/** The claim the current send runs under, the first time it is asked for; null after that, and outside any. */
export function takeOnceEverClaim(): OnceEverClaimHandle | null {
  const handle = claims.getStore();
  if (!handle || handle.taken) return null;
  handle.taken = true;
  return handle;
}
