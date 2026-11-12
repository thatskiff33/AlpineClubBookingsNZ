// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #4987: the compose page shows who a send will reach before Send is pressed,
// per kind of message, and words the result without calling a member who
// never chose "opted out".
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "u1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "view",
          membership: "edit",
          finance: "view",
          lodge: "view",
          content: "view",
          support: "view",
        },
      },
    },
    status: "authenticated",
  }),
}));

import CommunicationsPage from "@/app/(admin)/admin/messages/communications/page";

const PREVIEW = {
  clubNotice: { totalRecipients: 400, eligibleRecipients: 398, optedOut: 2, neverOptedIn: 0 },
  newsletter: { totalRecipients: 400, eligibleRecipients: 3, optedOut: 0, neverOptedIn: 397 },
} as const;

let sendBody: Record<string, unknown> | null = null;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  sendBody = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/admin/communications/preview") {
        const category = url.searchParams.get("category") as keyof typeof PREVIEW;
        return json(PREVIEW[category]);
      }
      if (url.pathname === "/api/admin/communications/send") {
        if (init?.method === "POST") {
          sendBody = JSON.parse(String(init.body));
          return json({ success: true, ...PREVIEW.newsletter, queued: 3 });
        }
        return json({ limit: 1, windowSeconds: 3600 });
      }
      if (url.pathname === "/api/admin/communications/history") {
        return json({ history: [] });
      }
      throw new Error(`Unstubbed fetch in test: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function preview() {
  return screen.getByTestId("communications-recipient-preview");
}

describe("Communications compose page (#4987)", () => {
  it("asks for the kind of message before it counts recipients or allows a send", async () => {
    render(<CommunicationsPage />);
    fireEvent.change(await screen.findByLabelText(/Subject/i), {
      target: { value: "Lodge closed" },
    });
    fireEvent.change(screen.getByLabelText(/Message Body/i), {
      target: { value: "Closed 14-16 August" },
    });

    expect(preview()).toHaveTextContent(/Choose the kind of message/i);
    expect(screen.getByRole("button", { name: /Send to Members/i })).toBeDisabled();
  });

  it("shows the recipient count for the chosen kind and updates it when the kind changes", async () => {
    render(<CommunicationsPage />);

    fireEvent.click(await screen.findByLabelText(/Club notice/i));
    await waitFor(() =>
      expect(preview()).toHaveTextContent(
        "Will be sent to 398 of 400 members (2 opted out).",
      ),
    );

    fireEvent.click(screen.getByLabelText(/Club newsletter/i));
    await waitFor(() =>
      expect(preview()).toHaveTextContent(
        "Will be sent to 3 of 400 members (397 never opted in).",
      ),
    );
  });

  it("sends the chosen kind and reports never-opted-in members apart from opted-out ones", async () => {
    render(<CommunicationsPage />);
    fireEvent.change(await screen.findByLabelText(/Subject/i), {
      target: { value: "Winter newsletter" },
    });
    fireEvent.change(screen.getByLabelText(/Message Body/i), {
      target: { value: "News" },
    });
    fireEvent.click(screen.getByLabelText(/Club newsletter/i));
    fireEvent.click(screen.getByRole("button", { name: /Send to Members/i }));

    expect(
      await screen.findByText("Sent to 3 members (397 never opted in)."),
    ).toBeInTheDocument();
    expect(sendBody).toMatchObject({ category: "newsletter", recipientFilter: "all" });
  });
});
