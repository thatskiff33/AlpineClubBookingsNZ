import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_VERSION_ENV_VAR } from "@/lib/app-version";

/**
 * A canary bound to the INSTALLED Sentry SDK (#5262): the server tags events
 * with the release and sends no session data.
 *
 * The real `sentry.server.config.ts` runs on the real `@sentry/nextjs`. The
 * one thing replaced is where envelopes go: `init` is handed a transport that
 * keeps them in memory, so nothing is sent and no listener is needed. A plain
 * `node:http` server then takes requests the way Next's does, an error is
 * captured inside one request and outside any, and the test reads what the
 * SDK would have sent.
 *
 * A mock of the SDK could not do this. Before this change the same run
 * produced a `sessions` item (per-minute request counts by outcome, with the
 * release and environment), and with only the request counting switched off it
 * produced a `session` item for the server process on the first error. A
 * Sentry upgrade that renames either switch, or starts sessions somewhere on
 * the request or error path, goes red here.
 */

type EnvelopeItem = [{ type?: string }, unknown];
type Envelope = [unknown, EnvelopeItem[]];
type Integration = { name: string; isDefaultInstance?: boolean };

/** What the installed @sentry/node calls its two session sources. Held apart from the app's own constant on purpose. */
const PROCESS_SESSION_INTEGRATION = "ProcessSession";
const HTTP_INTEGRATION = "Http";
const RELEASE = "sentry-server-session-canary";

const sent = vi.hoisted(() => ({ envelopes: [] as unknown[] }));

// Only the destination is replaced: every option the app sets reaches the real `init`.
vi.mock("@sentry/nextjs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@sentry/nextjs");
  const init: typeof actual.init = (options) =>
    actual.init({
      ...options,
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.envelopes.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });
  return { ...actual, init };
});

const items = () => (sent.envelopes as Envelope[]).flatMap(([, envelopeItems]) => envelopeItems);
const itemTypes = () => items().map(([header]) => header.type);
const names = (integrations: Integration[]) => integrations.map((integration) => integration.name);

let Sentry: typeof import("@sentry/nextjs");

describe("the server sends release-tagged events and no session data (#5262)", () => {
  beforeAll(async () => {
    // Never contacted: `.invalid` cannot resolve, and the transport above is in memory.
    vi.stubEnv("SENTRY_DSN", "https://public@sentry.invalid/1");
    vi.stubEnv(APP_VERSION_ENV_VAR, RELEASE);
    await import("../../../sentry.server.config");
    Sentry = await import("@sentry/nextjs");

    const server = http.createServer((request, response) => {
      if (request.url === "/error") Sentry.captureException(new Error("inside a request"));
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const get = (requestPath: string) =>
      new Promise<void>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: requestPath, agent: false }, (response) => {
            response.resume();
            response.on("end", () => resolve());
          })
          .on("error", reject);
      });
    for (const requestPath of ["/", "/ok", "/error", "/ok"]) await get(requestPath);
    // Closing waits for every response to finish, which is when a request session would be counted.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Sentry.captureException(new Error("outside a request"));
    // A flush sends any pending request-session counts at once, without the SDK's 60-second timer.
    expect(await Sentry.flush(10_000)).toBe(true);
  });

  afterAll(async () => {
    await Sentry?.close(2_000);
    vi.unstubAllEnvs();
  });

  it("runs the real SDK at the version the app depends on, with only the transport replaced", () => {
    const pinned = (
      JSON.parse(readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies["@sentry/nextjs"];
    expect(Sentry.SDK_VERSION).toBe(pinned);
    expect(vi.isMockFunction(Sentry.httpIntegration)).toBe(false);
    expect(Sentry.getClient()?.getOptions().release).toBe(RELEASE);
  });

  it("the SDK's server defaults still carry both session sources under the names the app relies on", () => {
    const defaults = names(Sentry.getDefaultIntegrations({}));
    expect(defaults).toContain(PROCESS_SESSION_INTEGRATION);
    expect(defaults).toContain(HTTP_INTEGRATION);
  });

  it("the app's builder drops the process session from the SDK's real defaults, and nothing else", async () => {
    const { buildServerSentryIntegrations } = await import("@/lib/sentry-server-integrations");
    const defaults = names(Sentry.getDefaultIntegrations({}));
    const built = names(buildServerSentryIntegrations(Sentry.getDefaultIntegrations({})));
    expect(defaults.filter((name) => !built.includes(name))).toEqual([PROCESS_SESSION_INTEGRATION]);
    expect(built.filter((name) => !defaults.includes(name))).toEqual([]);
  });

  it("installs the app's Http and NodeFetch integrations in place of the SDK's defaults", () => {
    const installed = Sentry.getClient()?.getOptions().integrations as Integration[];
    expect(names(installed)).not.toContain(PROCESS_SESSION_INTEGRATION);
    for (const name of [HTTP_INTEGRATION, "NodeFetch"]) {
      const instances = installed.filter((integration) => integration.name === name);
      expect(instances, name).toHaveLength(1);
      // The SDK marks its own instances; the app's replaced them by name.
      expect(instances[0].isDefaultInstance, name).not.toBe(true);
    }
  });

  it("sends both errors, tagged with the release and environment", () => {
    const events = items()
      .filter(([header]) => header.type === "event")
      .map(([, payload]) => payload as { release?: string; environment?: string; exception?: { values?: { value?: string }[] } });
    expect(events.map((event) => event.exception?.values?.[0]?.value).sort()).toEqual([
      "inside a request",
      "outside a request",
    ]);
    expect(events.map((event) => event.release)).toEqual([RELEASE, RELEASE]);
    // The server config's own environment (NODE_ENV, "test" under vitest).
    expect(events.map((event) => event.environment)).toEqual(["test", "test"]);
  });

  it("sends no session item of either kind", () => {
    expect(itemTypes()).not.toContain("sessions");
    expect(itemTypes()).not.toContain("session");
  });

  it("sends nothing else for the requests: no span for an incoming request, as Next makes its own", () => {
    // `client_report` only counts what the SDK dropped (the test's own outgoing requests have no parent span).
    expect(itemTypes().filter((type) => type !== "client_report")).toEqual(["event", "event"]);
  });
});
