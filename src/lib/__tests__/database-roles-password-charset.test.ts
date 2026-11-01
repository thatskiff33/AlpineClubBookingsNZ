/**
 * #4453 review (S-F8, O-F9; `INV-SSOT`): ONE set of characters a role password
 * may not contain, because Compose puts the password into a connection string
 * unencoded. Two places enforce it — the provisioning CLI (TypeScript,
 * `CONNECTION_STRING_UNSAFE_PASSWORD`) and the deploy script's
 * `require_safe_database_password` (bash) — so this pins them equal. They
 * disagreed on `%` before this test existed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CONNECTION_STRING_UNSAFE_PASSWORD } from "@/lib/database-roles";

import { DEPLOY_SCRIPT, shellFunctionSource } from "./helpers/deploy-script";

/** The bracket expression's members, with POSIX classes spelled as names. */
function bracketMembers(bracket: string): Set<string> {
  const members = new Set<string>();
  let rest = bracket;
  for (const [token, name] of [
    ["[:space:]", "space"],
    ["\\s", "space"],
  ] as const) {
    if (rest.includes(token)) {
      members.add(name);
      rest = rest.replace(token, "");
    }
  }
  for (const character of rest) members.add(character);
  return members;
}

describe("the URL-unsafe password characters are one set (#4453)", () => {
  it("matches between the CLI and the deploy script", () => {
    const tsBracket = CONNECTION_STRING_UNSAFE_PASSWORD.source.match(/^\[(.*)\]$/)?.[1];
    expect(tsBracket, "the TypeScript rule is one bracket expression").toBeTruthy();

    const script = readFileSync(path.join(process.cwd(), DEPLOY_SCRIPT), "utf8");
    const body = shellFunctionSource(script, "require_safe_database_password");
    const bashBracket = body.match(/grep -Eq '\[(.*)\]'/)?.[1];
    expect(bashBracket, "the deploy check is one grep -Eq bracket expression").toBeTruthy();

    const ts = [...bracketMembers(tsBracket!)].sort();
    const bash = [...bracketMembers(bashBracket!)].sort();
    expect(bash).toEqual(ts);
    expect(ts).toEqual(["#", "%", "/", ":", "?", "@", "space"].sort());
  });
});
