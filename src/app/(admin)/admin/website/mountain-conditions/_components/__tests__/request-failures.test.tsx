// @vitest-environment jsdom

/**
 * Every mountain-conditions read and write says why it failed (ALP-649, #4976
 * follow-up).
 *
 * The load, save, upstream refresh, visibility save, selector export, source
 * configuration save and preview each parsed the reply as JSON before checking
 * `ok`, so an HTML error page from the proxy in front of the app reached the
 * officer as a JSON parse error. Each now throws the refusal through
 * `apiRefusalFromResponse`: the route's own sentence when it sent one, the
 * panel's fallback otherwise, and the fallback again when the request never
 * arrives. Import writes through the same `persistConfig` as the configuration
 * save but has its own catch, which tells a file that is not JSON apart from a
 * refused write; its cases below pin that an error page from the write is
 * never blamed on the officer's file.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { htmlErrorPage, itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import { WHAKAPAPA_SELECTOR_KEYS } from "@/lib/whakapapa-report";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));

import { MountainConditionsPanel } from "../mountain-conditions-panel";

type Answer = () => Response | Promise<Response>;
type Request = { method: string; body: Record<string, unknown>; gets: number };

/** Answers the request `target` picks with `answer`; everything else succeeds. */
function stubFetch(target: (request: Request) => boolean, answer: Answer) {
  let gets = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") gets += 1;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (target({ method, body, gets })) return answer();
      return Response.json({ record: null, message: "Done", preview: null });
    }),
  );
}

async function press(name: string, target: (request: Request) => boolean, answer: Answer, opener?: string) {
  stubFetch(target, answer);
  render(<MountainConditionsPanel />);
  if (opener) fireEvent.click(await screen.findByRole("button", { name: opener }));
  fireEvent.click(await screen.findByRole("button", { name }));
}

const ACTIONS = [
  {
    action: "save",
    button: "Save",
    target: ({ method }: Request) => method === "PUT",
    fallback: "Failed to save mountain conditions",
  },
  {
    action: "upstream refresh",
    button: "Update from upstream",
    target: ({ method, body }: Request) => method === "POST" && !body.preview,
    fallback: "Failed to refresh mountain conditions",
  },
  {
    action: "visibility save",
    button: "Save visibility",
    target: ({ method, body }: Request) => method === "PATCH" && "visibility" in body,
    fallback: "Failed to save section visibility",
  },
  {
    action: "configuration save",
    button: "Save configuration",
    target: ({ method, body }: Request) => method === "PATCH" && "config" in body,
    fallback: "Failed to save source configuration",
  },
  {
    action: "preview",
    button: "Preview",
    target: ({ method, body }: Request) => method === "POST" && body.preview === true,
    fallback: "Preview failed",
  },
] as const;

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Mountain conditions: a failed load says why", () => {
  itShowsEveryRefusal({
    submit: async (answer) => {
      stubFetch(({ method }) => method === "GET", answer);
      render(<MountainConditionsPanel />);
    },
    fallback: "Failed to load mountain conditions",
  });

  it("shows the panel with no load error when the load succeeds", async () => {
    stubFetch(() => false, () => Response.json({}));
    render(<MountainConditionsPanel />);
    expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByText("Failed to load mountain conditions")).not.toBeInTheDocument();
  });
});

describe.each(ACTIONS)("Mountain conditions: a refused $action says why", ({ button, target, fallback }) => {
  itShowsEveryRefusal({ submit: (answer) => press(button, target, answer), fallback });

  it("reports success and leaves the action alert empty", async () => {
    await press(button, target, () => Response.json({ record: null, message: "Done", preview: null }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(document.getElementById("mountain-conditions-action-error")).toBeEmptyDOMElement();
  });
});

describe("Mountain conditions: a refused selector export says why", () => {
  const isExport = ({ method, gets }: Request) => method === "GET" && gets > 1;
  const opener = "Advanced: element selectors";

  // jsdom has no object URLs. Install them for this block and put back what
  // was there, so later tests in the file never see the stand-ins.
  const urlStatics = URL as unknown as Record<"createObjectURL" | "revokeObjectURL", unknown>;
  let original: { createObjectURL: unknown; revokeObjectURL: unknown };

  beforeEach(() => {
    original = { createObjectURL: urlStatics.createObjectURL, revokeObjectURL: urlStatics.revokeObjectURL };
    urlStatics.createObjectURL = () => "blob:test";
    urlStatics.revokeObjectURL = () => {};
  });

  afterEach(() => {
    for (const key of ["createObjectURL", "revokeObjectURL"] as const) {
      if (original[key] === undefined) delete urlStatics[key];
      else urlStatics[key] = original[key];
    }
  });

  itShowsEveryRefusal({
    submit: (answer) => press("Export selectors", isExport, answer, opener),
    fallback: "Failed to export configuration",
  });

  it("exports the stored configuration when the read succeeds", async () => {
    await press("Export selectors", isExport, () => Response.json({ record: null }), opener);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Selector configuration exported from the database."),
    );
    expect(document.getElementById("mountain-conditions-action-error")).toBeEmptyDOMElement();
  });
});

describe("Mountain conditions: a refused selector import says why", () => {
  const isImportWrite = ({ method, body }: Request) => method === "PATCH" && "config" in body;
  const selectorFile = () =>
    new File([JSON.stringify({ selectorOverrides: { [WHAKAPAPA_SELECTOR_KEYS[0]]: ".lift-status" } })], "selectors.json", {
      type: "application/json",
    });

  async function importFile(answer: Answer, file: File = selectorFile()) {
    stubFetch(isImportWrite, answer);
    const { container } = render(<MountainConditionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Advanced: element selectors" }));
    await screen.findByRole("button", { name: "Import selectors" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("shows the write's fallback, not 'not valid JSON', when the save answers with an HTML error page", async () => {
    await importFile(() => htmlErrorPage(502));
    expect(await screen.findByText("Failed to save source configuration")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalledWith("Could not import selectors: the file is not valid JSON.");
  });

  it("shows the route's own sentence from a JSON refusal", async () => {
    await importFile(() => Response.json({ error: "That record no longer exists." }, { status: 404 }));
    expect(await screen.findByText("That record no longer exists.")).toBeInTheDocument();
  });

  it("shows the import fallback when the write never gets an answer", async () => {
    await importFile(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await screen.findByText("Failed to import selectors")).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("still blames the file, and writes nothing, when the file is not JSON", async () => {
    await importFile(() => Response.json({ record: null }), new File(["not json"], "selectors.json"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not import selectors: the file is not valid JSON."),
    );
    expect(document.getElementById("mountain-conditions-action-error")).toBeEmptyDOMElement();
  });
});
