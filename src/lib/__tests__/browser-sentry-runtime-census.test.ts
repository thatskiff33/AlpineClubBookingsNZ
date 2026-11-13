import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS, ROOT, relative, walk } from "./support/provider-mount-census";
import { stripComments } from "./support/strip-comments";

// Runtime env access is server-only. Scanning ALL source also catches a browser
// import of a shared helper without relying on a growing list of client roots.
const serverConfig = "src/lib/observability/browser-sentry-config.ts";
const variable = "NEXT_PUBLIC_SENTRY_DSN";

describe("browser Sentry never inherits an image builder's destination (#4982)", () => {
  it("reads the browser DSN only in its server-only runtime resolver", () => {
    const reads = walk(path.join(ROOT, "src"), name => CODE_EXTENSIONS.some(ext => name.endsWith(ext)) && !/\.(test|spec)\./.test(name))
      .filter(file => new RegExp(`\\b(?:process\\s*\\.\\s*)?env\\s*(?:\\.\\s*${variable}\\b|\\[\\s*["']${variable}["']\\s*\\])`).test(stripComments(readFileSync(file, "utf8"))))
      .map(relative).sort();
    expect(reads).toEqual([serverConfig]);
    expect(readFileSync(path.join(ROOT, serverConfig), "utf8")).toMatch(/import ["']server-only["']/);
  });

  it("has no DSN build argument in Docker, compose, or any workflow", () => {
    expect(readFileSync(path.join(ROOT, "Dockerfile"), "utf8")).not.toMatch(new RegExp(`^\\s*(?:ARG|ENV)\\s+${variable}\\b`, "m"));
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    // The sole remaining occurrence is runtime env, outside every build block.
    expect(compose.split("\n").filter(line => line.includes(variable))).toEqual([
      "  NEXT_PUBLIC_SENTRY_DSN: ${NEXT_PUBLIC_SENTRY_DSN:-}",
    ]);
    const workflows = walk(path.join(ROOT, ".github/workflows"), name => /\.ya?ml$/.test(name));
    expect(workflows.length).toBeGreaterThan(0);
    for (const file of workflows) {
      // No build argument or repository variable remains, including empty passers.
      expect(readFileSync(file, "utf8"), relative(file)).not.toContain(variable);
    }
  });
});
