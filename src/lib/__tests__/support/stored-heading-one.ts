import { expect } from "vitest";

/**
 * A stored lodge-instructions body whose author used Heading 1, and what every
 * surface that reads it must hand back (#5218, #5345; `INV-PUB-006`).
 *
 * One copy, so the screen test (`instruction-screen-headings.test.tsx`), the
 * three instruction routes and the lobby display state all mean the same thing
 * by "a stored Heading 1 comes back demoted".
 */

/** The stored Heading 1's text, for tests that look the demoted heading up by name. */
export const STORED_H1_TEXT = "Arriving at the lodge";

const STORED_WITH_H1 = `<h1>${STORED_H1_TEXT}</h1><p>Turn the power on.</p>`;

/** The stored row, as `prisma.lodgeInstruction.findMany` returns it. */
export function storedInstructionWithH1() {
  return {
    key: "OPEN" as const,
    contentHtml: STORED_WITH_H1,
    updatedAt: new Date("2026-06-10T00:00:00Z"),
    lodgeId: null,
  };
}

/**
 * The author's heading is still a heading, and no level-1 heading is left in
 * the HTML. The level it lands on is deliberately not pinned: it is 2 today,
 * and the nesting decided on #5345 moves it lower on some screens. The reader's
 * own test (`lodge-instructions.test.ts`) pins the exact level.
 */
export function expectStoredHeadingOneDemoted(html: string) {
  expect(html).not.toMatch(/<h1[\s>]/i);
  expect(html).toMatch(new RegExp(`<h([2-6])>${STORED_H1_TEXT}</h\\1>`));
}
