// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  DISPLAY_GLOSSARY,
  DISPLAY_GLOSSARY_LEAD,
  DISPLAY_TERM_LAYOUT,
  DISPLAY_TERM_TEMPLATE,
} from "@/lib/lodge-display/display-terminology";
import { listDisplayConditions } from "@/lib/lodge-display/conditions";
import { BUILT_IN_DISPLAY_TEMPLATE_KEYS } from "@/lib/lodge-display/built-in-seeds";

// #2247 (was A4). The admin used three words — Layout, Template, "board" — for
// two database rows and defined none of them. The definitions now live once in
// `display-terminology.ts` and are surfaced on the hub cards, on the Reference
// page, and in `docs/guides/display.md`.
//
// These are LIGHT pins: they check that each surface carries the SHARED
// definition, not that any surface's full copy is frozen. Reword a definition in
// one place and this fails; reword the prose around it and it does not.

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn().mockResolvedValue({ lobbyDisplay: true }),
}));

// The hub counts boards + working screens to decide whether to LEAD with the
// guided-setup card (#2249). These tests are about the definitions on the cards,
// so the counts are stubbed to a fully set-up club — the state in which the hub
// shows its ordinary card grid.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    displayTemplate: { count: vi.fn().mockResolvedValue(7) },
    lodgeDisplayDevice: { count: vi.fn().mockResolvedValue(1) },
  },
}));

// The Layouts/Templates pages read the session permission matrix for view-only
// gating; the definitions they carry are in the header either way.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/admin/lodges")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ lodges: [] }),
      });
    }
    if (url.startsWith("/api/admin/display/layouts")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ layouts: [] }),
      });
    }
    if (url.startsWith("/api/admin/display/templates")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ templates: [] }),
      });
    }
    return Promise.resolve({
      status: 200,
      ok: true,
      json: () =>
        Promise.resolve({
          lodgeId: "lodge-default",
          lodgeName: "Silverpeak Lodge",
          conditions: listDisplayConditions().map((c) => ({
            name: c.name,
            value: false,
          })),
        }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Layout / Template / board are defined consistently (#2247)", () => {
  it("names all three words, so none of them is left undefined", () => {
    expect(DISPLAY_GLOSSARY.map((entry) => entry.term)).toEqual([
      "Layout",
      "Template",
      "Board",
    ]);
  });

  it("the Lobby Display hub cards carry the definitions", async () => {
    const { default: DisplayHubPage } = await import("../page");
    const { container } = render(await DisplayHubPage());
    const text = container.textContent ?? "";

    for (const entry of DISPLAY_GLOSSARY) {
      expect(text, `hub card missing the ${entry.term} definition`).toContain(
        entry.oneLiner
      );
    }
  });

  it("the Reference page explains Layout vs Template", async () => {
    const { default: AdminDisplayReferencePage } = await import(
      "../reference/page"
    );
    const { container } = render(<AdminDisplayReferencePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByText("Layout vs Template")).toBeDefined();
    const text = container.textContent ?? "";
    for (const entry of DISPLAY_GLOSSARY) {
      expect(
        text,
        `Reference page missing the ${entry.term} definition`
      ).toContain(entry.oneLiner);
    }
  });

  it("the operator guide quotes the same definitions", () => {
    // Markdown hard-wraps, so compare on collapsed whitespace.
    const flat = guideSource().replace(/\s+/g, " ");
    for (const entry of DISPLAY_GLOSSARY) {
      expect(
        flat,
        `docs/guides/display.md missing the ${entry.term} definition`
      ).toContain(entry.oneLiner);
    }
  });

  // The pages that AUTHOR each thing are where the word is most likely to be
  // met, and each previously carried its own hand-written paraphrase (or, on
  // Layouts, no definition at all).
  it("the Templates page states the shared Template definition", async () => {
    const { default: AdminDisplayTemplatesPage } = await import(
      "../templates/page"
    );
    const { container } = render(<AdminDisplayTemplatesPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent ?? "").toContain(
      DISPLAY_TERM_TEMPLATE.oneLiner
    );
  });

  it("the Layouts page states the shared Layout definition", async () => {
    const { default: AdminDisplayLayoutsPage } = await import(
      "../layouts/page"
    );
    const { container } = render(<AdminDisplayLayoutsPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent ?? "").toContain(DISPLAY_TERM_LAYOUT.oneLiner);
  });

  // The hub header used to carry a FOURTH paraphrase of all three words, in
  // the very file that imports the constants. It now names them without
  // redefining them, and the lead-in itself is owned by the module.
  it("the hub header names the words without adding a fourth definition", async () => {
    const { default: DisplayHubPage } = await import("../page");
    const { container } = render(await DisplayHubPage());
    expect(container.textContent ?? "").toContain(DISPLAY_GLOSSARY_LEAD);
  });
});

describe("the reserved built-in keys are documented where they bite (#2247)", () => {
  it("names every reserved key in the operator guide", () => {
    // The create routes now refuse these keys, so an operator who hits that
    // 409 must be able to find the list. Derived from the seeds, so adding an
    // eighth built-in fails here rather than silently leaving the guide short.
    const guide = guideSource();
    for (const key of BUILT_IN_DISPLAY_TEMPLATE_KEYS) {
      expect(guide, `docs/guides/display.md does not name "${key}"`).toContain(
        key
      );
    }
  });

  // The guide used to say built-ins are "re-seeded on upgrade", which is the
  // opposite of the bug this issue fixes: upgrading re-runs neither the seed
  // nor the restore.
  it("no longer claims an upgrade re-seeds the built-ins", () => {
    expect(guideSource()).not.toMatch(/re-seeded on upgrade/i);
  });

  /*
    …and the same claim is gone from the ADMIN COPY, not just the guide. The
    sentence lived in five app strings across three files; fixing the guide and
    one page while a sibling page still told the operator that upgrading
    rewrites their edits is the drift this whole issue is about.

    Scope is the surfaces #2247 owns. `display-builder.tsx` and `builder/page.tsx`
    are deliberately EXCLUDED: #2248 rewrites both, so #2247 left their copy
    alone to keep the rebase surface small, and that carry-forward is recorded on
    the PR rather than hidden behind a green test. Delete the exclusion when
    #2248 lands.
  */
  const STALE_RESEED_CLAIMS = [
    /re-seeded on upgrade/i,
    /the app is upgraded/i,
    /re-seed(ed)?\/upgrade/i,
  ];

  it.each([
    "templates/page.tsx",
    "layouts/page.tsx",
    "page.tsx",
    "templates/restore-built-ins.tsx",
    "reference/page.tsx",
  ])("no admin copy in %s claims an upgrade re-seeds the built-ins", (rel) => {
    const source = readFileSync(
      path.join(process.cwd(), "src/app/(admin)/admin/display", rel),
      "utf8"
    );
    for (const claim of STALE_RESEED_CLAIMS) {
      expect(
        source,
        `${rel} still tells the operator an upgrade rewrites a built-in. ` +
          `Upgrading re-runs neither the seed nor the restore — name the real ` +
          `mechanism (the seed running again, or Restore built-in boards).`
      ).not.toMatch(claim);
    }
  });
});

function guideSource(): string {
  return readFileSync(
    path.join(process.cwd(), "docs/guides/display.md"),
    "utf8"
  );
}
