/**
 * `INV-PRIV-021` (#2703) — admin-origin issue-report screenshots are
 * Full-Admin-only.
 *
 * WHAT THIS SUITE IS FOR. Viewing an issue report needs `support: view`, and
 * `support` is a separate permission area from `membership`. Before this
 * change, an officer given support access to triage issue reports and
 * deliberately NOT given membership access could read member names, addresses
 * and dates of birth off a screenshot captured on an admin member page. These
 * tests pin the boundary that closes it, on EVERY path that can emit or
 * announce the pixels: the list, the detail read, and the PATCH reply.
 *
 * THE ATTACK THE OWNER RULE NAMES FIRST is a forged `pageUrl`: the reporting
 * widget posts it, so any reporter controls it. The first test below files a
 * report whose `pageUrl` claims an admin member page and proves the stored
 * classification does not move — authorisation is decided from the reporter's
 * own server-side standing and from nothing the client sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { accessRoleDefinitionGrid } from "./helpers/access-role-definition-grid";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(async () => null),
  logAudit: vi.fn(),
  sendAdminIssueReportAlert: vi.fn(async () => undefined),
  memberFindUnique: vi.fn(),
  issueReportCreate: vi.fn(),
  issueReportFindMany: vi.fn(),
  issueReportCount: vi.fn(),
  issueReportFindUnique: vi.fn(),
  issueReportUpdate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));

vi.mock("@/lib/email", () => ({
  sendAdminIssueReportAlert: mocks.sendAdminIssueReportAlert,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    issueReport: {
      create: mocks.issueReportCreate,
      findMany: mocks.issueReportFindMany,
      count: mocks.issueReportCount,
      findUnique: mocks.issueReportFindUnique,
      update: mocks.issueReportUpdate,
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST as createIssueReport } from "@/app/api/issue-reports/route";
import { GET as listIssueReports } from "@/app/api/admin/issue-reports/route";
import {
  GET as getIssueReport,
  PATCH as patchIssueReport,
} from "@/app/api/admin/issue-reports/[id]/route";

const DAY_MS = 24 * 60 * 60 * 1000;
const PIXELS = "data:image/png;base64,cG5n";

/** Support:view through the read-only admin bundle. NOT the `ADMIN` role. */
const SUPPORT_VIEWER = [{ role: "ADMIN_READONLY" }];
/** Full Admin: the literal `ADMIN` role, which also carries support. */
const FULL_ADMIN = [{ role: "ADMIN" }];
/**
 * A member holding exactly the named areas and nothing else, built through the
 * shared grid so the baseline is DERIVED from `ADMIN_PERMISSION_AREAS` rather
 * than typed out here. A hand-written seven-column baseline leaves an
 * eighth area `undefined` the day one is added, which would silently widen
 * every "holds only this" fixture in this file.
 */
function onlyAreas(
  levels: Parameters<typeof accessRoleDefinitionGrid>[0],
  id: string
) {
  const roleDefinition = accessRoleDefinitionGrid(levels, id);
  return [{ role: null, roleDefinitionId: id, roleDefinition }];
}

/**
 * Support:EDIT without Full Admin. No seeded bundle grants that pair — only
 * `ADMIN` has `support: "edit"` — so it takes a club-defined custom role, which
 * is exactly the shape a club would build to let an officer resolve reports.
 */
const SUPPORT_EDITOR = onlyAreas({ supportLevel: "EDIT" }, "def-support-editor");

/**
 * One area, and deliberately NOT `membership` or `support`: a Lodge officer
 * with view access to the lodge screens and nothing else. Anything that
 * narrowed the origin predicate to "could this person see member records"
 * would classify this reporter MEMBER — and that is route-to-permission
 * reconstruction wearing a different hat, which the owner rule rejects by name.
 */
const LODGE_VIEW_ONLY = onlyAreas({ lodgeLevel: "VIEW" }, "def-lodge-view");

function signedInAs(accessRoles: unknown) {
  mocks.auth.mockResolvedValue({
    // A live session always carries `canLogin` (#3603); requireAdmin hands on
    // the DB-read value, which is true for anyone signed in.
    user: { id: "viewer-1", role: "ADMIN", accessRoles, canLogin: true },
  } as never);
}

