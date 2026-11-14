import { describe, expect, it } from "vitest";

import { importCycles, moduleImports } from "./support/static-import-graph";

describe("static import graph scanner", () => {
  it("distinguishes runtime re-exports from erased type re-exports", () => {
    const imports = moduleImports("fixture.ts", `
      export type * from "./types";
      export { type Model } from "./model";
      export { value, type OtherModel } from "./mixed";
      export * as namespace from "./namespace";
      export {} from "./side-effect";
    `);

    expect(imports.map(({ specifier, kind }) => [specifier, kind])).toEqual([
      ["./types", "type"],
      ["./model", "type"],
      ["./mixed", "static"],
      ["./namespace", "static"],
      ["./side-effect", "static"],
    ]);
  });

  it("reports separate cycles without including modules that only lead into or out of them", () => {
    const edges = new Map([
      ["entry", ["a", "self", "x"]],
      ["a", ["b", "tail"]],
      ["b", ["c"]],
      ["c", ["a"]],
      ["tail", []],
      ["self", ["self"]],
      ["x", ["y"]],
      ["y", ["x", "tail"]],
    ]);

    expect(importCycles(edges)).toEqual([["a", "b", "c"], ["self"], ["x", "y"]]);
  });

  it("does not merge a completed cycle into another cycle that imports it", () => {
    const edges = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["a", "d"]],
      ["d", ["c"]],
    ]);

    expect(importCycles(edges)).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("handles a deep dependency chain without overflowing the JavaScript call stack", () => {
    const edges = new Map<string, string[]>();
    const depth = 20_000;
    for (let index = 0; index < depth; index += 1) {
      edges.set(`module-${index}`, index + 1 < depth ? [`module-${index + 1}`] : []);
    }
    expect(importCycles(edges)).toEqual([]);
    edges.set(`module-${depth - 1}`, [`module-${depth - 2}`]);
    expect(importCycles(edges)).toEqual([[`module-${depth - 2}`, `module-${depth - 1}`]]);
  });
});
