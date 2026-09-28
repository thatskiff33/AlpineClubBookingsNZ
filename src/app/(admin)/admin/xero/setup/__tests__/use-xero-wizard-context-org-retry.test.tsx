// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useXeroWizardContext,
  type XeroWizardServerConfig,
} from "../use-xero-wizard-context";

/*
  #2394 — the wizard context must report a failed organisation read, and its
  refresh must genuinely re-read.

  The bug had two halves, and only fixing the second one matters here: the
  server route answered 200 with a null name (the read failed inside
  `getXeroConnectedOrganisation`, which never throws), so nothing the client
  could see said "this failed". These tests drive the real hook against a
  scripted route and pin that (a) a failure becomes a reportable error rather
  than an endless wait, (b) a refresh asks with ?refresh=1, which is what
  escapes the server's 60-second NEGATIVE cache and makes Try again real, and
  (c) an ordinary first load still uses the cache, so no extra Xero quota is
  spent unless a human presses the button.
*/

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { accessRoles: ["FULL_ADMIN"] } },
    status: "authenticated",
  }),
}));

const SERVER_CONFIG: XeroWizardServerConfig = {
  redirectUri: "https://club.example.test/api/admin/xero/callback",
  companyUrl: "https://club.example.test",
  legacyEnvVars: [],
  webhookDeliveryUrl: "https://club.example.test/api/webhooks/xero",
  webhooksVerifiable: true,
  clubChargeCurrencyCode: "NZD",
};

type RouteReply = { ok: boolean; status?: number; body: unknown } | Error;

/**
 * Scripted fetch: credentials/status/webhook always succeed, and the
 * organisation route hands back the next reply in `orgReplies` (repeating the
 * last one), so a test can say "fail, then succeed" without racing.
 */
function stubFetch(options: {
  connected?: boolean;
  statusOk?: boolean;
  orgReplies: RouteReply[];
  /**
   * Hold the Nth (0-based) organisation reply open until `releaseOrg()`, so a
   * test can land a second press genuinely mid-flight.
   */
  holdOrgCall?: number;
}) {
  const orgUrls: string[] = [];
  let orgCall = 0;
  let releaseOrg = () => {};
  const orgGate = new Promise<void>((resolve) => {
    releaseOrg = resolve;
  });
  const fetchMock = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.startsWith("/api/admin/integrations/credentials")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          credentials: {
            client_id: { set: true, setAt: null },
            client_secret: { set: true, setAt: null },
          },
        }),
      };
    }
    if (url.startsWith("/api/admin/xero/status")) {
      if (options.statusOk === false) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          connected: options.connected ?? true,
          needsReentry: false,
        }),
      };
    }
    if (url.startsWith("/api/admin/xero/webhook/verify-status")) {
      return { ok: true, status: 200, json: async () => ({ verified: false }) };
    }
    if (url.startsWith("/api/admin/xero/organisation")) {
      const index = orgCall;
      orgUrls.push(url);
      const reply =
        options.orgReplies[Math.min(orgCall, options.orgReplies.length - 1)];
      orgCall += 1;
      if (options.holdOrgCall === index) await orgGate;
      if (reply instanceof Error) throw reply;
      return {
        ok: reply.ok,
        status: reply.status ?? (reply.ok ? 200 : 500),
        json: async () => reply.body,
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, orgUrls, releaseOrg: () => releaseOrg() };
}

const okOrg = (name: string | null): RouteReply => ({
  ok: true,
  body: { name, financialYearEndMonth: 3, shortCode: "!abc12", readFailure: null },
});

const failedOrg = (
  readFailure: Record<string, unknown>,
): RouteReply => ({
  ok: true,
  body: { name: null, financialYearEndMonth: null, shortCode: null, readFailure },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Several tests below drive the post-OAuth `?connected=true` marker, which
  // the hook STRIPS from the address bar as it consumes it — so the URL is
  // shared state that has to be reset.
  window.history.replaceState({}, "", "/admin/xero/setup");
});

