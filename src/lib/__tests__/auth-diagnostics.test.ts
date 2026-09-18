import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCookies,
  mockHeaders,
  mockProbe,
  mockCaptureMessage,
  mockCaptureException,
  mockLogger,
  afterQueue,
} = vi.hoisted(() => ({
  mockCookies: vi.fn(),
  mockHeaders: vi.fn(),
  mockProbe: vi.fn(),
  mockCaptureMessage: vi.fn(),
  mockCaptureException: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  afterQueue: [] as Promise<unknown>[],
}));

vi.mock("next/headers", () => ({
  cookies: () => mockCookies(),
  headers: () => mockHeaders(),
}));

// after() defers the durable write past the response; the mock queues the
// callback so tests can flush and then assert on the persisted row.
vi.mock("next/server", () => ({
  after: (callback: () => unknown) => {
    afterQueue.push(Promise.resolve().then(callback));
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock("@/lib/auth", () => ({
  getSessionForAuthDiagnostics: () => mockProbe(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import {
  generateAuthBounceRef,
  recordAuthBounce,
  resetAuthBounceAuditThrottleForTests,
  resetAuthBounceSentryDedupForTests,
} from "@/lib/auth-diagnostics";
import { prisma } from "@/lib/prisma";

const SECRET_COOKIE_VALUE =
  // Test fixture: a fake/dummy JWT-shaped string used to verify session-token scrubbing; not a real credential.
  "eyJhbGciOiJkaXIifQ.super-secret-session-token-payload.tag";

function cookieStore(cookies: Array<{ name: string; value: string }>) {
  return { getAll: () => cookies };
}

function sessionCookie(value = SECRET_COOKIE_VALUE) {
  return { name: "__Secure-authjs.session-token", value };
}

async function flushAfterQueue() {
  await Promise.all(afterQueue.splice(0));
}

function auditCreate() {
  return vi.mocked(prisma.auditLog.create);
}

function memberFindUnique() {
  return vi.mocked(prisma.member.findUnique);
}

function lastAuditData() {
  const calls = auditCreate().mock.calls;
  const last = calls[calls.length - 1]?.[0] as {
    data: Record<string, unknown> & { metadata?: Record<string, unknown> };
  };
  return last.data;
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): tests install throwing
  // mockImplementations that must not leak into the next test.
  vi.resetAllMocks();
  afterQueue.length = 0;
  resetAuthBounceSentryDedupForTests();
  resetAuthBounceAuditThrottleForTests();
  mockHeaders.mockResolvedValue(
    new Headers({
      "user-agent": "vitest-agent",
      "x-forwarded-for": "203.0.113.9",
    })
  );
  mockCookies.mockResolvedValue(cookieStore([sessionCookie()]));
  mockProbe.mockResolvedValue(null);
  memberFindUnique().mockResolvedValue(null as never);
  auditCreate().mockResolvedValue({} as never);
});

describe("generateAuthBounceRef", () => {
  it("produces 8 uppercase hex chars", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateAuthBounceRef()).toMatch(/^[0-9A-F]{8}$/);
    }
  });
});

describe("recordAuthBounce noise gate", () => {
  it("stays quiet for anonymous no-cookie requests", async () => {
    mockCookies.mockResolvedValue(
      cookieStore([{ name: "authjs.csrf-token", value: "csrf" }])
    );

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    expect(ref).toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(auditCreate()).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    // The deeper (DB-touching) probe must not even run for anonymous hits.
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("treats a zero-length session cookie value as no-cookie", async () => {
    mockCookies.mockResolvedValue(
      cookieStore([{ name: "__Secure-authjs.session-token", value: "" }])
    );

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });

    expect(ref).toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    expect(auditCreate()).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("ignores legacy next-auth v4 cookies when classifying presence", async () => {
    mockCookies.mockResolvedValue(
      cookieStore([{ name: "next-auth.session-token", value: "stale" }])
    );

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });

    expect(ref).toBeNull();
    expect(auditCreate()).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe("recordAuthBounce classification", () => {
  it("records session-invalidated with the revocation delta and no Sentry event", async () => {
    mockProbe.mockResolvedValue({
      user: {
        id: "member-1",
        sessionInvalidated: true,
        sessionIssuedAt: 1_000,
      },
    });
    memberFindUnique().mockResolvedValue({
      passwordChangedAt: new Date(5_000),
    } as never);

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    expect(ref).toMatch(/^[0-9A-F]{8}$/);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).not.toHaveBeenCalled();

    const data = lastAuditData();
    expect(data.action).toBe("auth.bounce");
    // `security`, not the `auth` this used to pin (#2581). `auth` was never in the
    // audit taxonomy — it reached the column only through the writer type's old
    // `| (string & {})` escape — so these rows were selectable by no Admin category
    // filter and by no Diagnostics correlation tool. The affected domain is
    // authentication, so the canonical value is `security`, which the system
    // correlation entry reads with `support:view`.
    expect(data.category).toBe("security");
    expect(data.outcome).toBe("session-invalidated");
    expect(data.severity).toBe("info");
    expect(data.memberId).toBe("member-1");
    expect(data.requestId).toBe(ref);
    expect(data.userAgent).toBe("vitest-agent");
    expect(data.ipAddress).toBe("203.0.113.9");
    expect(data.retentionClass).toBe("diagnostic_high_volume");

    const metadata = data.metadata as Record<string, unknown>;
    expect(metadata.hasSessionCredential).toBe(true);
    expect(metadata.sessionChunkCount).toBe(1);
    expect(metadata.path).toBe("/dashboard");
    expect(metadata.sessionIssuedAt).toBe(new Date(1_000).toISOString());
    expect(metadata.credentialChangedAt).toBe(new Date(5_000).toISOString());
    expect(metadata.deltaMs).toBe(4_000);
  });

  it("records cookie-present-no-session and emits one scoped Sentry event", async () => {
    mockProbe.mockResolvedValue(null);

    const ref = await recordAuthBounce({
      layout: "admin",
      requestedPath: "/admin/dashboard",
    });
    await flushAfterQueue();

    expect(ref).toMatch(/^[0-9A-F]{8}$/);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);

    const data = lastAuditData();
    expect(data.outcome).toBe("cookie-present-no-session");
    expect(data.severity).toBe("important");
    expect(data.memberId).toBeUndefined();
    expect(data.requestId).toBe(ref);

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = mockCaptureMessage.mock.calls[0] as [
      string,
      {
        level: string;
        fingerprint: string[];
        tags: Record<string, string>;
        extra: Record<string, unknown>;
      },
    ];
    expect(message).toContain("Auth bounce anomaly");
    expect(options.level).toBe("warning");
    expect(options.fingerprint).toEqual([
      "auth-bounce",
      "cookie-present-no-session",
    ]);
    expect(options.tags).toEqual({
      scope: "auth-bounce",
      operation: "cookie-present-no-session",
    });
    expect(options.extra.ref).toBe(ref);
  });

  it("counts chunked session cookies", async () => {
    mockCookies.mockResolvedValue(
      cookieStore([
        { name: "__Secure-authjs.session-token.0", value: "aaaa" },
        { name: "__Secure-authjs.session-token.1", value: "bb" },
        { name: "other", value: "x" },
      ])
    );

    await recordAuthBounce({ layout: "authenticated", requestedPath: "/book" });
    await flushAfterQueue();

    const metadata = lastAuditData().metadata as Record<string, unknown>;
    expect(metadata.sessionChunkCount).toBe(2);
    expect(metadata.sessionChunkBytes).toBe(6);
  });

  it("flags a probe mismatch when the raw session is live and non-invalidated", async () => {
    mockProbe.mockResolvedValue({
      user: {
        id: "member-2",
        sessionInvalidated: false,
        sessionIssuedAt: 2_000,
      },
    });

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    expect(ref).toMatch(/^[0-9A-F]{8}$/);
    const data = lastAuditData();
    expect(data.outcome).toBe("cookie-present-no-session");
    expect(data.memberId).toBe("member-2");
    const metadata = data.metadata as Record<string, unknown>;
    expect(metadata.probeMismatch).toBe(true);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("classifies a throwing probe as the anomaly and records the error text", async () => {
    mockProbe.mockRejectedValue(new Error("decryption operation failed"));

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    expect(ref).toMatch(/^[0-9A-F]{8}$/);
    const metadata = lastAuditData().metadata as Record<string, unknown>;
    expect(metadata.probeError).toBe("Error: decryption operation failed");
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });
});

describe("recordAuthBounce Sentry dedup", () => {
  it("suppresses repeat anomaly events inside the cooldown window", async () => {
    await recordAuthBounce({ layout: "authenticated", requestedPath: "/a" });
    await recordAuthBounce({ layout: "authenticated", requestedPath: "/b" });
    await flushAfterQueue();

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    // The durable record is written for BOTH bounces — only the alert dedups.
    expect(auditCreate()).toHaveBeenCalledTimes(2);
  });
});

describe("recordAuthBounce durable-write throttle", () => {
  it("caps AuditLog rows per process-minute and tallies suppressed rows onto the next write", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-10T00:00:00Z"));
      for (let i = 0; i < 12; i += 1) {
        await recordAuthBounce({
          layout: "authenticated",
          requestedPath: `/page-${i}`,
        });
      }
      await flushAfterQueue();

      // Default budget is 10 rows per process-minute; the pino warn stays
      // unthrottled for every bounce.
      expect(auditCreate()).toHaveBeenCalledTimes(10);
      expect(mockLogger.warn).toHaveBeenCalledTimes(12);

      vi.setSystemTime(new Date("2026-07-10T00:01:01Z"));
      await recordAuthBounce({
        layout: "authenticated",
        requestedPath: "/after-window",
      });
      await flushAfterQueue();

      expect(auditCreate()).toHaveBeenCalledTimes(11);
      const metadata = lastAuditData().metadata as Record<string, unknown>;
      expect(metadata.suppressedSinceLastWrite).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the suppression tally when nothing was suppressed", async () => {
    await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    const metadata = lastAuditData().metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("suppressedSinceLastWrite");
  });
});

describe("recordAuthBounce exception safety", () => {
  it("still returns the ref when the audit write fails", async () => {
    auditCreate().mockRejectedValue(new Error("db down"));

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await expect(flushAfterQueue()).resolves.not.toThrow();

    expect(ref).toMatch(/^[0-9A-F]{8}$/);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ ref }),
      "Failed to persist auth-bounce audit row"
    );
  });

  it("resolves null instead of throwing when the cookie store is unavailable", async () => {
    mockCookies.mockRejectedValue(new Error("outside request scope"));

    await expect(
      recordAuthBounce({ layout: "authenticated", requestedPath: "/dashboard" })
    ).resolves.toBeNull();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it("keeps the ref and the durable write when Sentry throws", async () => {
    mockCaptureMessage.mockImplementation(() => {
      throw new Error("sentry transport exploded");
    });

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    expect(ref).toMatch(/^[0-9A-F]{8}$/);
    expect(auditCreate()).toHaveBeenCalledTimes(1);
    expect(lastAuditData().requestId).toBe(ref);
  });

  it("keeps the Sentry event and durable write when the pino line throws", async () => {
    mockLogger.warn.mockImplementation(() => {
      throw new Error("pino stream closed");
    });

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    expect(ref).toMatch(/^[0-9A-F]{8}$/);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(auditCreate()).toHaveBeenCalledTimes(1);
  });

  it("survives a member lookup failure during session-invalidated enrichment", async () => {
    mockProbe.mockResolvedValue({
      user: { id: "member-1", sessionInvalidated: true, sessionIssuedAt: 1_000 },
    });
    memberFindUnique().mockRejectedValue(new Error("db timeout"));

    const ref = await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    expect(ref).toMatch(/^[0-9A-F]{8}$/);
    const metadata = lastAuditData().metadata as Record<string, unknown>;
    expect(metadata.credentialChangedAt).toBeNull();
    expect(metadata.deltaMs).toBeNull();
  });
});

describe("recordAuthBounce privacy", () => {
  it("scrubs JWT- and JWE-shaped strings out of probe error text", async () => {
    // 5-segment JWE — the shape of a real authjs session cookie value.
    mockProbe.mockRejectedValue(
      new Error(
        "decode failed for token eyJhbGciOiJkaXIifQ.key-part.iv-part.ciphertext-part.tag-part in request"
      )
    );

    await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    const metadata = lastAuditData().metadata as Record<string, unknown>;
    expect(metadata.probeError).toBe(
      "Error: decode failed for token [REDACTED] in request"
    );

    const allSinkArgs = JSON.stringify([
      mockLogger.warn.mock.calls,
      mockCaptureMessage.mock.calls,
      auditCreate().mock.calls,
    ]);
    expect(allSinkArgs).not.toContain("ciphertext-part");
    expect(allSinkArgs).not.toContain("tag-part");
  });


  it("never lets the session cookie value reach any sink", async () => {
    mockProbe.mockResolvedValue(null);

    await recordAuthBounce({
      layout: "authenticated",
      requestedPath: "/dashboard",
    });
    await flushAfterQueue();

    const allSinkArgs = JSON.stringify([
      mockLogger.debug.mock.calls,
      mockLogger.info.mock.calls,
      mockLogger.warn.mock.calls,
      mockLogger.error.mock.calls,
      mockCaptureMessage.mock.calls,
      auditCreate().mock.calls,
    ]);

    expect(allSinkArgs).not.toContain(SECRET_COOKIE_VALUE);
    expect(allSinkArgs).not.toContain("super-secret-session-token-payload");
  });
});
