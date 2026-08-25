// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// #2269 (F3) — the admin-facing half. A club whose saved wording has fallen
// behind the built-in wording has to be able to SEE that, and see exactly how,
// before deciding between patching their words and Restore Default (which
// throws their words away).
//
// The load-bearing requirement is what must NOT happen: a club that reworded a
// message on purpose — which is the entire point of saving one — must not be
// told it has drifted. So the two tests that matter most here are the one that
// asserts a rewritten-but-complete override shows no warning at all, and the
// one that asserts the diff shows both sides.
//
// The fixture is the REAL registry definition, so this cannot pass against a
// hand-written fixture that has drifted from what the API serves.
// ---------------------------------------------------------------------------

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "view",
          membership: "view",
          finance: "view",
          lodge: "view",
          content: "view",
          support: "edit",
        },
      },
    },
    status: "authenticated",
  }),
}));

import { EmailMessageSettingsPanel } from "@/components/admin/email-settings/email-message-settings-panel";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";

const definition = getEmailTemplateDefinition("booking-confirmed");
if (!definition) throw new Error("missing booking-confirmed");

const REWORDED_BODY = [
  "Kia ora {{firstName}}, your bunk is locked in.",
  "",
  "{{promoSummary}}Total Paid: {{totalPaid}}",
  "",
  "{{CLUB_LODGE_TRAVEL_NOTE}}",
  "",
  "{{doorCodeNote}}",
].join("\n");

