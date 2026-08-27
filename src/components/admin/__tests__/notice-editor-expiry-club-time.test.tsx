// @vitest-environment jsdom

import {
  CLUB_TIME_TEST_ZONE,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE NOTICE EXPIRY FIELD IS THE ONLY PLACE IN THIS GROUP THAT WRITES A TIME
 * (CT-4, #2870; epic #2988 rule 4; INV-CONFIG-002).
 *
 * ## Why this file exists when the rest of the group is read-only
 *
 * Every other migrated surface RENDERS an instant somebody else recorded: get the
 * zone wrong and a screen is a few hours out until somebody fixes it. This field
 * is the other direction. An officer types a wall-clock time into a
 * `datetime-local` control and it is converted to an INSTANT and stored, so a
 * wrong zone is written into the database and stays wrong after the bug is fixed
 * — the notice really does disappear at the wrong hour, and nothing on any screen
 * says so. It is also the only `datetime-local` in the tree, so it is the only
 * control that presents itself to the reader as their own clock.
 *
 * What it replaced used the browser's clock in BOTH directions (`d.getHours()`
 * filling the control, `new Date(value).toISOString()` reading it back), so an
 * officer in London who typed 5pm stored 4am the next day at a New Zealand club,
 * and a colleague opening the same notice at the lodge saw a different time from
 * the one that was typed.
 *
 * ## What "discriminating" means here
 *
 * Three zones are in play at once and they are deliberately all different:
 *
 *  - the CLUB's persisted zone, `America/Denver`, mounted on the provider;
 *  - `APP_TIME_ZONE`, which is `Pacific/Auckland` wherever `TZ` is unset — CI
 *    included — and is what the harness's default provider carries;
 *  - the BROWSER's own clock, pinned to `Asia/Tokyo` below, which agrees with
 *    neither.
 *
 * Each case asserts an answer only the club's zone produces, so an implementation
 * reading the environment, the viewer's clock, or a hard-coded zone fails. The
 * write case comes as a PAIR — the same typed wall time under two provider zones,
 * asserted to store two different instants — which is what makes it about the
 * PROVIDER rather than about a hard-coded offset.
 */

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

/*
  An all-edit admin, so the Save control is live and the flow below is about the
  expiry field rather than about permissions.

  PARTIAL, via `importOriginal`: the module also exports
  `ADMIN_VIEW_ONLY_ACTION_REASON`, which `ViewOnlyActionButton` reads as a default
  parameter — so replacing the module wholesale kills the file at import with
  "No ... export is defined on the ... mock" before a single test runs.
*/
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/use-admin-area-edit-access")
  >()),
  useAdminAreaEditAccess: () => true,
}));

/*
  The rich-text editor is a large contenteditable component with its own tests;
  here it only has to hand back a non-empty body so validation passes. The real
  one is mocked out rather than driven, because nothing in this file is about it.
*/
vi.mock("@/components/admin/page-content-panel", () => ({
  WysiwygEditor: () => <div data-testid="wysiwyg" />,
}));

vi.mock("@/components/admin/notice-audience-picker", () => ({
  NoticeAudiencePicker: () => <div data-testid="audience-picker" />,
}));

import { NoticeEditor } from "@/components/admin/notice-editor";
import { ClubTimeProvider } from "@/components/club-time-provider";
import type { AdminNoticeData } from "@/components/admin/notice-editor";

/** Behind UTC, so it disagrees with the harness zone and with a UTC host. */
const CLUB_ZONE_BEHIND_UTC = "America/Denver";

/** The viewer's own clock, agreeing with neither zone under test. */
const BROWSER_ZONE = "Asia/Tokyo";

/**
 * The stored expiry: 17:00 on 20 July 2026 in DENVER (UTC-6 in July) is
 * 23:00 UTC the same day. In `Pacific/Auckland` that same instant is 11:00 on
 * 21 July, and in `Asia/Tokyo` it is 08:00 on 21 July — three different clock
 * faces for one moment, which is what makes the assertions below discriminate.
 */
const STORED_EXPIRY = "2026-07-20T23:00:00.000Z";

function noticeWithExpiry(expiresAt: string | null): AdminNoticeData {
  return {
    id: "notice-1",
    title: "Lodge closed for maintenance",
    status: "DRAFT",
    bodyHtml: "<p>The lodge is closed.</p>",
    publishedAt: null,
    expiresAt,
    pinned: false,
    requiresAcknowledgement: false,
    financialMembersOnly: false,
    emailedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    createdByName: "Ada Officer",
    audiences: [],
    audienceCount: 0,
    readCount: 0,
    acknowledgedCount: 0,
  };
}

function providerFor(zone: string) {
  return function PinnedClubTime({ children }: { children: ReactNode }) {
    return <ClubTimeProvider zone={zone}>{children}</ClubTimeProvider>;
  };
}

function renderEditor(zone: string, expiresAt: string | null) {
  return render(
    <NoticeEditor mode="edit" notice={noticeWithExpiry(expiresAt)} />,
    { wrapper: providerFor(zone) },
  );
}

