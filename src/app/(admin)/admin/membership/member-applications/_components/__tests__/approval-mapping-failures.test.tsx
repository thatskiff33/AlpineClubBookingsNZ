// @vitest-environment jsdom

/**
 * A refused mapping preview or member search says why (#4976, ALP-589).
 *
 * Both used to `await response.json()` before checking `ok`. Their catches
 * already fell back, so an HTML 502 showed the fallback rather than a parse
 * error; they now read a refusal through `apiErrorMessageFromResponse` like
 * every other admin write, and these cases hold that.
 */

import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

// The joining-fee preview runs its own fetch; it is not under test here.
vi.mock("@/components/admin/joining-fee-preview", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  useJoiningFeePreview: () => ({ loading: false, loaded: false, error: null, preview: null }),
  useJoiningFeePrefill: () => {},
}));

import ApprovalMappingPanel from "../approval-mapping-panel";

const application = {
  id: "application-1",
  applicantFirstName: "Jo",
  applicantLastName: "Applicant",
  applicantEmail: "jo@example.test",
  applicantDateOfBirth: "1990-01-01",
  familyMembers: [],
};

const candidate = {
  id: "member-1",
  firstName: "Jo",
  lastName: "Existing",
  email: "jo.existing@example.test",
};

type Answer = () => Response | Promise<Response>;

function installFetch({ search, preview }: { search?: Answer; preview?: Answer }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/admin/members?")) {
      return (search ?? (() => Response.json({ members: [candidate] })))();
    }
    if (url.endsWith("/approval-preview")) {
      return (
        preview ??
        (() =>
          Response.json({
            preview: {
              applicationId: application.id,
              persons: [],
              blockingErrors: [],
              hasMappings: true,
              previewToken: "token-1",
            },
          }))
      )();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The page shows `onError` in its alert; this stands in for it. */
function Harness() {
  const [error, setError] = useState("");
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <ApprovalMappingPanel
        application={application}
        submitting={false}
        canEdit
        onRequestReview={() => {}}
        onError={setError}
      />
    </>
  );
}

async function searchForAMember() {
  render(<Harness />);
  fireEvent.click(screen.getByLabelText("Map to existing"));
  fireEvent.change(
    screen.getByRole("textbox", { name: /Search for an existing member to map to/ }),
    { target: { value: "Jo" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

async function previewTheMapping() {
  await searchForAMember();
  fireEvent.click(await screen.findByRole("button", { name: "Use" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview mapping" }));
}

describe("approval mapping panel", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
  });

  describe("searching for a member to map to", () => {
    itShowsEveryRefusal({
      fallback: "Could not search members.",
      submit: async (answer) => {
        installFetch({ search: answer });
        await searchForAMember();
      },
    });

    it("lists the members found", async () => {
      installFetch({});
      await searchForAMember();

      expect(await screen.findByText("jo.existing@example.test")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("previewing the mapping", () => {
    itShowsEveryRefusal({
      fallback: "Could not build the mapping preview.",
      submit: async (answer) => {
        installFetch({ preview: answer });
        await previewTheMapping();
      },
    });

    it("shows a clean preview as ready", async () => {
      installFetch({});
      await previewTheMapping();

      expect(await screen.findByText("Preview ready — no blocking issues.")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
