// @vitest-environment jsdom

// #2733: the audit-log member filter used to carry `memberName` and
// `memberEmail` in the page's own URL, so a member's name and email address
// reached browser history, every reverse-proxy/CDN access log, and the `Referer`
// of anything the page links out to — places the log/Sentry redactor of
// INV-PRIV-011 cannot reach. These tests pin the replacement contract: the URL
// round-trip carries `memberId` and nothing else, and an id-only URL still
// renders the right chip label because the label is resolved from the id — from
// the authorized members lookup first, and from the audit rows already on screen
// when that lookup cannot answer.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { StrictMode, useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditTimelineEntry } from "@/lib/audit-query";

let currentSearchParams = new URLSearchParams();
// Opt-in per test: with this on, `router.replace` feeds its address back into
// `useSearchParams`, so a rewrite composed FROM a rewrite is observable and the
// convergence of the legacy-URL rewrite is provable. Off by default, because a
// fresh `useSearchParams` identity re-runs the page's audit query and would
// defeat the single-fetch pin below.
let reflectReplaceIntoSearchParams = false;

// Created ONCE at module scope, not per `useRouter()` call. A mock that rebuilt
// `push: vi.fn()` on every call threw away every recorded call, so a regression
// that navigated with a person's name in the address could not be seen.
const replace = vi.fn((path: string) => {
  if (!reflectReplaceIntoSearchParams) return;
  currentSearchParams = new URLSearchParams(String(path).split("?")[1] ?? "");
});
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push }),
  useSearchParams: () => currentSearchParams,
}));

// Opaque, cuid-shaped. An id that spelt the member's name ("member-jane") would
// have let a URL assertion pass on the name being present in the id rather than
// on the name being absent from the URL.
const JANE = {
  id: "cmf3q7x2b0000t9hk4v1r8zqy",
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.test",
  role: "MEMBER",
};

// The members search matches an id by PREFIX as well as by name and email, so a
// longer id starting with the filtered one is a legitimate extra row. The chip
// must resolve to the exact id, never to the first row that came back.
const PREFIX_SIBLING = {
  id: `${JANE.id}zz`,
  firstName: "Wrong",
  lastName: "Person",
  email: "wrong@example.test",
  role: "MEMBER",
};

const CHIP_LOADING = "Loading member...";
const CHIP_UNRESOLVED = "Selected member";

const LABEL_LOOKUP_URL = `/api/admin/members?q=${JANE.id}&pageSize=8&includeArchived=true`;

type MemberRow = typeof JANE;

/** One scripted reply from `/api/admin/members`. */
type MembersLookupReply =
  | { kind: "ok"; members: MemberRow[] }
  | { kind: "status"; status: number }
  | { kind: "reject" };

const baseAuditRow: AuditTimelineEntry = {
  id: "audit-row-1",
  action: "member.updated",
  category: "account",
  severity: null,
  outcome: null,
  summary: "Member record updated",
  description: null,
  details: null,
  createdAt: "2026-08-01T02:00:00.000Z",
  actor: null,
  actorDisplayName: "System",
  subject: null,
  subjectDisplayName: null,
  subjectMemberId: null,
  entityType: null,
  entityId: null,
  drilldowns: [],
  metadata: null,
};

function auditRow(overrides: Partial<AuditTimelineEntry>): AuditTimelineEntry {
  return { ...baseAuditRow, ...overrides };
}

/** A row that names nobody — its display names must never become a chip label. */
const SYSTEM_ROW = auditRow({ id: "audit-row-system" });

/** A row about somebody else — exact-id matching must skip it. */
const OTHER_MEMBER_ROW = auditRow({
  id: "audit-row-other",
  actor: {
    id: "cmf0000000000other0000000",
    firstName: "Someone",
    lastName: "Else",
    email: "someone@example.test",
  },
  actorDisplayName: "Someone Else",
});

