import "@testing-library/jest-dom/vitest";
import { screen } from "@testing-library/react";
import { expect } from "vitest";

/**
 * The page outline a screen reader announces, and the two facts about it the
 * heading tests assert (`INV-PUB-006`; docs/ARCHITECTURE.md, "Card titles and
 * heading semantics"). One copy, so every screen's heading test means the same
 * thing by "one h1" and "no skipped level" (#5216).
 */

type OutlineEntry = { level: number; name: string };

function levelOf(heading: HTMLElement): number {
  const native = /^H([1-6])$/.exec(heading.tagName);
  if (native) return Number(native[1]);
  // `role="heading"` with no `aria-level` is level 2 in the ARIA spec.
  return Number(heading.getAttribute("aria-level") ?? 2);
}

/** Every heading on the screen, in document order: native tags and ARIA roles. */
export function headingOutline(): OutlineEntry[] {
  return screen.queryAllByRole("heading").map((heading) => ({
    level: levelOf(heading),
    name: (heading.textContent ?? "").replace(/\s+/g, " ").trim(),
  }));
}

/** The screen has exactly one level-1 heading, and it carries this name. */
export function expectOneLevelOneHeading(name: string | RegExp) {
  const headings = screen.getAllByRole("heading", { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveAccessibleName(name);
}

/**
 * The outline starts at level 1 and never goes more than one level deeper than
 * the heading before it — a skipped level reads to a screen-reader user as a
 * missing section.
 */
export function expectNoSkippedHeadingLevels() {
  const outline = headingOutline();
  expect(outline[0]?.level, "the outline must start with a level-1 heading").toBe(1);
  outline.forEach((entry, index) => {
    if (index === 0) return;
    const previous = outline[index - 1];
    expect(
      entry.level,
      `"${entry.name}" (level ${entry.level}) follows "${previous.name}" (level ${previous.level})`,
    ).toBeLessThanOrEqual(previous.level + 1);
  });
}

/** Both outline facts at once: one named h1, and no skipped level under it. */
export function expectSoundOutline(h1: string | RegExp) {
  expectOneLevelOneHeading(h1);
  expectNoSkippedHeadingLevels();
}
