import { describe, expect, it, vi } from "vitest";
import {
  containsUnsupportedColorFunction,
  normalizeUnsupportedColorFunctions,
} from "@/lib/screenshot-color-sanitizer";

describe("screenshot color sanitizer", () => {
  it("detects color functions that html2canvas cannot parse", () => {
    expect(containsUnsupportedColorFunction("lab(52% 12 18)")).toBe(true);
    expect(containsUnsupportedColorFunction("oklch(0.7 0.1 120)")).toBe(true);
    expect(containsUnsupportedColorFunction("color(srgb 0.1 0.2 0.3)")).toBe(true);
    expect(containsUnsupportedColorFunction("color-mix(in srgb, red, blue)")).toBe(true);
    expect(containsUnsupportedColorFunction("background-color")).toBe(false);
    expect(containsUnsupportedColorFunction("rgb(255, 255, 255)")).toBe(false);
  });

  it("replaces unsupported colors inside composite style values", () => {
    const convertColor = vi.fn((colorExpression: string) => {
      if (colorExpression.startsWith("lab(")) {
        return "rgb(10, 20, 30)";
      }

      if (colorExpression.startsWith("oklch(")) {
        return "rgb(40, 50, 60)";
      }

      return null;
    });

    expect(
      normalizeUnsupportedColorFunctions(
        "0 1px 2px lab(52% 12 18), 0 0 1px oklch(0.7 0.1 120)",
        convertColor
      )
    ).toBe("0 1px 2px rgb(10, 20, 30), 0 0 1px rgb(40, 50, 60)");
  });

  it("substitutes CSS variables before converting unsupported colors", () => {
    const convertColor = vi.fn((colorExpression: string) =>
      colorExpression === "oklch(0.7 0.1 120)" ? "rgb(40, 50, 60)" : null
    );
    const getCssVariableValue = (name: string) =>
      name === "--brand-color" ? "oklch(0.7 0.1 120)" : null;

    expect(
      normalizeUnsupportedColorFunctions(
        "var(--brand-color)",
        convertColor,
        getCssVariableValue
      )
    ).toBe("rgb(40, 50, 60)");
  });

  it("substitutes nested CSS variable fallbacks before converting unsupported colors", () => {
    const convertColor = vi.fn((colorExpression: string) =>
      colorExpression === "lab(52% 12 18)" ? "rgb(10, 20, 30)" : null
    );
    const getCssVariableValue = (name: string) =>
      name === "--brand-color" ? "lab(52% 12 18)" : null;

    expect(
      normalizeUnsupportedColorFunctions(
        "var(--missing-color, var(--brand-color, rgb(0, 0, 0)))",
        convertColor,
        getCssVariableValue
      )
    ).toBe("rgb(10, 20, 30)");
  });

  it("keeps an unsupported value when conversion fails", () => {
    expect(normalizeUnsupportedColorFunctions("lab(52% 12 18)", () => null)).toBe(
      "lab(52% 12 18)"
    );
  });
});