const JANE_ACTOR_ROW = auditRow({
  id: "audit-row-jane-actor",
  actor: {
    id: JANE.id,
    firstName: JANE.firstName,
    lastName: JANE.lastName,
    email: JANE.email,
  },
  actorDisplayName: "Jane Doe",
});

const JANE_SUBJECT_ROW = auditRow({
  id: "audit-row-jane-subject",
  subject: {
    id: JANE.id,
    firstName: JANE.firstName,
    lastName: JANE.lastName,
  },
  subjectDisplayName: "Jane Doe",
  subjectMemberId: JANE.id,
});

function auditPage(entries: AuditTimelineEntry[]) {
  return {
    data: entries,
    total: entries.length,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    facets: {
      eventTypes: [],
      categories: [],
      entityTypes: [],
      outcomes: [],
      severities: [],
    },
  };
}

let requestedUrls: string[] = [];
let auditEntries: AuditTimelineEntry[] = [];
/** Consumed in order; when it runs dry the default reply is used. */
let membersLookupScript: MembersLookupReply[] = [];
let membersLookupDefault: MembersLookupReply = {
  kind: "ok",
  members: [PREFIX_SIBLING, JANE],
};

function stubFetch() {
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);

    if (url.startsWith("/api/admin/audit-log?")) {
      return { ok: true, json: async () => auditPage(auditEntries) } as Response;
    }

    if (url.startsWith("/api/admin/members?")) {
      const reply = membersLookupScript.shift() ?? membersLookupDefault;
      if (reply.kind === "reject") {
        throw new Error("network down");
      }
      if (reply.kind === "status") {
        return {
          ok: false,
          status: reply.status,
          json: async () => ({ error: "Refused" }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ members: reply.members }),
      } as Response;
    }

    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
}

/**
 * Snapshots the page text during the FIRST commit's layout-effect phase, which
 * React runs before any passive effect — so this sees what the browser paints
 * before the label-resolution effect has run at all.
 */
function FirstPaintProbe({
  children,
  onFirstPaint,
}: {
  children: ReactNode;
  onFirstPaint: (text: string) => void;
}) {
  useLayoutEffect(() => {
    onFirstPaint(document.body.textContent ?? "");
  }, [onFirstPaint]);

  return <>{children}</>;
}

async function renderAuditLogPage(
  options: { strict?: boolean; onFirstPaint?: (text: string) => void } = {},
) {
  const AuditLogPage = (await import("@/app/(admin)/admin/audit-log/page")).default;
  const page = options.onFirstPaint ? (
    <FirstPaintProbe onFirstPaint={options.onFirstPaint}>
      <AuditLogPage />
    </FirstPaintProbe>
  ) : (
    <AuditLogPage />
  );

  render(options.strict ? <StrictMode>{page}</StrictMode> : page);
}

/**
 * The member chip's own label, read through the clear button so it can never be
 * satisfied by the same name appearing in the Actor/Subject columns of the table
 * (which, for this audience, the audit API populates for every row).
 */
function memberChipLabel() {
  const chip = screen.getByLabelText("Clear member filter").parentElement;
  if (!chip) throw new Error("member filter chip not found");
  return chip.firstElementChild?.textContent ?? "";
}

/** Every address this page put in front of the browser, decoded for assertions. */
function replacedPaths() {
  return replace.mock.calls.map(([path]) => decodeURIComponent(String(path)));
}

function labelLookupUrls() {
  // `includeArchived=true` is only ever sent by the label resolver, never by the
  // picker's own search, so it separates the two callers of this route.
  return requestedUrls.filter(
    (url) =>
      url.startsWith("/api/admin/members?") && url.includes("includeArchived=true"),
  );
}

function auditRequestUrls() {
  return requestedUrls.filter((url) => url.startsWith("/api/admin/audit-log?"));
}

function expectNoPersonFields(values: string[]) {
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(value).not.toContain("memberName");
    expect(value).not.toContain("memberEmail");
    expect(value).not.toContain(JANE.firstName);
    expect(value).not.toContain(JANE.lastName);
    expect(value).not.toContain(JANE.email);
    expect(value).not.toContain("@");
  }
}

