/**
 * A stand-in for React's request-scoped `cache()`, for tests of a memoised
 * server read (#4938).
 *
 * Vitest loads React's client build, where `cache(fn)` returns a plain
 * pass-through, so a test that imports the real `cache()` cannot tell a wrapped
 * definition from an unwrapped one. `requestScopedCache` keeps the contract the
 * React Server Components build gives a render:
 *
 * - inside `inRequestScope(...)` one result per function identity and argument
 *   list, shared by every caller in that scope (a rejection is shared too);
 * - a fresh memo for every scope, so nothing crosses from one request to the
 *   next;
 * - outside any scope, no memo at all, as in a route handler or server action.
 *
 * Arguments are keyed by `JSON.stringify`, enough for the primitive ids these
 * reads take; React keys by identity, which agrees for primitives.
 *
 * Install it by replacing `cache` on the mocked module:
 *
 *   vi.mock("react", async (importOriginal) => {
 *     const { requestScopedCache } = await import(
 *       "@/lib/__tests__/helpers/request-cache-scope"
 *     );
 *     return { ...(await importOriginal<typeof import("react")>()), cache: requestScopedCache };
 *   });
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Memo = Map<unknown, Map<string, unknown>>;

const scope = new AsyncLocalStorage<Memo>();

export function requestScopedCache<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args: Args) => {
    const memo = scope.getStore();
    if (!memo) return fn(...args);
    let byArgs = memo.get(fn);
    if (!byArgs) {
      byArgs = new Map();
      memo.set(fn, byArgs);
    }
    const key = JSON.stringify(args);
    if (!byArgs.has(key)) byArgs.set(key, fn(...args));
    return byArgs.get(key) as Result;
  };
}

/** Run `render` as one request: every memoised read inside it shares a memo. */
export function inRequestScope<T>(render: () => Promise<T>): Promise<T> {
  return scope.run(new Map(), render);
}
