import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    // Test fixtures may demonstrate the forbidden launcher variable.
    return /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\./.test(file)
      ? [file]
      : [];
  });
}

describe("app version source census (#4985, INV-SSOT)", () => {
  it("never depends on the package-manager launcher in runtime source or Sentry config", () => {
    const files = [
      ...sourceFiles("src"),
      ...readdirSync(".").filter((file) => /^sentry\..*\.config\.ts$/.test(file)),
    ];
    expect(files.length).toBeGreaterThan(0);
    const violations = files.filter((file) =>
      readFileSync(file, "utf8").includes(["npm", "package", "version"].join("_")),
    );
    expect(violations, "Read the build stamp through getAppVersion() instead.").toEqual([]);
  });
});