function storedReport(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const capturedAt = new Date(Date.now() - DAY_MS);
  return {
    id: "issue-1",
    pageUrl: "http://localhost:3000/admin/members/member-9",
    pageTitle: "Member",
    description: "The member page threw an error.",
    screenshotDataUrl: PIXELS,
    screenshotOrigin: "ADMIN",
    screenshotCapturedAt: capturedAt,
    screenshotExpiresAt: new Date(Date.now() + 29 * DAY_MS),
    screenshotDeletedAt: null,
    screenshotDeletedById: null,
    screenshotDeleteReason: null,
    browserInfo: "Vitest Browser",
    browserInfoExpiresAt: new Date(Date.now() + 29 * DAY_MS),
    browserInfoDeletedAt: null,
    resolvedAt: null,
    resolvedById: null,
    resolutionNote: null,
    createdAt: capturedAt,
    updatedAt: capturedAt,
    member: {
      id: "member-1",
      firstName: "Casey",
      lastName: "Member",
      email: "casey@example.com",
    },
    ...overrides,
  };
}

async function readDetail() {
  const response = await getIssueReport(
    new NextRequest("http://localhost/api/admin/issue-reports/issue-1"),
    { params: Promise.resolve({ id: "issue-1" }) }
  );
  return { response, body: await response.json() };
}

function auditRows(action: string) {
  return mocks.logAudit.mock.calls
    .map(([entry]) => entry as Record<string, unknown>)
    .filter((entry) => entry.action === action);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  process.env.NEXTAUTH_URL = "http://localhost:3000";
});

describe("#2703 creation derives and persists the screenshot origin", () => {
  function reportBody(pageUrl: string) {
    return new NextRequest("http://localhost:3000/api/issue-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageUrl,
        pageTitle: "A page",
        description: "Something broke on this page.",
        screenshotDataUrl: PIXELS,
      }),
    });
  }

  function storedOrigin() {
    const [call] = mocks.issueReportCreate.mock.calls;
    return (call?.[0] as { data: { screenshotOrigin: string } }).data
      .screenshotOrigin;
  }

  beforeEach(() => {
    mocks.issueReportCreate.mockResolvedValue({ id: "issue-1" } as never);
  });

  it("classifies an ordinary member as MEMBER even when the posted pageUrl claims an admin page", async () => {
    signedInAs([{ role: "USER" }]);
    mocks.memberFindUnique.mockResolvedValue({
      id: "viewer-1",
      firstName: "Casey",
      lastName: "Member",
      email: "casey@example.com",
      accessRoles: [{ role: "USER" }],
    } as never);

    const response = await createIssueReport(
      reportBody("http://localhost:3000/admin/members/member-9")
    );

    expect(response.status).toBe(201);
    // The forged page address is stored verbatim as reported context, and it
    // decides NOTHING: the classification is MEMBER because the reporter is.
    expect(storedOrigin()).toBe("MEMBER");
  });

  it("classifies a reporter who holds any admin area as ADMIN", async () => {
    signedInAs([{ role: "USER" }]);
    mocks.memberFindUnique.mockResolvedValue({
      id: "viewer-1",
      firstName: "Ash",
      lastName: "Officer",
      email: "ash@example.com",
      accessRoles: SUPPORT_VIEWER,
    } as never);

    // A harmless member-facing page, and it makes no difference either: the
    // reporter could have reached an admin screen, so the capture is gated.
    const response = await createIssueReport(
      reportBody("http://localhost:3000/book")
    );

    expect(response.status).toBe(201);
    expect(storedOrigin()).toBe("ADMIN");
  });

  it("classifies a reporter holding ONE non-membership admin area as ADMIN", async () => {
    signedInAs([{ role: "USER" }]);
    mocks.memberFindUnique.mockResolvedValue({
      id: "viewer-1",
      firstName: "Robin",
      lastName: "Lodge",
      email: "robin@example.com",
      accessRoles: LODGE_VIEW_ONLY,
    } as never);

    const response = await createIssueReport(
      reportBody("http://localhost:3000/book")
    );

    expect(response.status).toBe(201);
    // "Any admin area at all", not "an area that can see member records". A
    // Lodge officer reaches admin screens, so their capture is gated.
    expect(storedOrigin()).toBe("ADMIN");
  });

  it("classifies as ADMIN when only the signed session still carries admin access", async () => {
    // The record has been stripped of admin roles since the token was minted;
    // the holder may still have had an admin screen open. Either source saying
    // admin is enough, so the classification can only err towards gating.
    signedInAs(SUPPORT_VIEWER);
    mocks.memberFindUnique.mockResolvedValue({
      id: "viewer-1",
      firstName: "Ash",
      lastName: "Officer",
      email: "ash@example.com",
      accessRoles: [{ role: "USER" }],
    } as never);

    const response = await createIssueReport(
      reportBody("http://localhost:3000/book")
    );

    expect(response.status).toBe(201);
    expect(storedOrigin()).toBe("ADMIN");
  });
});

