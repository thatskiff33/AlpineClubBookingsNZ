// @vitest-environment jsdom

/**
 * `CardTitle`'s opt-in heading API (#2796).
 *
 * `CardTitle` is used in roughly 167 files. The whole safety property of the
 * opt-in prop is that **nothing changes unless a call site asks for it**, so
 * the first test here pins the default output byte-for-byte rather than
 * asserting something softer like "still a div".
 */

import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

describe("CardTitle default rendering (unchanged by #2796)", () => {
  it("emits exactly the same markup it always has when no headingLevel is given", () => {
    const { container } = render(<CardTitle>Roster assignments</CardTitle>);

    // Byte-for-byte. If anyone adds a role, an aria-level, a class, a data
    // attribute or a wrapper element to the DEFAULT path, this fails — which
    // is the point: 167 call sites depend on it not moving.
    expect(container.innerHTML).toBe(
      '<div class="font-semibold leading-none tracking-tight">Roster assignments</div>'
    );
  });

  it("exposes no heading to assistive technology by default", () => {
    render(<CardTitle>Roster assignments</CardTitle>);
    expect(screen.queryByRole("heading")).toBeNull();
    const title = screen.getByText("Roster assignments");
    expect(title.hasAttribute("role")).toBe(false);
    expect(title.hasAttribute("aria-level")).toBe(false);
  });

  it("leaves the rest of the Card family's default markup untouched", () => {
    const { container } = render(
      <Card className="mt-2">
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>
    );

    expect(container.innerHTML).toBe(
      '<div class="rounded-xl border bg-card text-card-foreground shadow mt-2">' +
        '<div class="flex flex-col space-y-1.5 p-6">' +
        '<div class="font-semibold leading-none tracking-tight">Title</div>' +
        '<div class="text-sm text-muted-foreground">Description</div>' +
        "</div>" +
        '<div class="p-6 pt-0">Content</div>' +
        '<div class="flex items-center p-6 pt-0">Footer</div>' +
        "</div>"
    );
  });

  it("still merges className and forwards a ref on the default path", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <CardTitle ref={ref} className="mt-2" id="section-title">
        Chore staffing
      </CardTitle>
    );
    expect(ref.current?.tagName).toBe("DIV");
    expect(ref.current?.className).toBe(
      "font-semibold leading-none tracking-tight mt-2"
    );
    expect(ref.current?.getAttribute("id")).toBe("section-title");
    expect(ref.current?.hasAttribute("role")).toBe(false);
  });
});

describe('CardTitle headingLevel="none" (#4951)', () => {
  // "none" is a call site's recorded decision that this title is not part of
  // the page outline. It must render exactly what an omitted prop renders, or
  // classifying a title as "none" would itself be a visual or semantic change.
  it("renders byte-for-byte what an omitted headingLevel renders", () => {
    const omitted = render(<CardTitle className="mt-2">Roster assignments</CardTitle>);
    const none = render(
      <CardTitle headingLevel="none" className="mt-2">
        Roster assignments
      </CardTitle>
    );
    expect(none.container.innerHTML).toBe(omitted.container.innerHTML);
    expect(none.container.innerHTML).toBe(
      '<div class="font-semibold leading-none tracking-tight mt-2">Roster assignments</div>'
    );
  });

  it("exposes no heading to assistive technology", () => {
    render(<CardTitle headingLevel="none">Roster assignments</CardTitle>);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("CardTitle opt-in heading semantics", () => {
  it("adds role=heading at the exact level asked for, and only then", () => {
    const { container } = render(
      <CardTitle headingLevel={2}>Chore staffing</CardTitle>
    );

    // Same element, same classes, two extra attributes. No wrapper, no
    // native heading tag (which `.app-theme-scope :is(h1, h2, h3, h4)` in
    // globals.css would restyle onto --font-heading).
    expect(container.innerHTML).toBe(
      '<div class="font-semibold leading-none tracking-tight" role="heading" aria-level="2">Chore staffing</div>'
    );
    expect(
      screen.getByRole("heading", { name: "Chore staffing", level: 2 })
    ).toBeTruthy();
  });

  it("supports every heading level, with no implied default", () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const { unmount } = render(
        <CardTitle headingLevel={level}>Level {level}</CardTitle>
      );
      expect(screen.getByRole("heading", { level })).toBeTruthy();
      unmount();
    }
  });

  it("emits DOM identical to the hand-written role/aria-level form it replaces", () => {
    // The migration of src/components/admin/roster-editor.tsx depends on this:
    // e2e/admin-roster-edit.spec.ts walks `heading -> parent -> parent` to
    // reach the Card, so the heading must stay the direct child of CardHeader.
    const handWritten = render(
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base">
          Chore staffing
        </CardTitle>
      </CardHeader>
    );
    const handWrittenHtml = handWritten.container.innerHTML;
    handWritten.unmount();

    const viaProp = render(
      <CardHeader>
        <CardTitle headingLevel={2} className="text-base">
          Chore staffing
        </CardTitle>
      </CardHeader>
    );

    // Attribute source order differs between the two spellings; normalise it
    // so the comparison is about the DOM, not about how JSX was written.
    const normalise = (html: string) =>
      html.replace(/ (role|aria-level)="[^"]*"/g, "").trim();
    expect(normalise(viaProp.container.innerHTML)).toBe(
      normalise(handWrittenHtml)
    );

    const heading = screen.getByRole("heading", {
      name: "Chore staffing",
      level: 2,
    });
    // parent -> CardHeader, exactly as the Playwright locator chain assumes.
    expect(heading.parentElement?.className).toBe(
      "flex flex-col space-y-1.5 p-6"
    );
  });
});
