import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2994 (epic #2992) — the member door of the club message board.
 *
 * The test that matters most here is that a body-supplied author name is
 * IGNORED. The central server cannot verify author identity — it trusts the
 * club's API key — so when a later child shares a post, that post is only as
 * honest as this route. Everything downstream inherits whatever this does.
 */

const mocks = vi.hoisted(() => ({
  loadEffectiveModuleFlags: vi.fn(),
  requireActiveSession: vi.fn(),
  // Typed explicitly: inferring from `async () => null` narrows the mock to
  // Promise<null> and the over-budget test cannot then return a Response.
  applyMemberScopedRateLimit: vi.fn<() => Promise<Response | null>>(
    async () => null,
  ),
  memberFindUnique: vi.fn(),
  clubPostCreate: vi.fn(),
  clubPostFindMany: vi.fn(async () => []),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));

vi.mock("@/lib/rate-limit", () => ({
  applyMemberScopedRateLimit: mocks.applyMemberScopedRateLimit,
  rateLimiters: { clubPostCreate: { id: "club-post-create", limit: 10, windowSeconds: 3600 } },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    clubPost: {
      create: mocks.clubPostCreate,
      findMany: mocks.clubPostFindMany,
    },
  },
}));

vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));

// The share path (epic #2992). Not configured in these tests, so the route's
// club-local behaviour -- which is what this suite pins -- is unchanged.
vi.mock("@/lib/servernz-config", () => ({
  isServerNzConfigured: vi.fn(async () => false),
}));
vi.mock("@/lib/club-post-sharing", () => ({
  shareOnePost: vi.fn(async () => ({ status: "skipped", reason: "not-requested" })),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET, POST } from "@/app/api/club-posts/route";

const MEMBER_ID = "member-1";

function post(body: unknown) {
  return new Request("https://club.test/api/club-posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

function get(query = "") {
  return new Request(
    `https://club.test/api/club-posts${query}`,
  ) as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadEffectiveModuleFlags.mockResolvedValue({ commsPortal: true });
  mocks.requireActiveSession.mockResolvedValue({
    ok: true,
    session: { user: { id: MEMBER_ID, role: "USER", accessRoles: [] } },
  });
  mocks.applyMemberScopedRateLimit.mockResolvedValue(null);
  mocks.memberFindUnique.mockResolvedValue({
    firstName: "Jo",
    lastName: "Whitcombe",
  });
  mocks.clubPostCreate.mockResolvedValue({ id: "post-1" });
  mocks.clubPostFindMany.mockResolvedValue([]);
});

describe("the module gate", () => {
  it("404s POST when commsPortal is off", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ commsPortal: false });
    const res = await POST(post({ content: "hello" }));
    expect(res.status).toBe(404);
    expect(mocks.clubPostCreate).not.toHaveBeenCalled();
  });

  it("404s GET when commsPortal is off", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ commsPortal: false });
    expect((await GET(get())).status).toBe(404);
  });

  it("is checked BEFORE the session, so an off module leaks nothing", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ commsPortal: false });
    await POST(post({ content: "hello" }));
    // A 401-then-404 ordering would tell an anonymous caller the route exists.
    expect(mocks.requireActiveSession).not.toHaveBeenCalled();
  });
});

describe("author identity", () => {
  it("takes the author from the SESSION, not the request body", async () => {
    const res = await POST(
      post({
        content: "Hut book is back at the lodge.",
        // Everything an attacker might hope is believed:
        authorName: "The Committee",
        authorMemberId: "member-999",
        author_name: "The Committee",
      }),
    );

    expect(res.status).toBe(201);
    const data = mocks.clubPostCreate.mock.calls[0][0].data;
    expect(data.authorMemberId).toBe(MEMBER_ID);
    expect(data.authorName).toBe("Jo Whitcombe");
    expect(JSON.stringify(data)).not.toContain("The Committee");
    expect(JSON.stringify(data)).not.toContain("member-999");
  });

  it("stores the name as a snapshot taken at write time", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      firstName: "Alex",
      lastName: "Rangi",
    });
    await POST(post({ content: "Chains needed on the access road." }));
    expect(mocks.clubPostCreate.mock.calls[0][0].data.authorName).toBe(
      "Alex Rangi",
    );
  });

  it("falls back rather than failing when a name is blank", async () => {
    mocks.memberFindUnique.mockResolvedValue({ firstName: " ", lastName: " " });
    const res = await POST(post({ content: "Anyone driving up Friday?" }));
    expect(res.status).toBe(201);
    expect(mocks.clubPostCreate.mock.calls[0][0].data.authorName).toBe(
      "A club member",
    );
  });

  it("refuses when the member vanished between the session and the write", async () => {
    mocks.memberFindUnique.mockResolvedValue(null);
    const res = await POST(post({ content: "hello" }));
    expect(res.status).toBe(403);
    expect(mocks.clubPostCreate).not.toHaveBeenCalled();
  });
});

