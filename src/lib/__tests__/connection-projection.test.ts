/**
 * ALP-718 (`INV-MCP-006`): `projectForConnection` is the one allow-list every
 * route uses to answer an AI app connection. A field reaches the app only if
 * the action's shape names it, at every depth, so a field the website's answer
 * gains later is withheld until someone adds it on purpose.
 */
import { describe, expect, it } from "vitest";

import {
  completeConnectionShapeFor,
  connectionShapeFor,
  eachEntry,
  projectForConnection,
} from "@/lib/connection-projection";

describe("projectForConnection", () => {
  it("keeps only the named fields, at every depth and in every array item", () => {
    const shape = { id: true, lodge: { name: true }, guests: { firstName: true } } as const;
    expect(
      projectForConnection(
        {
          id: "b1",
          internalNotes: "officer only",
          lodge: { name: "Main", address: "1 Road" },
          guests: [
            { firstName: "Ana", dietaryRequirements: "Peanuts" },
            { firstName: "Tui", email: "tui@example.test" },
          ],
        },
        shape,
      ),
    ).toEqual({ id: "b1", lodge: { name: "Main" }, guests: [{ firstName: "Ana" }, { firstName: "Tui" }] });
  });

  it("never passes an object whole under a plain field", () => {
    // A field marked plain that turns out to hold an object is withheld, not
    // sent with whatever the object carries.
    expect(
      projectForConnection({ name: "Ana", contact: { email: "ana@example.test" } }, { name: true, contact: true }),
    ).toEqual({ name: "Ana" });
    expect(projectForConnection({ tags: ["a", { secret: 1 }] }, { tags: true })).toEqual({});
  });

  it("keeps plain values, dates, nulls and arrays of plain values", () => {
    const when = new Date("2026-07-01T00:00:00.000Z");
    expect(
      projectForConnection(
        { a: "x", b: 0, c: false, d: null, e: when, f: ["2026-07-01", "2026-07-02"], g: null },
        { a: true, b: true, c: true, d: true, e: true, f: true, g: { inner: true } },
      ),
    ).toEqual({ a: "x", b: 0, c: false, d: null, e: when, f: ["2026-07-01", "2026-07-02"], g: null });
  });

  it("leaves out a named field the answer does not have, rather than inventing one", () => {
    expect(projectForConnection({ a: 1 }, { a: true, b: true })).toEqual({ a: 1 });
  });

  it("projects every entry of a map whose keys are data", () => {
    expect(
      projectForConnection(
        { seasons: { "2026-07-01": { name: "Winter", internalId: "s1" } } },
        { seasons: eachEntry({ name: true }) },
      ),
    ).toEqual({ seasons: { "2026-07-01": { name: "Winter" } } });
  });

  it("does not read inherited fields", () => {
    const value = Object.create({ inherited: "secret" }) as Record<string, unknown>;
    value.own = 1;
    expect(projectForConnection(value, { own: true, inherited: true })).toEqual({ own: 1 });
  });

  it("answers anything that is not an object with an empty object", () => {
    expect(projectForConnection(null, { a: true })).toEqual({});
    expect(projectForConnection([{ a: 1 }], { a: true })).toEqual({});
    expect(projectForConnection("text", { a: true })).toEqual({});
  });
});

describe("typed shapes", () => {
  it("are checked against the answer's type at compile time", () => {
    // @ts-expect-error a shape may only name fields the answer has
    connectionShapeFor<{ a: string }>({ a: true, typo: true });
    // @ts-expect-error a complete shape names every field of the answer
    completeConnectionShapeFor<{ a: string; b: number }>({ a: true });
    // @ts-expect-error a nested object needs a nested shape, not `true`
    connectionShapeFor<{ lodge: { name: string } }>({ lodge: true });
    expect(completeConnectionShapeFor<{ a: string; b: number[] }>({ a: true, b: true })).toEqual({ a: true, b: true });
  });
});
