import { describe, expect, it } from "vitest";
import { z } from "zod";
import { nameField } from "@/lib/zod-helpers";

describe("nameField", () => {
  const schema = z.object({ firstName: nameField(), lastName: nameField() });

  it("strips CR/LF from names so they can't break email subject headers", () => {
    const result = schema.parse({
      firstName: "Charlie\r\nBcc: attacker@example.com",
      lastName: "Smith\nX-Header: x",
    });

    expect(result.firstName).not.toMatch(/[\r\n]/);
    expect(result.lastName).not.toMatch(/[\r\n]/);
    expect(result.firstName).toBe("Charlie Bcc: attacker@example.com");
    expect(result.lastName).toBe("Smith X-Header: x");
  });

  it("trims surrounding whitespace after CR/LF replacement", () => {
    const result = schema.parse({ firstName: "  Alice  ", lastName: "\r\nBob\r\n" });
    expect(result.firstName).toBe("Alice");
    expect(result.lastName).toBe("Bob");
  });

  it("rejects strings that are empty after sanitization", () => {
    expect(() => schema.parse({ firstName: "\r\n", lastName: "ok" })).toThrow();
    expect(() => schema.parse({ firstName: "   ", lastName: "ok" })).toThrow();
  });

  it("rejects empty strings up front", () => {
    expect(() => schema.parse({ firstName: "", lastName: "ok" })).toThrow();
  });

  it("rejects strings exceeding 100 characters", () => {
    expect(() =>
      schema.parse({ firstName: "a".repeat(101), lastName: "ok" })
    ).toThrow();
  });

  it("preserves a normal name unchanged", () => {
    const result = schema.parse({ firstName: "Jordan", lastName: "Hartleysmith" });
    expect(result.firstName).toBe("Jordan");
    expect(result.lastName).toBe("Hartleysmith");
  });

  it("collapses multiple consecutive CR/LFs into a single space", () => {
    const result = schema.parse({ firstName: "A\r\n\r\n\nB", lastName: "C" });
    expect(result.firstName).toBe("A B");
  });
});
