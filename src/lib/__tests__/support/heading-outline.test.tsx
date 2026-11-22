// @vitest-environment jsdom
/**
 * The shared heading-outline helpers (#5216) are what every screen's heading
 * test leans on, so each one is shown to fail on the outline it exists to
 * reject — a helper that never throws would pass every screen vacuously.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectNoSkippedHeadingLevels,
  expectOneLevelOneHeading,
  expectSoundOutline,
} from "./heading-outline";

afterEach(cleanup);

describe("heading-outline helpers", () => {
  it("accept a sound outline", () => {
    render(
      <>
        <h1>Page</h1>
        <h2>Card</h2>
        <div role="heading" aria-level={3}>
          Section
        </div>
        <h2>Another card</h2>
      </>,
    );
    expect(() => expectSoundOutline("Page")).not.toThrow();
  });

  it("reject a screen with no h1", () => {
    render(<h2>Card</h2>);
    expect(() => expectOneLevelOneHeading("Page")).toThrow();
  });

  it("reject a screen with two h1s", () => {
    render(
      <>
        <h1>Page</h1>
        <h1>Page</h1>
      </>,
    );
    expect(() => expectOneLevelOneHeading("Page")).toThrow();
  });

  it("reject an h1 with a different name", () => {
    render(<h1>Other</h1>);
    expect(() => expectOneLevelOneHeading("Page")).toThrow();
  });

  it("reject an h1 followed by an h3", () => {
    render(
      <>
        <h1>Page</h1>
        <h3>Skipped</h3>
      </>,
    );
    expect(() => expectNoSkippedHeadingLevels()).toThrow(/"Skipped" \(level 3\)/);
  });

  it("reject an outline that does not start at h1", () => {
    render(
      <>
        <h2>Card</h2>
        <h1>Page</h1>
      </>,
    );
    expect(() => expectNoSkippedHeadingLevels()).toThrow(/must start with a level-1 heading/);
  });
});