beforeEach(() => {
  requestedUrls = [];
  auditEntries = [];
  membersLookupScript = [];
  membersLookupDefault = { kind: "ok", members: [PREFIX_SIBLING, JANE] };
  reflectReplaceIntoSearchParams = false;
  currentSearchParams = new URLSearchParams();
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("admin audit log member filter URL (#2733)", () => {
  it("resolves the chip label from an id-only URL and keeps the URL id-only", async () => {
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    await waitFor(() => expect(memberChipLabel()).toBe("Jane Doe"));
    expect(screen.queryByText("Wrong Person")).not.toBeInTheDocument();

    // The label came from the authorized members lookup, keyed by the id — and
    // it asks for archived members too, or an archived actor's chip could never
    // resolve (`listAdminMembers` defaults `archivedAt: null`).
    expect(labelLookupUrls()).toEqual([LABEL_LOOKUP_URL]);

    const paths = replacedPaths();
    expect(paths.every((path) => path.includes(`memberId=${JANE.id}`))).toBe(true);
    expectNoPersonFields(paths);
    expectNoPersonFields(auditRequestUrls());
    // No navigation may carry the person either — `push` is a stable spy, so an
    // address composed with a name would be recorded here.
    expect(push).not.toHaveBeenCalled();
  });

  it("resolves the chip under StrictMode's double-invoked mount effects", async () => {
    // Next leaves React StrictMode ON in dev (`next.config.ts` sets no
    // `reactStrictMode`), so mount → cleanup → remount is the normal dev path.
    // The first attempt's result is discarded by its cleanup; unless the
    // one-attempt-per-id marker is cleared for an attempt that never settled,
    // the remounted effect early-returns and the chip stays on "Loading
    // member..." for the life of the page. No audit rows here on purpose: the
    // entries-derived fallback must not be able to mask it.
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage({ strict: true });

    await waitFor(() => expect(memberChipLabel()).toBe("Jane Doe"));
    expect(memberChipLabel()).not.toBe(CHIP_LOADING);
    expect(memberChipLabel()).not.toBe(CHIP_UNRESOLVED);
  });

  it("opens on the loading label, never flashing the terminal label first", async () => {
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });
    let firstPaint = "";

    await renderAuditLogPage({
      onFirstPaint: (text) => {
        firstPaint = text;
      },
    });

    // Read before any passive effect ran, so this is the resolving flag's SEEDED
    // initial value, not a value an effect corrected a render later.
    expect(firstPaint).toContain(CHIP_LOADING);
    expect(firstPaint).not.toContain(CHIP_UNRESOLVED);

    await waitFor(() => expect(memberChipLabel()).toBe("Jane Doe"));
  });

  it("does not re-run the audit query while resolving the label", async () => {
    // Resolving a display name must not silently double every audit query: the
    // label lives outside the query the id already expresses.
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    await waitFor(() => expect(memberChipLabel()).toBe("Jane Doe"));
    expect(auditRequestUrls()).toHaveLength(1);
  });

  it("rewrites a bookmarked pre-#2733 URL without its name and email params", async () => {
    // The legacy params deliberately hold the WRONG person. If the chip ever
    // read the label out of the URL again instead of resolving it from the id,
    // this is what would appear.
    currentSearchParams = new URLSearchParams({
      memberId: JANE.id,
      memberName: "Impostor Name",
      memberEmail: "impostor@example.test",
      page: "2",
    });

    await renderAuditLogPage();

    await waitFor(() => expect(replace).toHaveBeenCalled());
    await waitFor(() => expect(memberChipLabel()).toBe("Jane Doe"));
    expect(memberChipLabel()).not.toContain("Impostor");
    expect(screen.queryByText(/Impostor/)).not.toBeInTheDocument();
    // The name on the chip was fetched, not copied out of the address.
    expect(labelLookupUrls()).toEqual([LABEL_LOOKUP_URL]);

    const paths = replacedPaths();
    expect(paths.every((path) => path.includes(`memberId=${JANE.id}`))).toBe(true);
    // Unrelated URL context still survives the rewrite.
    expect(paths.every((path) => path.includes("page=2"))).toBe(true);
    expectNoPersonFields(paths);
    expectNoPersonFields(auditRequestUrls());
  });

  it("preserves every other filter and unmanaged param through the legacy rewrite", async () => {
    currentSearchParams = new URLSearchParams({
      memberId: JANE.id,
      memberName: "Impostor Name",
      memberEmail: "impostor@example.test",
      memberScope: "actor",
      from: "2026-07-01",
      to: "2026-07-31",
      category: "account",
      eventType: "member.updated",
      outcome: "success",
      severity: "info",
      entityType: "Member",
      q: "late checkout",
      returnTo: "/admin/dashboard",
    });

    await renderAuditLogPage();

    await waitFor(() => expect(replace).toHaveBeenCalled());

    const latest = replacedPaths().at(-1) ?? "";
    for (const survivor of [
      `memberId=${JANE.id}`,
      "memberScope=actor",
      "from=2026-07-01",
      "to=2026-07-31",
      "category=account",
      "eventType=member.updated",
      "outcome=success",
      "severity=info",
      "entityType=Member",
      // `URLSearchParams` serialises a space as `+`, which `decodeURIComponent`
      // leaves alone — assert what is actually on the wire.
      "q=late+checkout",
      // Not a filter this page manages, and it must not be collateral damage.
      "returnTo=/admin/dashboard",
    ]) {
      expect(latest).toContain(survivor);
    }
    expect(latest).not.toContain("memberName");
    expect(latest).not.toContain("memberEmail");
    expect(latest).not.toContain("Impostor");
  });

  it("strips a legacy name param that arrives without a memberId", async () => {
    // A truncated or hand-edited legacy bookmark. There is no chip to label, but
    // the person fields still must not be carried forward.
    currentSearchParams = new URLSearchParams({
      memberName: "Impostor Name",
      memberEmail: "impostor@example.test",
      page: "3",
    });

    await renderAuditLogPage();

    await waitFor(() => expect(replace).toHaveBeenCalled());

    const paths = replacedPaths();
    expect(paths.every((path) => path.includes("page=3"))).toBe(true);
    expectNoPersonFields(paths);
    // Nothing to resolve, so nothing was asked of the members route.
    expect(labelLookupUrls()).toEqual([]);
    expect(screen.queryByLabelText("Clear member filter")).not.toBeInTheDocument();
  });

  it("converges: an address rewritten from a rewritten address stays clean", async () => {
    reflectReplaceIntoSearchParams = true;
    currentSearchParams = new URLSearchParams({
      memberId: JANE.id,
      memberName: "Impostor Name",
      memberEmail: "impostor@example.test",
    });

    await renderAuditLogPage();

    await waitFor(() => expect(memberChipLabel()).toBe("Jane Doe"));

    // Each rewrite is composed from the URL the previous rewrite installed, so
    // this proves the legacy keys do not come back once removed, rather than
    // only that the first rewrite dropped them.
    expectNoPersonFields(replacedPaths());
    expect(replacedPaths().at(-1)).toBe(`/admin/audit-log?memberId=${JANE.id}`);
  });

  it("puts only the id in the URL when a member is picked from the search box", async () => {
    await renderAuditLogPage();

    // The picker debounces by 250ms before it fetches, well inside RTL's default
    // 1000ms findBy* timeout.
    fireEvent.change(screen.getByPlaceholderText("Name, email, or ID"), {
      target: { value: "Jane" },
    });

    fireEvent.click(await screen.findByRole("button", { name: /Jane Doe/ }));

    await waitFor(() =>
      expect(
        replacedPaths().some((path) => path.includes(`memberId=${JANE.id}`)),
      ).toBe(true),
    );

    // A picked member arrives already named, so there is nothing to resolve: no
    // second round trip, and no placeholder to flash.
    expect(memberChipLabel()).toBe("Jane Doe");
    expect(labelLookupUrls()).toEqual([]);
    expect(screen.queryByText(CHIP_LOADING)).not.toBeInTheDocument();
    expect(screen.queryByText(CHIP_UNRESOLVED)).not.toBeInTheDocument();

    expectNoPersonFields(replacedPaths());
    expectNoPersonFields(auditRequestUrls());
  });

  it("names the chip from the audit rows when the member lookup is refused", async () => {
    // An audit reader holds `support:view`; the members search is gated on
    // `membership:view`. A refusal must not widen anything — but the audit rows
    // this page already loaded carry the actor's and subject's names for this
    // audience, so the same name is repeated down the table. A neutral chip
    // beside it protects nothing and only makes the filter unreadable.
    membersLookupDefault = { kind: "status", status: 401 };
    auditEntries = [SYSTEM_ROW, OTHER_MEMBER_ROW, JANE_ACTOR_ROW];
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    await waitFor(() => expect(memberChipLabel()).toBe("Jane Doe"));
    // Exactly one ask: a 4xx is the reader's answer and is never retried.
    expect(labelLookupUrls()).toEqual([LABEL_LOOKUP_URL]);

    const paths = replacedPaths();
    expect(paths.every((path) => path.includes(`memberId=${JANE.id}`))).toBe(true);
    expectNoPersonFields(paths);
  });

  it("keeps the neutral label when the lookup is refused and no row names the member", async () => {
    membersLookupDefault = { kind: "status", status: 401 };
    auditEntries = [SYSTEM_ROW, OTHER_MEMBER_ROW];
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    await waitFor(() => expect(memberChipLabel()).toBe(CHIP_UNRESOLVED));
    expect(replacedPaths().every((path) => path.includes(`memberId=${JANE.id}`))).toBe(
      true,
    );
  });

  it("falls back to the audit rows when the lookup returns no member at all", async () => {
    // A distinct branch from the 401: the reader may read the roll, and the roll
    // has nothing under this id (purged, or an id that never existed). One ask,
    // no retry, and the subject side of the row fallback answers.
    membersLookupDefault = { kind: "ok", members: [] };
    auditEntries = [SYSTEM_ROW, JANE_SUBJECT_ROW];
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    await waitFor(() => expect(memberChipLabel()).toBe("Jane Doe"));
    expect(labelLookupUrls()).toEqual([LABEL_LOOKUP_URL]);
  });

  it("retries a transient lookup failure exactly once, and succeeds", async () => {
    membersLookupScript = [{ kind: "reject" }, { kind: "status", status: 503 }];
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    // First attempt: network error, retried. That retry 503s, which is where the
    // bounded budget stops — so the chip must NOT resolve from the lookup.
    await waitFor(() => expect(labelLookupUrls()).toHaveLength(2));
    await waitFor(() => expect(memberChipLabel()).toBe(CHIP_UNRESOLVED));
    expect(labelLookupUrls()).toHaveLength(2);
  });

  it("recovers when the retry after a transient failure answers", async () => {
    membersLookupScript = [{ kind: "reject" }];
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    await waitFor(() => expect(memberChipLabel()).toBe("Jane Doe"));
    expect(labelLookupUrls()).toHaveLength(2);
  });

  it("gives up on a network failure without stranding the loading label", async () => {
    membersLookupDefault = { kind: "reject" };
    currentSearchParams = new URLSearchParams({ memberId: JANE.id });

    await renderAuditLogPage();

    await waitFor(() => expect(memberChipLabel()).toBe(CHIP_UNRESOLVED));
    expect(memberChipLabel()).not.toBe(CHIP_LOADING);
    expect(labelLookupUrls()).toHaveLength(2);
  });
});