function expiryInput(): HTMLInputElement {
  return screen.getByLabelText("Expiry (optional)") as HTMLInputElement;
}

function installFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "notice-1" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The `expiresAt` the editor sent, as an ISO string. */
async function savedExpiry(fetchMock: ReturnType<typeof installFetch>) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    { body: string },
  ];
  return (JSON.parse(init.body) as { expiresAt: string | null }).expiresAt;
}

const hostTimeZone = { value: process.env.TZ };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // An ASSIGNMENT is what makes Node re-derive its zone; deleting alone leaves
  // the last one cached (#2485). Same reasoning as `helpers/timezone.ts`.
  if (hostTimeZone.value === undefined) {
    process.env.TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
    delete process.env.TZ;
  } else {
    process.env.TZ = hostTimeZone.value;
  }
});

describe("NoticeEditor expiry, read back from a stored instant", () => {
  it("fills the control with the CLUB's clock face, not the viewer's", () => {
    process.env.TZ = BROWSER_ZONE;
    renderEditor(CLUB_ZONE_BEHIND_UTC, STORED_EXPIRY);

    // 17:00 in Denver. The browser's own reading of the same instant is 08:00 on
    // the 21st, and `APP_TIME_ZONE`'s is 11:00 on the 21st; neither may appear.
    expect(expiryInput().value).toBe("2026-07-20T17:00");
  });

  it("fills it differently for a club in a different zone", () => {
    // The mirror image, and it is what makes the case above about the PROVIDER
    // rather than about a hard-coded 17:00.
    process.env.TZ = BROWSER_ZONE;
    renderEditor(CLUB_TIME_TEST_ZONE, STORED_EXPIRY);

    expect(expiryInput().value).toBe("2026-07-21T11:00");
  });

  it("names the club's zone on screen, because the widget will not", () => {
    /*
      A `datetime-local` control shows no zone and the browser presents it as
      local time, so an officer in London typing 5pm has nothing telling them they
      are setting 5pm at the club. The behaviour is right; the silence was not.
    */
    renderEditor(CLUB_ZONE_BEHIND_UTC, STORED_EXPIRY);

    expect(
      screen.getByText(
        new RegExp(`Times here are the club's \\(${CLUB_ZONE_BEHIND_UTC}\\)`),
      ),
    ).not.toBeNull();
  });
});

describe("NoticeEditor expiry, written back as an instant", () => {
  it("stores a typed wall time as that hour AT THE CLUB", async () => {
    process.env.TZ = BROWSER_ZONE;
    const fetchMock = installFetch();
    renderEditor(CLUB_ZONE_BEHIND_UTC, null);

    // The officer types five o'clock on the twentieth.
    fireEvent.change(expiryInput(), {
      target: { value: "2026-07-20T17:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));

    // 17:00 in Denver (UTC-6 in July) is 23:00 UTC. Read as the browser's own
    // clock it would be 08:00 UTC, and as `APP_TIME_ZONE` it would be 05:00 UTC
    // — both a different stored moment, neither of them what was typed.
    expect(await savedExpiry(fetchMock)).toBe(STORED_EXPIRY);
  });

  it("stores the SAME typed wall time as a different instant for another club", async () => {
    // The other half of the pair. An implementation that ignored the provider —
    // reading the environment, the viewer's clock, or a hard-coded zone — writes
    // the same instant for both halves and fails one of them.
    process.env.TZ = BROWSER_ZONE;
    const fetchMock = installFetch();
    renderEditor(CLUB_TIME_TEST_ZONE, null);

    fireEvent.change(expiryInput(), {
      target: { value: "2026-07-20T17:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));

    // 17:00 in Pacific/Auckland (UTC+12) is 05:00 UTC the same day.
    expect(await savedExpiry(fetchMock)).toBe("2026-07-20T05:00:00.000Z");
  });

  it("round-trips: what is read back is what was typed", async () => {
    /*
      The two directions are separate functions (`wallTimeOf` and `atWallTime`),
      and a zone error in only ONE of them is the shape that hides best: the
      officer types 5pm, the wrong instant is stored, and the form still shows 5pm
      when they reopen it because the same error runs backwards. This asserts the
      composition against the STORED value rather than against the form.
    */
    process.env.TZ = BROWSER_ZONE;
    const fetchMock = installFetch();
    const { unmount } = renderEditor(CLUB_ZONE_BEHIND_UTC, null);

    fireEvent.change(expiryInput(), {
      target: { value: "2026-07-20T17:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save draft/ }));
    const stored = await savedExpiry(fetchMock);
    unmount();

    // Reopened by a colleague AT THE LODGE, whose browser is somewhere else
    // again — the case the field's docblock is about.
    process.env.TZ = "Europe/London";
    renderEditor(CLUB_ZONE_BEHIND_UTC, stored);
    expect(expiryInput().value).toBe("2026-07-20T17:00");
  });
});
