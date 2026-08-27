// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { forwardRef, useImperativeHandle, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only",
}));
vi.mock("@/components/admin/booking-policies/policy-scope-select", () => ({
  usePolicyScopeOptions: (lodgeId: string | null) => ({
    state: lodgeId
      ? { kind: "lodge", lodgeId, lodgeName: lodgeId === "lodge-a" ? "Lodge A" : "Lodge B" }
      : { kind: "club-wide" },
    lodges: [
      { id: "lodge-a", name: "Lodge A" },
      { id: "lodge-b", name: "Lodge B" },
    ],
    reload: vi.fn(),
  }),
  isPolicyScopeReady: () => true,
  PolicyScopeSelect: ({ onChange }: { onChange: (value: string | null) => void }) => (
    <div>
      <button onClick={() => onChange("lodge-a")}>Choose Lodge A</button>
      <button onClick={() => onChange("lodge-b")}>Choose Lodge B</button>
    </div>
  ),
}));
vi.mock("@/components/admin/page-content-panel", () => ({
  WysiwygEditor: forwardRef(function TestEditor(
    props: { value: string; onChange: (value: string) => void; placeholder: string },
    ref,
  ) {
    const [value, setValue] = useState(props.value);
    useImperativeHandle(ref, () => ({ getHtml: () => value }));
    return (
      <textarea
        aria-label={props.placeholder}
        value={props.value}
        onChange={(event) => {
          setValue(event.target.value);
          props.onChange(event.target.value);
        }}
      />
    );
  }),
}));

import { LodgeInstructionsPanel } from "@/components/admin/lodge-instructions-panel";

function documents(prefix: string) {
  return {
    documents: [
      { key: "OPEN", contentHtml: `${prefix} opening`, updatedAt: null, hasOverride: true },
      { key: "CLOSE", contentHtml: `${prefix} closing`, updatedAt: null, hasOverride: true },
      { key: "DAY_TO_DAY", contentHtml: `${prefix} daily`, updatedAt: null, hasOverride: true },
    ],
  };
}

describe("LodgeInstructionsPanel response ownership (#2887)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ignores a late Lodge A load and saves Lodge B content only as Lodge B", async () => {
    let releaseA!: () => void;
    const lodgeA = new Promise<Response>((resolve) => {
      releaseA = () => resolve(Response.json(documents("A")));
    });
    const writes: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ document: documents("B").documents[0] });
      }
      if (url.includes("lodgeId=lodge-a")) return lodgeA;
      if (url.includes("lodgeId=lodge-b")) return Response.json(documents("B"));
      return Response.json(documents("club"));
    });

    render(<LodgeInstructionsPanel />);
    await screen.findByDisplayValue("club opening");
    fireEvent.click(screen.getByRole("button", { name: "Choose Lodge A" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("lodgeId=lodge-a"),
      expect.any(Object),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Choose Lodge B" }));
    expect(await screen.findByDisplayValue("B opening")).toBeInTheDocument();

    await act(async () => releaseA());
    expect(screen.getByDisplayValue("B opening")).toBeInTheDocument();

    const openingCard =
      screen.getByText(/Opening the Lodge/).closest<HTMLElement>("div.rounded-xl") ??
      document.body;
    fireEvent.click(within(openingCard).getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ key: "OPEN", lodgeId: "lodge-b", contentHtml: "B opening" });
  });
});
