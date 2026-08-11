import { describe, expect, it } from "vitest";

import {
  assessThread,
  decisionOptions,
  detectDecisionMarkers,
  hasDecidedHeader,
  parseIssueArgument,
  referencedIssueNumbers,
  renderDecisionSummary,
} from "./issue-thread.mjs";

/**
 * Unit coverage for the pure half of `npm run issue` — decision detection and
 * the stale-body detection it exists to raise.
 *
 * The fixtures are modelled on #2777, the canonical case: a body offering four
 * unticked `- [ ] **Recommended** …` options and a comment recording the owner's
 * decision from the previous evening. Nothing here talks to GitHub; the CLI half
 * of the script is a `gh` shell-out and is left to manual use.
 */

/** A #2777-shaped body: a Decisions section of options, plus other checklists. */
const OPEN_BODY = `Carried out of #2765. The owner decided on 11 August 2026 that the writers move.

## Decisions

### D1 — where the four locker writers file

- [ ] **Recommended — add a NEW canonical category** for officer-side administration.
- [ ] Leave them at \`admin\` and close the question.
- [ ] \`lodge\`. Treats a locker as part of the building.

### D2 — what happens to rows already written

- [ ] **Recommended — ship the backfill in the same PR**, per \`INV-OPS-012\`.

## Acceptance criteria

- [ ] Whatever is decided is recorded as an \`INV-*\` rule with the reason.
- [ ] The per-site pin is updated deliberately rather than to make CI pass.
`;

/** The same body once its owner decision was recorded per the convention. */
const DECIDED_BODY = `> **DECIDED 11 Aug 2026 — the four locker writers stay at \`admin\`.**
> Recorded in [this comment](https://github.com/o/r/issues/2777#issuecomment-1).

## Decisions

### D1 — where the four locker writers file

- [x] ~~**Recommended — add a NEW canonical category**~~ (settled: not chosen)
- [ ] ~~Leave them at \`admin\`~~ — CHOSEN

## Acceptance criteria

- [ ] The per-site pin is updated deliberately rather than to make CI pass.
`;

const DECISION_COMMENT = {
  author: { login: "owner" },
  createdAt: "2026-08-10T20:41:58Z",
  url: "https://github.com/o/r/issues/2777#issuecomment-1",
  body: "## Owner decision — 11 August 2026\n\n**D1: Leave the four writers at `admin`.**",
};

const CHATTER_COMMENT = {
  author: { login: "agent" },
  createdAt: "2026-08-09T01:00:00Z",
  url: "https://github.com/o/r/issues/2777#issuecomment-0",
  body: "CLAIM: starting on this now. Branch `docs/issue-2777-locker-categories`.",
};

describe("detectDecisionMarkers", () => {
  it("matches every decision shape this repository actually posts", () => {
    const cases = [
      ["## Owner decision — 11 August 2026", "owner-decision"],
      ["Looks good, ready to action.", "ready-to-action"],
      ["Decisions recorded in the epic body.", "decisions-recorded"],
      ["Decisions added to the body just now.", "decisions-added"],
      ["Decision taken: option 2.", "decision-taken"],
      ["Recording an orchestrator decision here.", "orchestrator-decision"],
      ["> **DECIDED 11 Aug 2026 — option 2.**", "decided-header"],
    ];
    for (const [text, id] of cases) {
      expect(detectDecisionMarkers(text).map((marker) => marker.id)).toContain(
        id,
      );
    }
  });

  it("does not fire on ordinary lane chatter", () => {
    expect(detectDecisionMarkers(CHATTER_COMMENT.body)).toEqual([]);
    expect(
      detectDecisionMarkers("We should decide this before Friday, I think."),
    ).toEqual([]);
    expect(detectDecisionMarkers("")).toEqual([]);
    expect(detectDecisionMarkers(undefined)).toEqual([]);
  });
});

describe("hasDecidedHeader", () => {
  it("accepts the documented header, quoted or bare", () => {
    expect(hasDecidedHeader(DECIDED_BODY)).toBe(true);
    expect(hasDecidedHeader("**DECIDED 1 Jan 2026 — option 1.**\n\nrest")).toBe(
      true,
    );
  });

  it("rejects prose that merely contains the word", () => {
    expect(hasDecidedHeader(OPEN_BODY)).toBe(false);
    expect(hasDecidedHeader("The owner decided this yesterday.")).toBe(false);
  });
});