describe("#2703 the detail read gates admin-origin pixels", () => {
  it("withholds pixels and every image field from a support viewer who is not a Full Admin", async () => {
    signedInAs(SUPPORT_VIEWER);
    mocks.issueReportFindUnique.mockResolvedValue(storedReport() as never);

    const { response, body } = await readDetail();

    expect(response.status).toBe(200);
    expect(body.report.screenshot.dataUrl).toBeNull();
    expect(body.report.screenshot.withheld).toBe(true);
    expect(body.report.screenshot.retained).toBe(true);
    expect(body.report.screenshot.disposition).toBe("withheld");
    // The rest of the report is untouched — the owner rule gates the pixels,
    // not the triage information.
    expect(body.report.description).toBe("The member page threw an error.");
    expect(body.report.browserInfo.value).toBe("Vitest Browser");
    // Nothing anywhere in the payload carries the image.
    expect(JSON.stringify(body)).not.toContain(PIXELS);
  });

  it("serves the pixels to a Full Admin holding the same report-read permission", async () => {
    signedInAs(FULL_ADMIN);
    mocks.issueReportFindUnique.mockResolvedValue(storedReport() as never);

    const { response, body } = await readDetail();

    expect(response.status).toBe(200);
    expect(body.report.screenshot.dataUrl).toBe(PIXELS);
    expect(body.report.screenshot.withheld).toBe(false);
    expect(body.report.screenshot.disposition).toBe("viewed");
  });

  it("leaves a member-origin screenshot on the ordinary support access model", async () => {
    signedInAs(SUPPORT_VIEWER);
    mocks.issueReportFindUnique.mockResolvedValue(
      storedReport({ screenshotOrigin: "MEMBER" }) as never
    );

    const { body } = await readDetail();

    expect(body.report.screenshot.dataUrl).toBe(PIXELS);
    expect(body.report.screenshot.withheld).toBe(false);
  });

  it("fails closed on a row written before this release, whose origin is NULL", async () => {
    signedInAs(SUPPORT_VIEWER);
    mocks.issueReportFindUnique.mockResolvedValue(
      storedReport({ screenshotOrigin: null }) as never
    );

    const { body } = await readDetail();

    expect(body.report.screenshot.dataUrl).toBeNull();
    expect(body.report.screenshot.withheld).toBe(true);
  });

  it("still shows a NULL-origin screenshot to a Full Admin", async () => {
    signedInAs(FULL_ADMIN);
    mocks.issueReportFindUnique.mockResolvedValue(
      storedReport({ screenshotOrigin: null }) as never
    );

    const { body } = await readDetail();

    expect(body.report.screenshot.dataUrl).toBe(PIXELS);
  });

  it("separates an expiry from an administrator's deletion in the audited disposition", async () => {
    signedInAs(FULL_ADMIN);
    mocks.issueReportFindUnique.mockResolvedValue(
      storedReport({
        screenshotDataUrl: null,
        screenshotDeletedAt: new Date(),
        screenshotDeleteReason: "retention_expired",
      }) as never
    );

    const { body } = await readDetail();

    expect(body.report.screenshot.disposition).toBe("expired");
    expect(auditRows("issue_report.admin_viewed")[0]?.details).toContain(
      '"screenshotDisposition":"expired"'
    );

    vi.clearAllMocks();
    mocks.issueReportFindUnique.mockResolvedValue(
      storedReport({
        screenshotDataUrl: null,
        screenshotDeletedAt: new Date(),
        screenshotDeleteReason: "Contained a member address",
      }) as never
    );

    const second = await readDetail();

    expect(second.body.report.screenshot.disposition).toBe("deleted");
  });
});

