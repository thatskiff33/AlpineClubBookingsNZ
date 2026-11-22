// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/lib/__tests__/support/club-time-render";
import { expectOneLevelOneHeading } from "@/lib/__tests__/support/heading-outline";
import { STORED_H1_TEXT, storedInstructionWithH1 } from "@/lib/__tests__/support/stored-heading-one";

/**
 * #5218 (`INV-PUB-006`) — an administrator can put a Heading 1 in the lodge
 * instructions. Each screen that shows them already owns its level-1 heading,
 * so the stored H1 must not add a second one. The documents come from the real
 * reader (`getSanitizedLodgeInstructions`) over a stored row holding an H1, so
 * these fail if the reader stops demoting it.
 */

const mocks = vi.hoisted(() => ({ lodgeInstructionFindMany: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { lodgeInstruction: { findMany: mocks.lodgeInstructionFindMany } },
}));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

import { getSanitizedLodgeInstructions } from "@/lib/lodge-instructions";
import LodgeInstructionsPage from "../(authenticated)/lodge-instructions/page";
import { HutLeaderInstructionsClient } from "../(website-dynamic)/hut-leader-instructions/hut-leader-instructions-client";
import { KioskLodgeInstructions } from "@/components/kiosk-lodge-instructions";
import { LodgeRules } from "@/components/lodge-display/modules/lodge-rules";
import type { DisplayState } from "@/lib/lodge-display-state";

async function readerDocuments() {
  return getSanitizedLodgeInstructions();
}

function stubDocumentsFetch(documents: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ documents })),
  );
}

beforeEach(() => {
  mocks.lodgeInstructionFindMany.mockResolvedValue([storedInstructionWithH1()]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("an H1 in stored lodge instructions", () => {
  it("/lodge-instructions keeps one level-1 heading", async () => {
    stubDocumentsFetch(await readerDocuments());
    render(<LodgeInstructionsPage />);

    const authored = await screen.findByRole("heading", { name: STORED_H1_TEXT });
    expect(authored.tagName).toBe("H2");
    expectOneLevelOneHeading("Lodge Instructions");
  });

  it("/hut-leader-instructions keeps one level-1 heading once the PIN is accepted", async () => {
    stubDocumentsFetch(await readerDocuments());
    render(<HutLeaderInstructionsClient assignmentId="assignment-1" />);

    await userEvent.type(screen.getByLabelText("Kiosk PIN"), "123456");
    fireEvent.submit(screen.getByRole("button", { name: "View instructions" }).closest("form")!);

    const authored = await screen.findByRole("heading", { name: STORED_H1_TEXT });
    expect(authored.tagName).toBe("H2");
    expectOneLevelOneHeading("Lodge Instructions");
  });

  it("the kiosk's instructions section adds no level-1 heading to the kiosk page", async () => {
    stubDocumentsFetch(await readerDocuments());
    const { container } = render(<KioskLodgeInstructions date="2026-07-01" />);

    fireEvent.click(screen.getByRole("button", { name: /lodge instructions/i }));
    fireEvent.click(await screen.findByRole("button", { name: /opening/i }));

    const authored = await screen.findByRole("heading", { name: STORED_H1_TEXT });
    expect(authored.tagName).toBe("H2");
    // The kiosk page's date is its one h1; this section sits beneath it.
    expect(within(container).queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  it("the lobby display's rules card adds no level-1 heading", async () => {
    const documents = await readerDocuments();
    const state = {
      rules: documents.map((doc) => ({ title: doc.title, html: doc.contentHtml })),
    } as DisplayState;
    const { container } = render(<LodgeRules state={state} />);

    expect(within(container).getByRole("heading", { name: STORED_H1_TEXT }).tagName).toBe(
      "H2",
    );
    expect(within(container).queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });
});