function stubEmailFetches(
  templatesBody: Record<string, unknown>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      const body = url.startsWith("/api/admin/email-settings")
        ? {
            settings: {
              clubName: "Example Mountain Club",
              bookingsName: "Bookings",
              emailFromName: "From",
              supportEmail: "support@example.org",
              contactEmail: "contact@example.org",
              publicUrl: "https://bookings.example.org",
            },
          }
        : url.startsWith("/api/admin/email-templates")
          ? templatesBody
          : null;
      if (!body) throw new Error(`Unstubbed fetch in test: ${url}`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function templatesResponse({
  bodyText,
  staleContent,
  missingRequiredTokenOverrides = [],
  strippedAnnotationOverrides = [],
}: {
  bodyText: string;
  staleContent: Record<string, unknown>;
  missingRequiredTokenOverrides?: Array<{
    templateName: string;
    tokens: string[];
  }>;
  strippedAnnotationOverrides?: Array<{
    templateName: string;
    annotations: string[];
    lines: string[];
  }>;
}) {
  return {
    templates: [
      {
        ...definition,
        override: {
          subject: null,
          bodyText,
          updatedAt: "2026-06-01T00:00:00.000Z",
          updatedByMemberId: "admin-1",
        },
        staleContent,
      },
    ],
    staleOverrideCount: 0,
    bracketAnnotationOverrides: [],
    strippedAnnotationOverrides,
    retiredTokenOverrides: [],
    missingRequiredTokenOverrides,
  };
}

/** True when the rendered diff contains a line matching `pattern`. */
function diffLine(pattern: RegExp): boolean {
  return Array.from(document.querySelectorAll("pre > div")).some((element) =>
    pattern.test(element.textContent ?? ""),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("email template saved-copy staleness surface (#2269)", () => {
  it("states a deliberate rewording as a plain difference, with no warning", async () => {
    stubEmailFetches(
      templatesResponse({
        bodyText: REWORDED_BODY,
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: [],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
        },
      }),
    );
    render(<EmailMessageSettingsPanel />);

    expect(
      await screen.findByText(
        /Your saved copy of this message differs from the built-in wording/,
      ),
    ).toBeInTheDocument();
    // Nothing that reads as a problem: no reason sentences and no banner.
    expect(screen.queryByText(/no longer shows something/)).not.toBeInTheDocument();
    expect(screen.queryByText(/renders as nothing at all/)).not.toBeInTheDocument();
    expect(screen.queryByText(/square-bracketed notes/)).not.toBeInTheDocument();
  });

  it("shows both sides of the wording when the admin asks for the differences", async () => {
    stubEmailFetches(
      templatesResponse({
        bodyText: REWORDED_BODY,
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: [],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
        },
      }),
    );
    render(<EmailMessageSettingsPanel />);

    const toggle = await screen.findByRole("button", {
      name: /Show differences/,
    });
    // Hidden until asked for: the diff is a decision aid, not page furniture.
    expect(screen.queryByText(/is your saved copy/)).not.toBeInTheDocument();
    fireEvent.click(toggle);

    expect(screen.getByText(/is your saved copy/)).toBeInTheDocument();
    // A line only the club has, and a line only the built-in wording has —
    // asserted inside the diff itself, because the editor textarea below the
    // diff also contains the club's text.
    expect(
      diffLine(/^- Kia ora \{\{firstName\}\}, your bunk is locked in\.$/),
    ).toBe(true);
    const firstDefaultLine = definition.defaultBody.split("\n")[0];
    expect(diffLine(new RegExp(`^\\+ ${firstDefaultLine}$`))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Hide differences/ }));
    expect(screen.queryByText(/is your saved copy/)).not.toBeInTheDocument();
  });

  it("names what a saved copy stopped saying, on the template and at the top of the page", async () => {
    stubEmailFetches(
      templatesResponse({
        bodyText:
          "Hi {{firstName}}.\n\nSubtotal: {{subtotal}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: ["missing_required_token"],
          missingRequiredTokens: ["promoSummary"],
          retiredTokens: [],
          bracketAnnotations: [],
        },
        missingRequiredTokenOverrides: [
          { templateName: "booking-confirmed", tokens: ["promoSummary"] },
        ],
      }),
    );
    render(<EmailMessageSettingsPanel />);

    expect(
      await screen.findByText(
        /Your saved copy no longer shows something this email is required to tell the recipient\. Add back \{\{promoSummary\}\}/,
      ),
    ).toBeInTheDocument();
    // The banner names the template by the LABEL an admin sees in the picker,
    // not by its registry key (#2269 review) — the label is already in the
    // same payload, and "booking-confirmed" is not a thing anyone can find on
    // the screen.
    expect(
      screen.getByText(/Booking Confirmed \(\{\{promoSummary\}\}\)/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/booking-confirmed \(/),
    ).not.toBeInTheDocument();
  });

  it("names the exact lines that go out as a bare label (#2269 CRITICAL)", async () => {
    // The money lines the shipped defaults padded "[only when ...]" onto. Once
    // the migration removes the bracket, this row still renders
    // "Discount (): -" on an ordinary booking and "Discount (PEAK): -" on a
    // promo that RAISED the price. Nothing said a word about it before.
    stubEmailFetches(
      templatesResponse({
        bodyText:
          "Hi {{firstName}}.\n\nDiscount ({{promoCode}}): -{{discount}}\n\n{{doorCodeNote}}",
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: ["dangling_line"],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
          danglingLines: ["Discount (): -"],
        },
      }),
    );
    render(<EmailMessageSettingsPanel />);

    expect(
      await screen.findByText(
        /Some lines of your saved copy go out with nothing after the label/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Discount \(\): -/)).toBeInTheDocument();
  });

  it("says which of OUR notes the upgrade removed, and quotes the line it left behind", async () => {
    // The regression this exists to prevent. Before the migration this row
    // raised "bracket_annotation" and a banner; the migration removed the
    // bracket and left a sentence of pure prose that no token-based check can
    // see. Rendered on an unpaid booking it reads "Payment has been processed
    // successfully." directly above "Please pay $240.00".
    stubEmailFetches(
      templatesResponse({
        bodyText:
          "Hi {{firstName}}.\n\nPayment has been processed successfully.\n\n{{paymentDueNote}}\n\n{{doorCodeNote}}",
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: ["stripped_annotation"],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
          danglingLines: [],
          strippedAnnotations: ["[only when the booking is already paid]"],
          unconditionalLines: ["Payment has been processed successfully."],
        },
        strippedAnnotationOverrides: [
          {
            templateName: "booking-confirmed",
            annotations: ["[only when the booking is already paid]"],
            lines: ["Payment has been processed successfully."],
          },
        ],
      }),
    );
    render(<EmailMessageSettingsPanel />);

    // On the template the admin has open …
    const sentence = await screen.findByText(
      /An upgrade removed .* from your saved copy/,
    );
    expect(sentence).toHaveTextContent(
      "[only when the booking is already paid]",
    );
    expect(sentence).toHaveTextContent("they now go out every time");
    expect(sentence).toHaveTextContent(
      "Payment has been processed successfully.",
    );
    // … and at the top of the page, where the bracket banner used to name it.
    expect(
      screen.getByText(/An upgrade removed our own square-bracketed notes/),
    ).toBeInTheDocument();
  });

  it("says nothing about the upgrade for a club it never touched", async () => {
    stubEmailFetches(
      templatesResponse({
        bodyText: REWORDED_BODY,
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: [],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
          danglingLines: [],
          strippedAnnotations: [],
          unconditionalLines: [],
        },
      }),
    );
    render(<EmailMessageSettingsPanel />);

    await screen.findByText(
      /Your saved copy of this message differs from the built-in wording/,
    );
    expect(
      screen.queryByText(/An upgrade removed/),
    ).not.toBeInTheDocument();
  });

  it("says the comparison describes the SAVED copy once you start editing", async () => {
    // The diff and the notes above it are computed from the stored row. An
    // admin who edits to fix a flagged problem and then opens the comparison
    // would otherwise read their pre-edit text under a legend saying "yours".
    stubEmailFetches(
      templatesResponse({
        bodyText: "Hi {{firstName}}.\n\n{{promoSummary}}{{doorCodeNote}}",
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: [],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
        },
      }),
    );
    render(<EmailMessageSettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /Show differences/ }));
    expect(screen.queryByText(/You have unsaved edits/)).not.toBeInTheDocument();

    // Fork #38: the body is a contentEditable rich editor — edits arrive as
    // input events over innerHTML, not change events over a value.
    const body = screen.getByLabelText("Body");
    body.innerHTML = "<p>Something else entirely.</p>";
    fireEvent.input(body);
    expect(screen.getByText(/You have unsaved edits/)).toBeInTheDocument();
  });

  it("makes the comparison reachable and announceable", async () => {
    // A scrollable region has to be focusable (WCAG 2.1.1) and the toggle has
    // to say what it controls.
    stubEmailFetches(
      templatesResponse({
        bodyText: "Hi {{firstName}}.\n\n{{promoSummary}}{{doorCodeNote}}",
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: [],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
        },
      }),
    );
    render(<EmailMessageSettingsPanel />);

    const toggle = await screen.findByRole("button", {
      name: /Show differences/,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls");

    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: /Hide differences/ }),
    ).toHaveAttribute("aria-expanded", "true");
    const region = screen.getByRole("region", {
      name: /Differences between your saved copy and the built-in wording/,
    });
    expect(region).toBeInTheDocument();
    const scrollable = screen.getByRole("group", { name: "Body differences" });
    expect(scrollable).toHaveAttribute("tabindex", "0");
  });

  it("asks before Restore Default throws the club's wording away", async () => {
    // #2269 review: one click, no undo, and this release points at Restore
    // Default from three separate places. The only copy afterwards is an audit
    // row, which needs database access to read back.
    stubEmailFetches(
      templatesResponse({
        bodyText: "Hi {{firstName}}.\n\n{{promoSummary}}{{doorCodeNote}}",
        staleContent: {
          differsFromDefault: true,
          subjectDiffersFromDefault: false,
          bodyDiffersFromDefault: true,
          reasons: [],
          missingRequiredTokens: [],
          retiredTokens: [],
          bracketAnnotations: [],
        },
      }),
    );
    render(<EmailMessageSettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /Restore Default/ }));

    // Nothing has been destroyed yet.
    const fetchMock = globalThis.fetch as unknown as {
      mock: { calls: Array<[string]> };
    };
    const resetCalls = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/api/admin/email-templates/reset"),
      );
    expect(resetCalls()).toHaveLength(0);
    // The dialog states BOTH halves: the audit log holds the wording in full
    // (#2269 second review made that true rather than approximately true), and
    // there is still no way back from this screen.
    const dialogText = await screen.findByText(
      /it cannot be undone from here/,
    );
    expect(dialogText).toHaveTextContent(
      "written to the audit log in full first",
    );
    // …and it says exactly what "in full" does not cover, rather than leaving
    // the exception to be discovered on the day someone needs the copy.
    expect(dialogText).toHaveTextContent(
      "apart from any line that reads like it carries a password, token or card number",
    );

    // Backing out leaves the saved wording alone.
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(resetCalls()).toHaveLength(0);

    // Confirming goes through.
    fireEvent.click(screen.getByRole("button", { name: /Restore Default/ }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Replace with the built-in wording/,
      }),
    );
    await waitFor(() => expect(resetCalls()).toHaveLength(1));
  });

  it("says nothing at all when there is no saved override", async () => {
    stubEmailFetches({
      templates: [{ ...definition, override: null, staleContent: null }],
      staleOverrideCount: 0,
      bracketAnnotationOverrides: [],
      retiredTokenOverrides: [],
      missingRequiredTokenOverrides: [],
    });
    render(<EmailMessageSettingsPanel />);

    await screen.findByLabelText("Body");
    expect(
      screen.queryByText(/differs from the built-in wording/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Show differences/ }),
    ).not.toBeInTheDocument();
  });
});