describe("content rules at the door", () => {
  it("rejects an empty post with 400, not 500", async () => {
    const res = await POST(post({ content: "   " }));
    expect(res.status).toBe(400);
    expect(mocks.clubPostCreate).not.toHaveBeenCalled();
  });

  it("rejects an over-long post with 400", async () => {
    const res = await POST(post({ content: "x".repeat(4001) }));
    expect(res.status).toBe(400);
  });

  it("rejects a post naming more than six images with 400, not a silent truncation (#3091 r3)", async () => {
    const imgs = Array.from(
      { length: 7 },
      (unused, i) =>
        `<img src="/api/club-posts/images/${i.toString(16).padStart(32, "0")}" alt="" />`,
    ).join("");
    const res = await POST(
      post({ content: "seven pictures", bodyHtml: `<p>seven pictures</p>${imgs}` }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("at most 6 images");
    expect(mocks.clubPostCreate).not.toHaveBeenCalled();
  });

  it("rejects a body whose SANITISED form exceeds the column with 400, not an opaque 500 (#3091 r6)", async () => {
    // Sanitising grows anchors (target/rel appended), so markup inside the
    // client cap can come out over the column's 20,000.
    const anchors = Array.from(
      { length: 450 },
      (unused, i) => `<a href="https://example.org/${i}">x</a>`,
    ).join(" ");
    const res = await POST(post({ content: "links", bodyHtml: `<p>${anchors}</p>` }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("formatting");
    expect(mocks.clubPostCreate).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const bad = new Request("https://club.test/api/club-posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }) as unknown as Parameters<typeof POST>[0];
    expect((await POST(bad)).status).toBe(400);
  });

  it("stores markup as typed rather than stripping it", async () => {
    await POST(post({ content: "<b>bold</b>" }));
    expect(mocks.clubPostCreate.mock.calls[0][0].data.content).toBe("<b>bold</b>");
  });
});

describe("rate limiting and audit", () => {
  it("returns the limiter's own response when the member is over budget", async () => {
    const limited = new Response(null, { status: 429 });
    mocks.applyMemberScopedRateLimit.mockResolvedValue(limited);
    const res = await POST(post({ content: "hello" }));
    expect(res.status).toBe(429);
    expect(mocks.clubPostCreate).not.toHaveBeenCalled();
  });

  it("writes one communication-category audit row naming the post", async () => {
    await POST(post({ content: "Hut book is back." }));
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    const entry = mocks.logAudit.mock.calls[0][0];
    expect(entry.category).toBe("communication");
    expect(entry.memberId).toBe(MEMBER_ID);
    expect(entry.entityId).toBe("post-1");
  });

  it("does not copy the post body into the audit row", async () => {
    // The category is member-visible, the body is already stored once, and a
    // second copy would outlive any later moderation of the first.
    const body = "Something a member might later want taken down.";
    await POST(post({ content: body }));
    expect(JSON.stringify(mocks.logAudit.mock.calls[0][0])).not.toContain(body);
  });
});

describe("paging", () => {
  it("rejects half a cursor", async () => {
    expect((await GET(get("?before=2026-06-01T00:00:00.000Z"))).status).toBe(400);
    expect((await GET(get("?beforeId=post-1"))).status).toBe(400);
  });

  it("rejects an unparseable cursor rather than silently showing page one", async () => {
    const res = await GET(get("?before=not-a-date&beforeId=post-1"));
    expect(res.status).toBe(400);
  });

  it("accepts both halves together", async () => {
    const res = await GET(get("?before=2026-06-01T00:00:00.000Z&beforeId=post-1"));
    expect(res.status).toBe(200);
  });
});
