import { describe, expect, it } from "vitest";

import { measureFunctions } from "../lib/function-length";

/**
 * #4927 — what the function-length ratchet counts as one function, and how
 * long it says it is. The ratchet's answers are only as good as these spans.
 */

function spans(file: string, lines: string[]) {
  return measureFunctions(file, lines.join("\n") + "\n").map(
    ({ name, startLine, endLine, lines: length }) => ({ name, startLine, endLine, lines: length }),
  );
}

describe("measureFunctions", () => {
  it("counts a nested arrow as part of its enclosing function, not as a unit of its own", () => {
    // The whole point of the gate: a long function that keeps its phases as
    // inner closures is still one long function.
    expect(
      spans("src/a.ts", [
        "export function outer() {",
        "  const inner = () => {",
        "    return 1;",
        "  };",
        "  return inner();",
        "}",
      ]),
    ).toEqual([{ name: "outer", startLine: 1, endLine: 6, lines: 6 }]);
  });

  it("measures a multi-line signature from its first token, and skips the leading doc comment", () => {
    expect(
      spans("src/a.ts", [
        "/**",
        " * Documentation is not code.",
        " */",
        "export async function cancel(",
        "  id: string,",
        "  reason: string,",
        "): Promise<void> {",
        "  await Promise.resolve([id, reason]);",
        "}",
      ]),
    ).toEqual([{ name: "cancel", startLine: 4, endLine: 9, lines: 6 }]);
  });

  it("counts an overloaded function once, by its implementation", () => {
    expect(
      spans("src/a.ts", [
        "export function pick(value: string): string;",
        "export function pick(value: number): number;",
        "export function pick(value: string | number) {",
        "  return value;",
        "}",
      ]),
    ).toEqual([{ name: "pick", startLine: 3, endLine: 5, lines: 3 }]);
  });

  it("names top-level const functions through the wrappers that change no shape", () => {
    expect(
      spans("src/a.ts", [
        "export const plain = () => 1;",
        "const wrapped = ((x: number) => {",
        "  return x;",
        "}) satisfies (x: number) => number;",
        "const legacy = function () {",
        "  return 2;",
        "};",
        "const notAFunction = 3;",
      ]).map((span) => [span.name, span.lines]),
    ).toEqual([
      ["plain", 1],
      ["wrapped", 3],
      ["legacy", 3],
    ]);
  });

  it("names class members by their class, including accessors, constructors and arrow fields", () => {
    expect(
      spans("src/a.ts", [
        "export class Door {",
        "  constructor() {}",
        "  get open() { return true; }",
        "  set open(v: boolean) { void v; }",
        "  handler = () => {",
        "    return 1;",
        "  };",
        "  abstractish(): void {}",
        "}",
      ]).map((span) => span.name),
    ).toEqual([
      "Door.constructor",
      "Door.get open",
      "Door.set open",
      "Door.handler",
      "Door.abstractish",
    ]);
  });

  it("names an anonymous default export `default`, and disambiguates a repeated name in source order", () => {
    expect(
      spans("src/a.ts", [
        "export default function () {",
        "  return 1;",
        "}",
        "namespace N {}",
        "const go = () => 1;",
        "class A { go() {} }",
        "class B { go() {} }",
      ]).map((span) => span.name),
    ).toEqual(["default", "go", "A.go", "B.go"]);
  });

  it("parses JSX in a .tsx component", () => {
    expect(
      spans("src/page.tsx", [
        "export default function Page() {",
        "  return (",
        "    <main>",
        "      <p>hello</p>",
        "    </main>",
        "  );",
        "}",
      ]),
    ).toEqual([{ name: "Page", startLine: 1, endLine: 7, lines: 7 }]);
  });
});
