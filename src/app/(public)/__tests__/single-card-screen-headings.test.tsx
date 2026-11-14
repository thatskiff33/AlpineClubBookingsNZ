// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4951 — every render state of a single-card public screen has exactly one
 * level-1 heading.
 *
 * These screens are reached from an email link and show one card. Before #4951
 * the card title only LOOKED like a heading, so a screen reader's heading list
 * was empty. The card title is now the page's h1 (`headingLevel={1}`), and a
 * loading state with no visible title carries an sr-only one — so each state
 * below must expose one, and only one, level-1 heading.
 */

const nav = vi.hoisted(() => ({
  searchParams: new URLSearchParams() as URLSearchParams | "suspend",
  params: {} as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => {
    if (nav.searchParams === "suspend") {
      // Never resolves, so the page's <Suspense> fallback is what renders.
      throw new Promise(() => {});
    }
    return nav.searchParams;
  },
  useParams: () => nav.params,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

vi.mock("@/hooks/use-password-policy-hints", () => ({
  usePasswordPolicyHints: () => ({
    minPasswordLength: 12,
    maxPasswordLength: 128,
    hints: ["At least 12 characters"],
    loading: false,
  }),
}));

// The shared form has its own suite; here it only has to hand the page a
// submission so the "sent" state can render.
vi.mock("@/components/maintenance/maintenance-report-form", () => ({
  MaintenanceReportForm: ({
    onSubmit,
  }: {
    onSubmit: (submission: { summary: string; answers: [] }) => Promise<void>;
  }) => (
    <button type="button" onClick={() => void onSubmit({ summary: "Leak", answers: [] })}>
      Send this report
    </button>
  ),
}));

import ResetPasswordPage from "../reset-password/page";
import VerifyEmailPage from "../verify-email/page";
import ConfirmEmailChangePage from "../confirm-email-change/page";
import ChangePasswordPage from "../change-password/page";
import { LodgeMaintenanceReportClient } from "../lodge-maintenance/[token]/lodge-maintenance-report-client";

function expectOneLevelOneHeading(name: string | RegExp) {
  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveAccessibleName(name);
}

beforeEach(() => {
  nav.searchParams = new URLSearchParams();
  nav.params = {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/reset-password", () => {
  it("loading", () => {
    nav.searchParams = "suspend";
    render(<ResetPasswordPage />);
    expectOneLevelOneHeading("Loading…");
  });

  it("missing token", () => {
    render(<ResetPasswordPage />);
    expectOneLevelOneHeading("Invalid link");
  });

  it("form", () => {
    nav.searchParams = new URLSearchParams("token=abc");
    render(<ResetPasswordPage />);
    expectOneLevelOneHeading("Reset your password");
  });

  it("success", async () => {
    nav.searchParams = new URLSearchParams("token=abc");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    render(<ResetPasswordPage />);
    const password = "a-long-enough-password";
    fireEvent.change(screen.getByLabelText(/^new password/i), {
      target: { value: password },
    });
    fireEvent.change(screen.getByLabelText(/^confirm new password/i), {
      target: { value: password },
    });
    fireEvent.submit(screen.getByRole("button", { name: /update password/i }));
    await waitFor(() => expectOneLevelOneHeading("Password updated"));
  });
});

describe.each([
  ["/verify-email", VerifyEmailPage, "Verifying Email..."],
  ["/confirm-email-change", ConfirmEmailChangePage, "Confirming Email Change..."],
] as const)("%s", (_route, Page, pending) => {
  it("loading", () => {
    nav.searchParams = "suspend";
    render(<Page />);
    expectOneLevelOneHeading("Loading...");
  });

  it("missing token", () => {
    render(<Page />);
    expectOneLevelOneHeading("Invalid Link");
  });

  it("token present", () => {
    // The page redirects to the API on mount; jsdom cannot navigate, so the
    // assignment is swallowed and the pending card stays on screen.
    vi.spyOn(console, "error").mockImplementation(() => {});
    nav.searchParams = new URLSearchParams("token=abc");
    render(<Page />);
    expectOneLevelOneHeading(pending);
  });
});

describe("/change-password", () => {
  it("form", () => {
    render(<ChangePasswordPage />);
    expectOneLevelOneHeading("Change Your Password");
  });
});

describe("/lodge-maintenance/[token]", () => {
  it("loading", () => {
    nav.params = { token: "abc" };
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<LodgeMaintenanceReportClient />);
    expectOneLevelOneHeading("Report a maintenance issue");
  });

  it("code not working", async () => {
    render(<LodgeMaintenanceReportClient />);
    await waitFor(() => expectOneLevelOneHeading("This code is not working"));
  });

  it("form, then sent", async () => {
    nav.params = { token: "abc" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              lodgeName: "Test Lodge",
              questions: [],
              photosEnabled: false,
              summaryMaxLength: 200,
              contactPrompt: null,
            }),
            { status: 200 }
          )
      )
    );
    render(<LodgeMaintenanceReportClient />);
    await waitFor(() => expectOneLevelOneHeading("Report a maintenance issue"));

    fireEvent.click(screen.getByRole("button", { name: "Send this report" }));
    await waitFor(() => expectOneLevelOneHeading("Thank you — that has been sent"));
  });
});
