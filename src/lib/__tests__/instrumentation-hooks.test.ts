import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

/**
 * Guards the wiring of Next's server-side error hook (#2356 review).
 *
 * The regression this exists to catch is silent by construction: Next reads
 * `onRequestError` off the `instrumentation` convention module and nowhere else,
 * so exporting it from any other file (as `src/instrumentation.node.ts` did for
 * a long time) leaves the hook unreachable with no error, no warning, and a
 * clean build. Nothing observes the loss except the absence of Sentry events
 * that were never going to arrive.
 *
 * WHAT THE EXPORT ASSERTION ALONE CANNOT SEE. `typeof
 * instrumentation.onRequestError === "function"` is equally true if the hook is
 * defined locally and if it is STATICALLY re-exported from
 * `./instrumentation.node` — and that re-export is the second half of the
 * regression, because it would pull Prisma, node-cron and `node:*` builtins into
 * the edge instrumentation bundle, which the runtime check in `register()`
 * exists to avoid. So the third case below reads the source and pins the shape:
 * the only reference to `./instrumentation.node` from the convention module must
 * be the dynamic `await import(…)` inside `register()`, never a static
 * `import`/`export … from`. That is a cheap proxy, not the property itself —
 * asserting on the emitted edge bundle would need a full `pnpm run build` in the
 * unit suite. It catches the direct re-export; a node-only dependency arriving
 * transitively through some new static import would still slip past it.
 */
describe("instrumentation convention module", () => {
  beforeEach(() => {
    captureException.mockClear();
  });

  it("exports onRequestError, which is the only place Next looks for it", async () => {
    // Deliberately imports the CONVENTION module, not `./instrumentation.node`:
    // the property under test is where the export lives, not that it exists
    // somewhere in the tree.
    const instrumentation = await import("@/instrumentation");
    expect(typeof instrumentation.onRequestError).toBe("function");
  });

  it("reports the error to Sentry with the route context Next supplies", async () => {
    const { onRequestError } = await import("@/instrumentation");
    const error = new Error("boom");

    await onRequestError(
      error,
      { path: "/bookings/42?token=secret", method: "GET", headers: {} },
      {
        routerKind: "App Router",
        routePath: "/bookings/[id]",
        routeType: "render",
        renderSource: "server-rendering",
        revalidateReason: undefined,
      }
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    const [captured, options] = captureException.mock.calls[0] as [
      unknown,
      { tags: Record<string, unknown>; extra: Record<string, unknown> },
    ];
    expect(captured).toBe(error);
    expect(options.tags).toEqual({
      routerKind: "App Router",
      routePath: "/bookings/[id]",
      routeType: "render",
      renderSource: "server-rendering",
    });
    // `path`, not `url`: Next passes `{ path, method, headers }`, so the old
    // `request.url` read would have recorded `undefined` on every event.
    expect(options.extra).toEqual({
      method: "GET",
      path: "/bookings/42?token=secret",
    });
  });

  it("reaches ./instrumentation.node only through a dynamic import", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    const source = readFileSync(
      resolve(process.cwd(), "src", "instrumentation.ts"),
      "utf-8"
    );

    // A static `import … from` / `export … from` would bundle that module — and
    // everything it drags in — into BOTH runtimes, including edge.
    expect(
      source.match(
        /^\s*(?:import|export)\b[^\n]*\bfrom\s+["']\.\/instrumentation\.node["']/m
      )
    ).toBeNull();
    // The dynamic import must still be there, or `register()` never boots cron.
    expect(source).toContain('await import("./instrumentation.node")');
  });
});
