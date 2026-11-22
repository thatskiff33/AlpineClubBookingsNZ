import {
  appendDeploySteps,
  countDeploySteps,
  DEPLOY_STEPS_END,
  DEPLOY_STEPS_START,
  deployFragmentProblems,
  deployStepsBlock,
  findDeploySteps,
  isDeployFragmentName,
  parseDeployFragment,
  renderDeployStepItems,
} from "./deploy-fragments.mjs";

const REPO = { host: "github.com", owner: "club", name: "bookings" };

const fragment = ({ who = "owner", what = "Run `pnpm run xero:report` once.", check = "It prints no rows." } = {}) =>
  `## Who\n\n${who}\n\n## What to do\n\n${what}\n\n## How to check it worked\n\n${check}\n`;

describe("deploy fragment names", () => {
  it("tells a deploy step from a changelog entry by its suffix", () => {
    expect(isDeployFragmentName("5189-image-memory.deploy.md")).toBe(true);
    expect(isDeployFragmentName("5189-image-memory.md")).toBe(false);
    expect(isDeployFragmentName("5189-deploy-notes.feature.md")).toBe(false);
  });

  it("accepts a numbered or lane-named slug and refuses anything else", () => {
    expect(deployFragmentProblems("5189-image-memory.deploy.md", fragment())).toEqual([]);
    expect(deployFragmentProblems("alp-793-image-memory.deploy.md", fragment())).toEqual([]);
    for (const name of ["5189_Image.deploy.md", "5189 image.deploy.md", "-x.deploy.md", "5189-x.DEPLOY.md"]) {
      expect(deployFragmentProblems(name, fragment()).join(" "), name).toMatch(/its name must be/);
    }
  });
});

describe("deploy fragment shape", () => {
  const problems = (text) => deployFragmentProblems("1-x.deploy.md", text).join(" | ");

  it("parses a well-formed step, taking the pull request from the name", () => {
    const text = fragment({ who: "Operator", what: "Set the option.\n\n```bash\n# not a heading\nexport A=1\n```", check: "The build passes." });
    expect(parseDeployFragment("5189-image-memory.deploy.md", text)).toEqual({
      name: "5189-image-memory.deploy.md",
      pr: 5189,
      who: "operator",
      what: "Set the option.\n\n```bash\n# not a heading\nexport A=1\n```",
      check: "The build passes.",
    });
    expect(parseDeployFragment("alp-793-x.deploy.md", fragment()).pr).toBeNull();
  });

  it("reads a CRLF fragment like an LF one", () => {
    expect(deployFragmentProblems("1-x.deploy.md", fragment().replace(/\n/g, "\r\n"))).toEqual([]);
  });

  it("names each missing, repeated, extra or misordered heading", () => {
    expect(problems("## Who\n\nowner\n\n## What to do\n\nRun it.\n")).toMatch(/no "## How to check it worked" heading/);
    expect(problems(`${fragment()}\n## Who\n\nofficer\n`)).toMatch(/"## Who" 2 times/);
    expect(problems(`${fragment()}\n### Notes\n\nMore.\n`)).toMatch(/other than the three: "### Notes"/);
    expect(problems("## What to do\n\nRun it.\n\n## Who\n\nowner\n\n## How to check it worked\n\nIt ran.\n")).toMatch(/in the order/);
  });

  it("refuses text above the first heading and an empty section", () => {
    expect(problems(`Intro.\n\n${fragment()}`)).toMatch(/text above "## Who"/);
    expect(problems(fragment({ check: "" }))).toMatch(/"## How to check it worked" is empty/);
  });

  it("needs one known role on one line", () => {
    expect(problems(fragment({ who: "treasurer" }))).toMatch(/one of owner, operator, officer/);
    expect(problems(fragment({ who: "owner\nofficer" }))).toMatch(/one of owner, operator, officer/);
  });

  it("needs each instruction to open with a sentence, so it reads after the role on one line", () => {
    expect(problems(fragment({ what: "- Run it.\n- Check it." }))).toMatch(/"## What to do" must open with a sentence/);
    expect(problems(fragment({ check: "```bash\nls\n```" }))).toMatch(/"## How to check it worked" must open with a sentence/);
    expect(problems(fragment({ what: "Do this:\n\n1. Run it." }))).toBe("");
  });

  it("refuses the rendered block's markers inside a step", () => {
    expect(problems(fragment({ what: `Run it.\n${DEPLOY_STEPS_END}` }))).toMatch(/must not contain/);
  });

  it("throws on a malformed step rather than parse part of it", () => {
    expect(() => parseDeployFragment("1-x.deploy.md", fragment({ who: "everyone" }))).toThrow(/changelog\.d\/1-x\.deploy\.md: .*one of owner/);
  });
});

describe("rendered steps", () => {
  const steps = [
    parseDeployFragment("5189-a.deploy.md", fragment({ what: "Run it.\n\n- with care", check: "It ran." })),
    parseDeployFragment("alp-1-b.deploy.md", fragment({ who: "officer", what: "Look.", check: "Seen." })),
  ];

  it("renders one task per step with its role, check and linked pull request", () => {
    expect(renderDeployStepItems(steps, REPO)).toEqual([
      "- [ ] **Owner:** Run it.",
      "",
      "  - with care",
      "",
      "  How to check it worked: It ran.",
      "",
      "  From [#5189](https://github.com/club/bookings/pull/5189).",
      "",
      "- [ ] **Officer:** Look.",
      "",
      "  How to check it worked: Seen.",
      "",
      "  From `changelog.d/alp-1-b.deploy.md`.",
    ]);
    expect(renderDeployStepItems(steps.slice(0, 1), null).at(-1)).toBe("  From #5189.");
  });

  it("finds and counts the steps between the markers, and appends after them", () => {
    const items = renderDeployStepItems(steps, REPO);
    const page = ["# Notes", "", ...deployStepsBlock(items.slice(0, 7)), "", "Tail."].join("\n");
    const found = findDeploySteps(page);
    expect(countDeploySteps(found.items)).toBe(1);

    const appended = appendDeploySteps(page, items.slice(8));
    expect(countDeploySteps(findDeploySteps(appended).items)).toBe(2);
    expect(appended.endsWith(`${DEPLOY_STEPS_END}\n\nTail.`)).toBe(true);
    expect(findDeploySteps(appended).items).toEqual(items);
  });

  it("has nothing to find without markers, and refuses unpaired ones rather than guess", () => {
    expect(findDeploySteps("# Notes\n")).toBeNull();
    expect(() => findDeploySteps(`${DEPLOY_STEPS_START}\n- [ ] x\n`)).toThrow(/expected one/);
    expect(() => findDeploySteps(`${DEPLOY_STEPS_END}\n${DEPLOY_STEPS_START}\n`)).toThrow(/expected one/);
    expect(() => appendDeploySteps("# Notes\n", ["- [ ] x"])).toThrow(/no .* block/);
  });
});