describe("decisionOptions", () => {
  it("counts only the Decisions section, never acceptance criteria", () => {
    const options = decisionOptions(OPEN_BODY);
    expect(options.hasSection).toBe(true);
    expect(options.unticked).toHaveLength(4);
    expect(options.ticked).toHaveLength(0);
    expect(options.unticked.join(" ")).not.toContain("per-site pin");
  });

  it("closes the section at the next same-level heading", () => {
    const options = decisionOptions(
      "## Decisions\n\n- [ ] one\n\n## Later\n\n- [ ] not an option\n",
    );
    expect(options.unticked).toEqual(["one"]);
  });

  it("falls back to Recommended-style options when there is no section", () => {
    const options = decisionOptions(
      "Some preamble.\n\n- [ ] **Recommended** do the safe thing\n- [ ] something else\n",
    );
    expect(options.hasSection).toBe(false);
    expect(options.unticked).toEqual(["Recommended do the safe thing"]);
  });

  it("ignores option lists shown inside fenced code", () => {
    const options = decisionOptions(
      "## Decisions\n\n```markdown\n- [ ] **Recommended** an example, not a real option\n```\n\n- [ ] a real option\n",
    );
    expect(options.unticked).toEqual(["a real option"]);
  });

  it("separates ticked from unticked", () => {
    const options = decisionOptions(DECIDED_BODY);
    expect(options.ticked).toHaveLength(1);
    expect(options.unticked).toHaveLength(1);
  });
});

describe("assessThread — the stale state that causes the failure", () => {
  it("flags a body with unticked options plus a decision comment", () => {
    const assessment = assessThread({
      body: OPEN_BODY,
      comments: [CHATTER_COMMENT, DECISION_COMMENT],
    });
    expect(assessment.stale).toBe(true);
    expect(assessment.verdict).toBe("stale-body");
    expect(assessment.decisionComments).toHaveLength(1);
    expect(assessment.decisionComments[0].author).toBe("owner");
    // The reader is pointed at the comment's position in the printed thread.
    expect(assessment.decisionComments[0].index).toBe(1);
  });

  it("does not flag a body that already carries the DECIDED header", () => {
    const assessment = assessThread({
      body: DECIDED_BODY,
      comments: [CHATTER_COMMENT, DECISION_COMMENT],
    });
    expect(assessment.stale).toBe(false);
    expect(assessment.verdict).toBe("decided-in-body");
  });

  it("does not flag an issue with no comments at all", () => {
    const assessment = assessThread({ body: OPEN_BODY, comments: [] });
    expect(assessment.stale).toBe(false);
    expect(assessment.verdict).toBe("open");
  });

  it("tolerates being handed nothing", () => {
    expect(assessThread().verdict).toBe("no-decision-found");
    expect(assessThread({}).stale).toBe(false);
  });

  it("notes a silent body when a decision exists but no option list does", () => {
    const assessment = assessThread({
      body: "Just a description, no options.",
      comments: [DECISION_COMMENT],
    });
    expect(assessment.stale).toBe(false);
    expect(assessment.bodySilent).toBe(true);
    expect(assessment.verdict).toBe("body-silent");
  });
});

describe("renderDecisionSummary", () => {
  it("shouts on the stale case and names the fix", () => {
    const summary = renderDecisionSummary(
      assessThread({ body: OPEN_BODY, comments: [DECISION_COMMENT] }),
    );
    expect(summary).toContain("STALE BODY");
    expect(summary).toContain("docs/agents/ISSUE_WORKFLOW.md");
    expect(summary).toContain("owner");
  });

  it("stays quiet when the body carries the answer", () => {
    const summary = renderDecisionSummary(
      assessThread({ body: DECIDED_BODY, comments: [DECISION_COMMENT] }),
    );
    expect(summary).not.toContain("STALE BODY");
  });
});

describe("referencedIssueNumbers", () => {
  it("collects, dedupes, sorts, and drops the issue itself", () => {
    expect(
      referencedIssueNumbers("Parent: #2765, related #2751, #2765 again. (#2777)", 2777),
    ).toEqual([2751, 2765]);
  });

  it("does not treat a fragment or a colour as an issue", () => {
    expect(referencedIssueNumbers("colour #FBCA04 and section#12", 0)).toEqual(
      [],
    );
  });
});

describe("parseIssueArgument", () => {
  it("accepts a number, a hash, or a URL", () => {
    expect(parseIssueArgument(["2777"])).toBe(2777);
    expect(parseIssueArgument(["#2777"])).toBe(2777);
    expect(parseIssueArgument(["https://github.com/o/r/issues/2777"])).toBe(
      2777,
    );
  });

  it("refuses flags, because there is no flag that prints less", () => {
    expect(() => parseIssueArgument(["2777", "--body-only"])).toThrow(
      /no flags/,
    );
  });

  it("refuses anything that is not one issue reference", () => {
    expect(() => parseIssueArgument([])).toThrow(/Usage/);
    expect(() => parseIssueArgument(["2777", "2765"])).toThrow(/Usage/);
    expect(() => parseIssueArgument(["not-an-issue"])).toThrow(/Not an issue/);
  });
});
