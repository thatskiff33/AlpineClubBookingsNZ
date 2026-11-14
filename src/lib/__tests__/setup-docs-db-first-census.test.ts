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
  `STRIPE_WEBHOOK_SECRET` is a live setting. `CHANGELOG.md`, `changelog.d/` and
  the config-transfer decision records are exempt, because they record what was
  true at the time. Release notes and `docs/UPGRADING.md` are scanned: they must
  still say the variable is retired.

  The variable name is the one hand-copied fact here. `LEGACY_PROVIDER_ENV_VARS`
  in `src/lib/xero-config.ts` is the canonical list of retired provider
  variables. It is not imported, because that module pulls in the credential
  store and Prisma, which need `DATABASE_URL` just to load. The last test ties
  the copy to the list by reading that file's text, so the name cannot leave the
  list unnoticed. Only this one name is scanned for: the other retired names
  are legitimately documented as live in places, for example the E2E app
  container's `STRIPE_SECRET_KEY` in `docs/E2E_PLAYWRIGHT.md`.

  Scanned from disk, so `pnpm run test:related` cannot reach it from a doc
  edit: run it with `pnpm run test:named`.
*/

/** Historical records, which describe past behaviour on purpose. */
const HISTORY = [/^CHANGELOG\.md$/, /^changelog\.d\//, /^docs\/config-transfer\/decisions\//];

/** The retired variable. Canonical list: `LEGACY_PROVIDER_ENV_VARS.stripe` in `src/lib/xero-config.ts`. */
const RETIRED_STRIPE_VAR = "STRIPE_WEBHOOK_SECRET";

/** Words that mark a `STRIPE_WEBHOOK_SECRET` sentence as describing it as dead. */
const RETIRED_WORDING = /\b(?:ignored|no longer|not read|stop(?:s|ped)? being read|legacy)\b/i;

/**
  "the wizard writes `config/club.json`", "`setup:wizard` writes it for you" and "the wizard saves your answers to
  config/club.json", with or without backticks, across line wraps. "It writes no `config/club.json`" and "the wizard
  writes the club's settings rows" do not match: the verb must be followed at once by the file or by "it for you".
*/
const WIZARD_WRITES_FILE =
  /wizard`?\s+(?:(?:writes|will write|fills in|creates|generates)|saves[^.;]{0,40}?\bto)\s+(?:the\s+)?(?:`?config\/club\.json`?|it for you)/i;

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

/**
  Blocks that cannot share a sentence: a paragraph, a list item or a table row each stand alone, so a period-free
  bullet or table row is judged by its own words and not by its neighbour's.
*/
function blocks(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) out.push(current.join("\n"));
    current = [];
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      flush();
    } else {
      if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line) || /^\s*\|/.test(line)) flush();
      current.push(line);
    }
  }
  flush();
  return out;
}

/** The sentence around each mention, split at a full stop or semicolon followed by a space. */
function sentencesMentioning(text: string, needle: string): string[] {
  return blocks(text)
    .flatMap((block) => flowed(block).split(/(?<=[.;])\s+/))
    .filter((sentence) => sentence.includes(needle));
}

function staleSetupClaims(file: string, text: string): string[] {
  const claims: string[] = [];
  const wizard = flowed(text).match(WIZARD_WRITES_FILE);
  if (wizard) claims.push(`${file}: "${wizard[0]}"`);
  for (const sentence of sentencesMentioning(text, RETIRED_STRIPE_VAR)) {
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

  it("catches the same claims worded loosely or set among neighbouring lines", () => {
    // No backticks, and a verb other than "writes".
    expect(staleSetupClaims("x.md", "The setup wizard writes config/club.json for you.")).toHaveLength(1);
    expect(staleSetupClaims("x.md", "The wizard saves your answers to `config/club.json`.")).toHaveLength(1);
    // A table row and a period-free bullet are judged on their own, not with a neighbour that says "legacy, ignored".
    expect(
      staleSetupClaims("x.md", "| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret |\n| `OLD_VAR` | legacy, ignored |"),
    ).toHaveLength(1);
    expect(staleSetupClaims("x.md", "- Set `STRIPE_WEBHOOK_SECRET` for webhooks\n- `OLD_VAR` is ignored")).toHaveLength(
      1,
    );
    // The word "flag" no longer exempts a sentence.
    expect(staleSetupClaims("x.md", "Set `STRIPE_WEBHOOK_SECRET` and pass the --flag option.")).toHaveLength(1);
  });

  it("accepts the current wording", () => {
    expect(staleSetupClaims("x.md", "It writes no `config/club.json`, no `.env` file.")).toEqual([]);
    expect(staleSetupClaims("x.md", "The wizard writes the club's settings rows, not `config/club.json`.")).toEqual([]);
    expect(
      staleSetupClaims("x.md", "the `STRIPE_WEBHOOK_SECRET` env var is ignored. Rotate either if exposed."),
    ).toEqual([]);
    // A wrapped bullet that carries its own retired wording stays accepted.
    expect(
      staleSetupClaims("x.md", "- `STRIPE_WEBHOOK_SECRET` env vars still present are\n  ignored and flagged in setup."),
    ).toEqual([]);
  });

  it("scans for a name that is still on the canonical retired-variable list", () => {
    const source = readFileSync("src/lib/xero-config.ts", "utf8");
    const stripeEntry = source.match(/\bstripe:\s*\[([^\]]*)\]/);
    expect(stripeEntry?.[1]).toContain(`"${RETIRED_STRIPE_VAR}"`);
  });
});
