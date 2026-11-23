import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { isPrismaKnownUniqueConstraintError } from "@/lib/prisma-known-errors";

// #5407 item 6: the class-based test the nineteen converted sites used to spell
// inline, `error instanceof Prisma.PrismaClientKnownRequestError && error.code
// === "P2002"`, and how it differs from the shape-based predicate.

const known = (code: string) => new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "test" });

describe("isPrismaKnownUniqueConstraintError", () => {
  it.each([
    ["Prisma's error with P2002", known("P2002"), true, true],
    ["Prisma's error with P2025", known("P2025"), false, false],
    ["Prisma's error with P2034", known("P2034"), false, false],
    ["a plain object with code P2002", { code: "P2002" }, false, true],
    ["an Error with code P2002", Object.assign(new Error("x"), { code: "P2002" }), false, true],
    ["null", null, false, false],
    ["undefined", undefined, false, false],
    ["the string P2002", "P2002", false, false],
  ])("answers for %s: %s (the shape-based predicate: %s)", (_label, value, byClass, byShape) => {
    expect(isPrismaKnownUniqueConstraintError(value)).toBe(byClass);
    expect(isPrismaUniqueConstraintError(value)).toBe(byShape);
  });

  it("is exactly the inline test it replaced, for every value above", () => {
    const inline = (error: unknown) =>
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
    for (const value of [known("P2002"), known("P2025"), { code: "P2002" }, null, "P2002"]) {
      expect(isPrismaKnownUniqueConstraintError(value)).toBe(inline(value));
    }
  });
});