describe("useXeroWizardContext: a successful read is unchanged (#2394)", () => {
  it("reports the organisation name, no error, and does not force a refresh", async () => {
    const { orgUrls } = stubFetch({ orgReplies: [okOrg("Alpine Sports Club")] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgName).toBe("Alpine Sports Club"),
    );
    expect(result.current.context.orgError).toBeNull();
    expect(result.current.context.orgLoading).toBe(false);
    // An ordinary page load rides the server's 12-hour cache — it must not
    // spend a live Xero call just by being opened.
    expect(orgUrls).toEqual(["/api/admin/xero/organisation"]);
  });

  it("makes no organisation call at all while Xero is disconnected", async () => {
    const { orgUrls } = stubFetch({ connected: false, orgReplies: [okOrg("X")] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(orgUrls).toEqual([]);
    expect(result.current.context.orgError).toBeNull();
  });
});

describe("useXeroWizardContext: a failed read is surfaced (#2394)", () => {
  it("carries the server's failure class through instead of waiting for ever", async () => {
    stubFetch({
      orgReplies: [
        failedOrg({ kind: "rate_limited", rateLimit: "day", retryAfterSeconds: 7200 }),
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() => expect(result.current.context.orgError).not.toBeNull());
    expect(result.current.context.orgError).toEqual({
      kind: "rate_limited",
      rateLimit: "day",
      retryAfterSeconds: 7200,
    });
    expect(result.current.context.orgName).toBeNull();
  });

  it("reports a reconnect-class failure as its own thing", async () => {
    stubFetch({
      orgReplies: [failedOrg({ kind: "disconnected", rateLimit: null, retryAfterSeconds: null })],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("disconnected"),
    );
  });

  // Review F6: this is OUR fetch failing, so we never asked Xero anything and
  // must not report it as "we could not reach Xero" — least of all when the
  // browser is simply offline, where the old copy also vouched for a Xero
  // connection it had not checked.
  it("treats a refused fetch as 'we could not check', not as a Xero outage", async () => {
    // The exact CI repro from #2302: the mock harness's loopback was refused,
    // which used to be swallowed by the bare `catch {}`.
    stubFetch({ orgReplies: [new Error("fetch failed: ECONNREFUSED")] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("check_failed"),
    );
  });

  it("separates 'this site refused you' from 'Xero is unavailable'", async () => {
    stubFetch({ orgReplies: [{ ok: false, status: 403, body: {} }] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("forbidden"),
    );
  });

  // Review F8: a 401 is the SESSION going, not the role. It is also the likelier
  // of the two to be reached — a plain permission problem 403s the status read
  // first and never gets here — so the advice must fit it, and a retry after
  // signing in genuinely works.
  it("separates an expired session from a role that lacks finance access", async () => {
    stubFetch({ orgReplies: [{ ok: false, status: 401, body: {} }] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("signed_out"),
    );
  });

  it("does not sit on 'Confirming…' when the read succeeds with no name at all", async () => {
    stubFetch({ orgReplies: [okOrg(null)] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("unavailable"),
    );
  });

  // A failed STATUS read used to look exactly like "disconnected": the org read
  // was skipped and the name cleared, so a step that had been showing a name
  // dropped back to "Confirming…" and stayed there.
  it("says so when it could not even find out whether Xero is connected", async () => {
    const { orgUrls } = stubFetch({ statusOk: false, orgReplies: [okOrg("X")] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    // `check_failed`, not `unavailable` (review F6): this branch never asked
    // Xero anything, and the page already shows "Failed to load Xero connection
    // status" right above — an amber box beneath it claiming the Xero
    // connection is fine made the step contradict itself.
    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("check_failed"),
    );
    expect(orgUrls).toEqual([]);
  });

  it("degrades an unrecognised failure kind rather than dropping it", async () => {
    stubFetch({ orgReplies: [failedOrg({ kind: "something-new-from-a-newer-server" })] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError).toEqual({
        kind: "unavailable",
        rateLimit: null,
        retryAfterSeconds: null,
      }),
    );
  });
});

describe("useXeroWizardContext: Try again really re-reads (#2394)", () => {
  it("asks with ?refresh=1 — the only way past the 60-second negative cache", async () => {
    const { orgUrls } = stubFetch({
      orgReplies: [
        failedOrg({ kind: "unavailable", rateLimit: null, retryAfterSeconds: null }),
        okOrg("Alpine Sports Club"),
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() => expect(result.current.context.orgError).not.toBeNull());

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(result.current.context.orgName).toBe("Alpine Sports Club"),
    );
    expect(result.current.context.orgError).toBeNull();
    expect(orgUrls).toEqual([
      "/api/admin/xero/organisation",
      "/api/admin/xero/organisation?refresh=1",
    ]);
  });

  // Review F3. The Try again button is NOT disabled while busy (it must keep
  // focus), so the only thing standing between an impatient operator and N live
  // Xero calls is the in-flight guard in the hook. Pin it directly.
  it("drops a second press landing while the first read is still in flight", async () => {
    const { orgUrls, releaseOrg } = stubFetch({
      orgReplies: [
        failedOrg({ kind: "unavailable", rateLimit: null, retryAfterSeconds: null }),
        okOrg("Alpine Sports Club"),
      ],
      // Hold the FIRST retry (org call index 1) open.
      holdOrgCall: 1,
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() => expect(result.current.context.orgError).not.toBeNull());

    // Press, then press twice more while the read is genuinely mid-flight.
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.context.orgLoading).toBe(true));
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });

    await act(async () => {
      releaseOrg();
    });
    await waitFor(() =>
      expect(result.current.context.orgName).toBe("Alpine Sports Club"),
    );

    // Three presses, ONE extra live read: the mount load plus a single retry.
    expect(orgUrls).toEqual([
      "/api/admin/xero/organisation",
      "/api/admin/xero/organisation?refresh=1",
    ]);
  });

  it("keeps reporting the failure when the retry fails too", async () => {
    stubFetch({
      orgReplies: [
        failedOrg({ kind: "unavailable", rateLimit: null, retryAfterSeconds: null }),
        failedOrg({ kind: "rate_limited", rateLimit: "minute", retryAfterSeconds: 30 }),
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("unavailable"),
    );

    await act(async () => {
      result.current.refresh();
    });

    // The second attempt hit a rate limit: still an error, and now a more
    // specific one — never a silent return to "Confirming…".
    await waitFor(() =>
      expect(result.current.context.orgError).toEqual({
        kind: "rate_limited",
        rateLimit: "minute",
        retryAfterSeconds: 30,
      }),
    );
    expect(result.current.context.orgName).toBeNull();
    expect(result.current.context.orgLoading).toBe(false);
  });

  // Review F5. Two failures of the SAME class render byte-identical text, React
  // mutates no DOM node, and the alert region announces nothing at all. The
  // check tally is what guarantees the message changes, so it must actually
  // move — including when the failure is identical.
  it("re-stamps the check tally even when the same failure repeats", async () => {
    stubFetch({
      orgReplies: [
        failedOrg({ kind: "rate_limited", rateLimit: "day", retryAfterSeconds: null }),
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() => expect(result.current.context.orgErrorAttempts).toBe(1));
    const firstAt = result.current.context.orgErrorAt;
    expect(firstAt).not.toBeNull();

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.context.orgErrorAttempts).toBe(2));
    expect(result.current.context.orgErrorAt).not.toBeNull();
  });

  it("clears the tally once a check finally succeeds", async () => {
    stubFetch({
      orgReplies: [
        failedOrg({ kind: "unavailable", rateLimit: null, retryAfterSeconds: null }),
        okOrg("Alpine Sports Club"),
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() => expect(result.current.context.orgErrorAttempts).toBe(1));

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(result.current.context.orgName).toBe("Alpine Sports Club"),
    );
    expect(result.current.context.orgErrorAttempts).toBe(0);
    expect(result.current.context.orgErrorAt).toBeNull();
  });
});

// Review F4. The server keeps serving the last known summary behind a failed
// read, so a name arrives ALONGSIDE `readFailure`. Suppressing the failure
// because a name was present is how the one failure class this whole feature
// exists to surface — an authorisation revoked inside Xero's own Connected-apps
// screen, which leaves our token row (and therefore /api/admin/xero/status)
// looking perfectly healthy — rendered as a green "Connected to <club>" tick.
describe("useXeroWizardContext: a stale name never swallows the failure (#2394)", () => {
  it("reports the failure and the cached name together", async () => {
    stubFetch({
      orgReplies: [
        {
          ok: true,
          body: {
            name: "Alpine Sports Club",
            financialYearEndMonth: 3,
            shortCode: "!abc12",
            readFailure: {
              kind: "disconnected",
              rateLimit: null,
              retryAfterSeconds: null,
            },
          },
        },
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("disconnected"),
    );
    // The name is kept — losing it would be a regression on top of a blip —
    // but it no longer stands in for a confirmation.
    expect(result.current.context.orgName).toBe("Alpine Sports Club");
  });

  it("does not blank a known name when a later check fails", async () => {
    stubFetch({
      orgReplies: [
        okOrg("Alpine Sports Club"),
        failedOrg({ kind: "unavailable", rateLimit: null, retryAfterSeconds: null }),
      ],
    });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() =>
      expect(result.current.context.orgName).toBe("Alpine Sports Club"),
    );

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(result.current.context.orgError?.kind).toBe("unavailable"),
    );
    expect(result.current.context.orgName).toBe("Alpine Sports Club");
  });
});

// Review F1. `IntegrationWizard` mounts only the ACTIVE step and `goTo` is pure
// client state — no navigation — so a step-level effect that merely READ
// `?connected=true` re-fired on every return to the Connect step, forcing a live
// Xero call with nobody pressing anything. That directly contradicted the
// owner's binding decision (no Xero quota unless a human presses). Consuming the
// marker in the hook, and stripping it, is what makes the claim true.
describe("useXeroWizardContext: the post-OAuth marker is consumed once (#2394)", () => {
  it("forces exactly ONE fresh read on the connect return, and strips the marker", async () => {
    window.history.replaceState(
      {},
      "",
      "/admin/xero/setup?step=connect&connected=true",
    );
    const { orgUrls } = stubFetch({ orgReplies: [okOrg("Alpine Sports Club")] });

    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgName).toBe("Alpine Sports Club"),
    );
    // ONE call, and it is the forced one — not "cached read, then forced read",
    // which is what the step-level effect produced.
    expect(orgUrls).toEqual(["/api/admin/xero/organisation?refresh=1"]);
    // The marker is gone; every other parameter survives (the shell reads
    // ?step=, and the connect step renders ?error=).
    expect(window.location.search).toBe("?step=connect");
  });

  it("does not force a read again once the marker has been consumed", async () => {
    window.history.replaceState({}, "", "/admin/xero/setup?connected=true");
    const first = stubFetch({ orgReplies: [okOrg("Alpine Sports Club")] });
    const firstRender = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() =>
      expect(firstRender.result.current.context.orgName).toBe(
        "Alpine Sports Club",
      ),
    );
    expect(first.orgUrls).toEqual(["/api/admin/xero/organisation?refresh=1"]);
    firstRender.unmount();

    // Re-mounting (what walking back to the Connect step used to do) must ride
    // the server cache instead of spending another live Xero call.
    const second = stubFetch({ orgReplies: [okOrg("Alpine Sports Club")] });
    const secondRender = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() =>
      expect(secondRender.result.current.context.orgName).toBe(
        "Alpine Sports Club",
      ),
    );
    expect(second.orgUrls).toEqual(["/api/admin/xero/organisation"]);
  });
});

// #3633: the base currency rides on the same organisation response as the name,
// and is kept on the same terms: a failed re-check keeps the last one read, a
// successful read replaces it (null included).
describe("useXeroWizardContext: organisation base currency (#3633)", () => {
  const orgWith = (
    baseCurrency: unknown,
    readFailure: Record<string, unknown> | null = null,
  ): RouteReply => ({
    ok: true,
    body: {
      name: "Alpine Sports Club",
      financialYearEndMonth: 3,
      shortCode: "!abc12",
      baseCurrency,
      readFailure,
    },
  });

  it("carries the base currency off the organisation read, with no extra call", async () => {
    const { orgUrls } = stubFetch({ orgReplies: [orgWith("AUD")] });
    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgBaseCurrency).toBe("AUD"),
    );
    expect(orgUrls).toEqual(["/api/admin/xero/organisation"]);
  });

  it("treats a missing or non-string base currency as unknown", async () => {
    stubFetch({ orgReplies: [orgWith(42)] });
    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() =>
      expect(result.current.context.orgName).toBe("Alpine Sports Club"),
    );
    expect(result.current.context.orgBaseCurrency).toBeNull();
  });

  it("keeps the last base currency through a failed re-check, and a success replaces it", async () => {
    stubFetch({
      orgReplies: [
        orgWith("AUD"),
        orgWith(null, { kind: "unavailable", rateLimit: null, retryAfterSeconds: null }),
        orgWith(null),
      ],
    });
    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));
    await waitFor(() =>
      expect(result.current.context.orgBaseCurrency).toBe("AUD"),
    );

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.context.orgError).not.toBeNull());
    expect(result.current.context.orgBaseCurrency).toBe("AUD");

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.context.orgError).toBeNull());
    expect(result.current.context.orgBaseCurrency).toBeNull();
  });

  it("has no base currency while Xero is disconnected", async () => {
    stubFetch({ connected: false, orgReplies: [orgWith("AUD")] });
    const { result } = renderHook(() => useXeroWizardContext(SERVER_CONFIG));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.context.orgBaseCurrency).toBeNull();
  });
});
