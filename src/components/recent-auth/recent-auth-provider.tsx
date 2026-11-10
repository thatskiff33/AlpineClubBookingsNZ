"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RecentAuthDialog } from "@/components/recent-auth/recent-auth-dialog";
import { isRecentAuthRefusal } from "@/lib/recent-auth-policy";

/**
 * Answers `requireRecentAuth`'s refusal in the browser (#4616, `INV-AUTH-008`):
 * `useRecentAuthFetch()` sends a request; when the server says the person must
 * confirm it's them, the dialog asks, and on a confirmed proof the request is
 * sent again ONCE, exactly as it was first sent. #4619 mounts the provider and
 * moves the destructive actions onto the hook; nothing uses it yet.
 */

/**
 * A request `fetch` can send twice unchanged. A stream body is read by the
 * first send and could not be replayed, so it is not representable here; nor
 * is a `Request` input, whose body the first send would consume.
 */
export type ReplayableRequestInit = Omit<RequestInit, "body"> & {
  body?: Exclude<BodyInit, ReadableStream> | null;
};

type ConfirmIdentity = () => Promise<boolean>;

/**
 * Sends the request; if it meets the recent-authentication refusal, asks
 * `confirmIdentity` and, only when that confirms, sends the SAME request once
 * more and returns that answer, whatever it is. Never a third send: a second
 * refusal is returned as it came, not prompted for again. Cancelled, the
 * original refusal is returned for the caller to show. So a typed confirmation
 * such as `RESTORE` is neither lost nor acted on twice.
 */
export async function fetchWithRecentAuth(
  input: string | URL,
  init: ReplayableRequestInit | undefined,
  confirmIdentity: ConfirmIdentity,
): Promise<Response> {
  const response = await fetch(input, init);
  if (!(await isRecentAuthRefusal(response))) return response;
  if (!(await confirmIdentity())) return response;
  return fetch(input, init);
}

const RecentAuthContext = createContext<ConfirmIdentity | null>(null);
const MISSING_PROVIDER = "useRecentAuthFetch needs a RecentAuthProvider above it";

export function RecentAuthProvider({ children }: { children: ReactNode }) {
  const [requestId, setRequestId] = useState<number | null>(null);
  const nextRequestId = useRef(0);
  const pending = useRef<{
    promise: Promise<boolean>;
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const confirmIdentity = useCallback<ConfirmIdentity>(() => {
    // Requests refused together share one dialog and one answer; each is
    // still replayed at most once by its own `fetchWithRecentAuth`.
    if (pending.current) return pending.current.promise;
    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    pending.current = { promise, resolve };
    nextRequestId.current += 1;
    setRequestId(nextRequestId.current);
    return promise;
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const current = pending.current;
    pending.current = null;
    setRequestId(null);
    current?.resolve(confirmed);
  }, []);

  return (
    <RecentAuthContext.Provider value={confirmIdentity}>
      {children}
      <RecentAuthDialog requestId={requestId} onSettle={settle} />
    </RecentAuthContext.Provider>
  );
}

/** `fetch` for an action behind `requireRecentAuth`. Needs a `RecentAuthProvider` above it. */
export function useRecentAuthFetch(): (
  input: string | URL,
  init?: ReplayableRequestInit,
) => Promise<Response> {
  const confirmIdentity = useContext(RecentAuthContext);
  const send = useCallback(
    (input: string | URL, init?: ReplayableRequestInit) => {
      if (!confirmIdentity) throw new Error(MISSING_PROVIDER);
      return fetchWithRecentAuth(input, init, confirmIdentity);
    },
    [confirmIdentity],
  );
  if (!confirmIdentity) throw new Error(MISSING_PROVIDER);
  return send;
}