describe("#2703 the list and the detail read answer 'retained' identically", () => {
  /**
   * An expiry the nightly sweep has not reached yet: the blob is still in the
   * row and `screenshotDeletedAt` is still null, but `screenshotExpiresAt` has
   * passed. The detail route has always honoured that; the list route used to
   * answer from the capture and deletion stamps alone and called it retained,
   * so for the hours in between the queue advertised a screenshot the report
   * itself refused — and after #2703 the two would have disagreed about
   * `withheld` as well. One predicate now answers both.
   */
  function expiredButUnswept() {
    return storedReport({
      screenshotExpiresAt: new Date(Date.now() - DAY_MS),
      screenshotDeletedAt: null,
      screenshotDeleteReason: null,
    });
  }

  it("calls an expired-but-unswept screenshot expired on the detail read", async () => {
    signedInAs(FULL_ADMIN);
    mocks.issueReportFindUnique.mockResolvedValue(expiredButUnswept() as never);

    const { body } = await readDetail();

    expect(body.report.screenshot.disposition).toBe("expired");
    expect(body.report.screenshot.retained).toBe(false);
    expect(body.report.screenshot.dataUrl).toBeNull();
    expect(JSON.stringify(body)).not.toContain(PIXELS);
  });

  it("calls the same row expired on the list", async () => {
    signedInAs(FULL_ADMIN);
    mocks.issueReportFindMany.mockResolvedValue([expiredButUnswept()] as never);
    mocks.issueReportCount.mockResolvedValue(1 as never);

    const response = await listIssueReports(
      new NextRequest("http://localhost/api/admin/issue-reports?status=OPEN")
    );
    const body = await response.json();

    expect(body.reports[0].screenshot.disposition).toBe("expired");
    expect(body.reports[0].screenshot.retained).toBe(false);
    expect(body.reports[0].screenshot.withheld).toBe(false);
  });

  it("sends the same disposition from both routes for a live screenshot", async () => {
    signedInAs(SUPPORT_VIEWER);
    mocks.issueReportFindUnique.mockResolvedValue(storedReport() as never);
    mocks.issueReportFindMany.mockResolvedValue([storedReport()] as never);
    mocks.issueReportCount.mockResolvedValue(1 as never);

    const detail = await readDetail();
    const list = await listIssueReports(
      new NextRequest("http://localhost/api/admin/issue-reports?status=OPEN")
    );
    const listBody = await list.json();

    expect(detail.body.report.screenshot.disposition).toBe("withheld");
    expect(listBody.reports[0].screenshot.disposition).toBe("withheld");
  });
});

describe("#2703 the refusal is audited, and records nothing captured", () => {
  it("writes a withheld row beside the view row, categorised privacy", async () => {
    signedInAs(SUPPORT_VIEWER);
    mocks.issueReportFindUnique.mockResolvedValue(storedReport() as never);

    await readDetail();

    const withheld = auditRows("issue_report.screenshot_withheld");
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toMatchObject({
      category: "privacy",
      severity: "important",
      memberId: "viewer-1",
      targetId: "issue-1",
    });
    // The refusal row says why access was refused and nothing about the image
    // or the page it was taken on.
    expect(withheld[0]?.details).toBe(
      JSON.stringify({ reason: "admin_origin_requires_full_admin" })
    );
    expect(JSON.stringify(withheld[0])).not.toContain(PIXELS);

    const viewed = auditRows("issue_report.admin_viewed");
    expect(viewed).toHaveLength(1);
    expect(viewed[0]?.category).toBe("privacy");
    // Both fields come off the one classification, so they cannot disagree:
    // the pixels are still stored, and this caller was refused them.
    expect(viewed[0]?.details).toBe(
      JSON.stringify({ hasScreenshot: true, screenshotDisposition: "withheld" })
    );
  });

  it("writes no withheld row when the pixels were served", async () => {
    signedInAs(FULL_ADMIN);
    mocks.issueReportFindUnique.mockResolvedValue(storedReport() as never);

    await readDetail();

    expect(auditRows("issue_report.screenshot_withheld")).toHaveLength(0);
    expect(auditRows("issue_report.admin_viewed")[0]?.details).toContain(
      '"screenshotDisposition":"viewed"'
    );
  });
});

