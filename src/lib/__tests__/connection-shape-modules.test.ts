import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONNECTION_SHAPE_DIR,
  forbiddenShapeImports,
  isConnectionShapeModule,
} from "./support/connection-shape-modules";

// Several censuses (dietary data, waitlist positions, member search, group
// discount, organisation readers, exclusivity writes) skip the connection
// shape modules, because there `field: true` means "send it", not "select
// it". That is only safe while a shape module cannot reach the database.
const shapeFiles = readdirSync(path.join(process.cwd(), CONNECTION_SHAPE_DIR))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => `${CONNECTION_SHAPE_DIR}${name}`);

describe("connection shape modules (ALP-719)", () => {
  it("finds the shape modules", () => {
    expect(shapeFiles.length).toBeGreaterThan(0);
    expect(shapeFiles.every(isConnectionShapeModule)).toBe(true);
  });

  it("load nothing at runtime but the projection and each other", () => {
    const offenders = shapeFiles.flatMap((file) =>
      forbiddenShapeImports(file, readFileSync(path.join(process.cwd(), file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("flags a runtime import of the database client (mutation canary)", () => {
    const text = 'import { prisma } from "@/lib/prisma";\nimport type { Booking } from "@prisma/client";\n';
    expect(forbiddenShapeImports(`${CONNECTION_SHAPE_DIR}example.ts`, text)).toEqual([
      `${CONNECTION_SHAPE_DIR}example.ts:1 @/lib/prisma`,
    ]);
  });
});
