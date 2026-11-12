import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
  #4984: the setup docs describe the database-first configuration model, and
  nothing else.

  Club configuration lives in the database (#1943). `pnpm run setup:wizard`
  writes settings rows and no files (#1987), and the Stripe webhook signing
  secret is entered in-app, with `STRIPE_WEBHOOK_SECRET` ignored (#2082). The
  canonical statement is `CONFIGURATION.md` "Club Config". When the model
  changed, the README, the Implementation Guide, configure-or-fork and a
  DEPLOYMENT section kept the old story, and a volunteer following them typed
  their club into a file the Docker app never reads.

  This census reads every tracked Markdown page and fails on the two stale
  claims: that the wizard writes `config/club.json`, and that
  `STRIPE_WEBHOOK_SECRET` is a live setting. Release history is exempt: it
  records what was true at the time.

  Scanned from disk, so `pnpm run test:related` cannot reach it from a doc
  edit: run it with `pnpm run test:named`.
*/

/** Historical records, which describe past behaviour on purpose. */
const HISTORY = [/^CHANGELOG\.md$/, /^changelog\.d\//, /^docs\/config-transfer\/decisions\//];

/** Words that mark a `STRIPE_WEBHOOK_SECRET` sentence as describing it as dead. */
const RETIRED_WORDING = /\b(?:ignored|no longer|not read|stop(?:s|ped)? being read|legacy|flag(?:s|ged)?)\b/i;

/** "the wizard writes `config/club.json`" and "`setup:wizard` writes it for you", across line wraps. */
const WIZARD_WRITES_FILE = /wizard`?\s+(?:writes|will write|fills in)\s+(?:`config\/club\.json`|it for you)/i;

function trackedMarkdown(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((file) => !HISTORY.some((pattern) => pattern.test(file)));
}

/** Collapses line wraps so a claim split over two lines still matches. */
function flowed(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The sentence around each mention, split at a full stop or semicolon followed by a space. */
function sentencesMentioning(text: string, needle: string): string[] {
  return flowed(text)
    .split(/(?<=[.;])\s+/)
    .filter((sentence) => sentence.includes(needle));
}

function staleSetupClaims(file: string, text: string): string[] {
  const claims: string[] = [];
  const wizard = flowed(text).match(WIZARD_WRITES_FILE);
  if (wizard) claims.push(`${file}: "${wizard[0]}"`);
  for (const sentence of sentencesMentioning(text, "STRIPE_WEBHOOK_SECRET")) {
    if (!RETIRED_WORDING.test(sentence)) claims.push(`${file}: "${sentence}"`);
  }
  return claims;
}

describe("setup docs describe database-first configuration (#4984)", () => {
  it("no tracked page says the wizard writes config/club.json or that STRIPE_WEBHOOK_SECRET configures Stripe", () => {
    const files = trackedMarkdown();
    expect(files.length).toBeGreaterThan(50);
    const claims = files.flatMap((file) => staleSetupClaims(file, readFileSync(file, "utf8")));
    expect(claims).toEqual([]);
  });

  it("catches each removed sentence, including when it wraps over two lines", () => {
    expect(staleSetupClaims("x.md", "The wizard writes `config/club.json` only.")).toHaveLength(1);
    expect(staleSetupClaims("x.md", "rates. `pnpm run setup:wizard` writes\nit for you.")).toHaveLength(1);
    expect(
      staleSetupClaims(
        "x.md",
        "Stripe and SES webhook secrets are env-configured (`STRIPE_WEBHOOK_SECRET`,\n`SES_SNS_TOPIC_ARN`); rotate them if exposed.",
      ),
    ).toHaveLength(1);
  });

  it("accepts the current wording", () => {
    expect(staleSetupClaims("x.md", "It writes no `config/club.json`, no `.env` file.")).toEqual([]);
    expect(
      staleSetupClaims("x.md", "the `STRIPE_WEBHOOK_SECRET` env var is ignored. Rotate either if exposed."),
    ).toEqual([]);
  });
});