describe("#2703 the alternate paths cannot bypass the boundary", () => {
  it("does not announce an openable screenshot to a support viewer on the list", async () => {
    signedInAs(SUPPORT_VIEWER);
    mocks.issueReportFindMany.mockResolvedValue([storedReport()] as never);
    mocks.issueReportCount.mockResolvedValue(1 as never);

    const response = await listIssueReports(
      new NextRequest("http://localhost/api/admin/issue-reports?status=OPEN")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reports[0].screenshot.withheld).toBe(true);
    expect(body.reports[0].screenshot.dataUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(PIXELS);
  });

  it("announces a member-origin screenshot on the list exactly as before", async () => {
    signedInAs(SUPPORT_VIEWER);
    mocks.issueReportFindMany.mockResolvedValue([
      storedReport({ screenshotOrigin: "MEMBER" }),
    ] as never);
    mocks.issueReportCount.mockResolvedValue(1 as never);

    const response = await listIssueReports(
      new NextRequest("http://localhost/api/admin/issue-reports?status=OPEN")
    );
    const body = await response.json();

    expect(body.reports[0].screenshot.retained).toBe(true);
    expect(body.reports[0].screenshot.withheld).toBe(false);
  });

  it("withholds the pixels from the PATCH reply too, which carries the same payload", async () => {
    // A support-EDIT officer who is not a Full Admin resolves the report. The
    // reply is the detail payload, so it is the same boundary: before #2703 it
    // would have handed over the very pixels the GET beside it refuses.
    signedInAs(SUPPORT_EDITOR);
    mocks.issueReportFindUnique
      .mockResolvedValueOnce({
        id: "issue-1",
        screenshotDataUrl: PIXELS,
        screenshotDeletedAt: null,
      } as never)
      .mockResolvedValueOnce(storedReport() as never);
    mocks.issueReportUpdate.mockResolvedValue({ id: "issue-1" } as never);

    const response = await patchIssueReport(
      new NextRequest("http://localhost/api/admin/issue-reports/issue-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resolve", note: "Fixed" }),
      }),
      { params: Promise.resolve({ id: "issue-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.report.screenshot.dataUrl).toBeNull();
    expect(body.report.screenshot.withheld).toBe(true);
    expect(JSON.stringify(body)).not.toContain(PIXELS);
    // An action reply is not a view, and never was audited as one, so the
    // refusal row belongs to the READ path alone. The docs say exactly this.
    expect(auditRows("issue_report.admin_viewed")).toHaveLength(0);
    expect(auditRows("issue_report.screenshot_withheld")).toHaveLength(0);
  });

  it("still lets that same officer delete the screenshot they cannot see", async () => {
    // Deleting SHRINKS the exposure, so it stays on `support: edit`. Gating it
    // behind Full Admin would keep the pixels alive longer, which is backwards.
    signedInAs(SUPPORT_EDITOR);
    mocks.issueReportFindUnique
      .mockResolvedValueOnce({
        id: "issue-1",
        screenshotDataUrl: PIXELS,
        screenshotDeletedAt: null,
      } as never)
      .mockResolvedValueOnce(
        storedReport({
          screenshotDataUrl: null,
          screenshotDeletedAt: new Date(),
          screenshotDeleteReason: "Not needed",
        }) as never
      );
    mocks.issueReportUpdate.mockResolvedValue({ id: "issue-1" } as never);

    const response = await patchIssueReport(
      new NextRequest("http://localhost/api/admin/issue-reports/issue-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "deleteScreenshot",
          reason: "Not needed",
        }),
      }),
      { params: Promise.resolve({ id: "issue-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.issueReportUpdate).toHaveBeenCalled();
    expect(body.report.screenshot.disposition).toBe("deleted");
    expect(body.report.screenshot.retained).toBe(false);
  });
});
