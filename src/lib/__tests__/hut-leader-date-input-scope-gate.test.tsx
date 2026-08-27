// @vitest-environment jsdom

/**
 * A late lodge-scope settle cannot clobber date input the operator has entered
 * (#2887 review).
 *
 * This exists because `occupancy-calendar-pages.test.tsx:106` fails
 * intermittently on a SYNCHRONOUS `toHaveValue` right after clicking the
 * (mocked) calendar's range button, and the obvious reading of that failure is
 * alarming: the page's own `[scopedLodgeId]` effect clears `selection`, so if a
 * settle can land after the operator has typed, their dates vanish. That would
 * be operator-visible data loss on a surface this PR changed.
 *
 * It cannot, and this pins why: the date inputs are inside `AssignmentForm`,
 * which sits behind TWO nested `lodgeScopeReady` gates, so there is nothing to
 * type into until the scope has settled and the clearing effect has already run
 * for that lodge. The failing test reaches the window only because `fireEvent`
 * can dispatch in the same tick as the commit that first renders the form,
 * before the passive effect that commit queued has flushed — a window a real
 * click cannot occupy, since React flushes pending passive effects before
 * dispatching a discrete input event.
 *
 * Mutation-proved: removing BOTH gates makes the first assertion fail with
 * `PRE-SETTLE has Start Date: true`. Removing only one leaves the other holding
 * the line, which is worth knowing — the redundancy is load-bearing.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/hut-leaders",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "a1",
        adminPermissionMatrix: {
          overview: "view", bookings: "edit", membership: "edit",
          finance: "edit", lodge: "edit", content: "view", support: "view",
        },
      },
    },
    status: "authenticated",
  }),
}));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
  useAdminAreaEditAccess: () => true,
}));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => false), confirmDialog: null }),
}));

import HutLeadersPage from "@/app/(admin)/admin/hut-leaders/page";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("hut-leader date inputs and the lodge-scope settle (#2887)", () => {
  it("offers no date input until the scope settles, and keeps what is typed after", async () => {
    let releaseLodges!: () => void;
    const lodgesPending = new Promise<Response>((resolve) => {
      releaseLodges = () =>
        resolve(
          Response.json({ lodges: [{ id: "lodge-1", name: "Lodge One", active: true }] }),
        );
    });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/admin/lodges")) return lodgesPending;
      if (url.includes("/api/admin/hut-leaders/eligible-members")) {
        return Response.json({ members: [] });
      }
      if (url.includes("/api/admin/hut-leaders/unassigned-dates")) {
        return Response.json({ unassignedDates: [] });
      }
      if (url.includes("/api/admin/hut-leaders")) {
        return Response.json({ assignments: [], members: [] });
      }
      if (url.includes("/api/admin/occupancy")) {
        return Response.json({ month: "2099-07", nights: [], bookings: [] });
      }
      return Response.json({});
    }));

    render(
      <ClubIdentityProvider value={clubIdentity}>
        <HutLeadersPage />
      </ClubIdentityProvider>,
    );

    // The gate: with the lodge list unresolved there is nothing to type into,
    // so "operator enters dates, a settle then clears them" cannot begin.
    await act(async () => {});
    expect(screen.queryByLabelText("Start Date")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("End Date")).not.toBeInTheDocument();

    await act(async () => {
      releaseLodges();
      await lodgesPending;
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Start Date")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2099-07-10" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2099-07-12" },
    });

    // Everything still in flight — the eligible-members read the dates trigger,
    // the overlay months, the assignments list — settles without touching them.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByLabelText("Start Date")).toHaveValue("2099-07-10");
    expect(screen.getByLabelText("End Date")).toHaveValue("2099-07-12");
  });
});
