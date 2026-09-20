// Node's `AsyncLocalStorage`, installed as a global before any module is
// evaluated.
//
// A SEPARATE setup file, listed before `vitest.setup.ts`, for the same reason
// the frozen clock is one: ES module imports are hoisted and evaluated before
// any statement in a module's body, so a global assigned inside
// `vitest.setup.ts` would land after that file's own imports had already run.
// This one has to be earlier than that, because of what reads it.
//
// ## What reads it, and when
//
// Next decides once, at module-evaluation time, whether a real async store is
// available:
//
//     const maybeGlobalAsyncLocalStorage =
//       typeof globalThis !== "undefined" && globalThis.AsyncLocalStorage;
//
// (`next/dist/server/app-render/async-local-storage.js`.) If the global is
// absent at that instant, every later call gets a `FakeAsyncLocalStorage` whose
// methods throw `Invariant: AsyncLocalStorage accessed in runtime where it is
// not available`. The decision is a module-scope `const`, so setting the global
// afterwards cannot undo it — the timing is the whole requirement.
//
// Node does not set that global. It exports the class from `node:async_hooks`
// and leaves `globalThis` alone; the edge runtime is what sets it, which is the
// runtime Next is really asking about.
//
// ## Why this is a file rather than a line nobody noticed was missing
//
// It was missing, and the suite that needs it passed anyway — because
// `@sentry/nextjs` pulled `@apm-js-collab/tracing-hooks`, whose instrumentation
// installed the global as a side effect of being loaded. Nothing said so and
// nothing depended on it deliberately.
//
// #3419 found it the hard way. Sentry 10.74.0 dropped that transitive package,
// and `asset-url-404.test.ts` — which imports Next's app-route internals —
// began failing on import, while the seven suites that had been failing were
// fixed. Measured in one worktree, same machine, one variable: on 10.70.0 it
// passes, on 10.74.0 and 10.75.0 it fails, reproducibly. So the suite had been
// resting on a monitoring library's side effect, and the version bump merely
// removed the prop.
//
// Declaring the dependency here is the fix. It is explicit, it belongs to the
// test runtime rather than to any package's instrumentation, and it cannot be
// removed again by someone else's release.
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as typeof globalThis & { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??=
  AsyncLocalStorage;
