import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { ESLint, RuleTester } from "eslint";

import designSystem, { PRIMITIVE_IMPLEMENTATIONS } from "./design-system.mjs";

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
});
const rule = (name) => designSystem.rules[name];

tester.run("no-raw-button", rule("no-raw-button"), {
  valid: [
    'import { Button } from "@/components/ui/button";\nconst a = <Button type="button">Go</Button>;',
    // Only the intrinsic element: a member expression or a capitalised name is a component.
    "const a = <ui.button>Go</ui.button>;",
    "const a = <ButtonGroup />;",
  ],
  invalid: [
    { code: '<button type="button" onClick={go}>Go</button>', errors: [{ messageId: "raw" }] },
    { code: "const a = <div>{open && <button>Go</button>}</div>;", errors: [{ messageId: "raw" }] },
  ],
});

tester.run("no-raw-input", rule("no-raw-input"), {
  valid: [
    'import { Input } from "@/components/ui/input";\nconst a = <Input type="text" />;',
    // Form data, not a control.
    '<input type="hidden" name="tab" value={tab} />',
    '<input type={"hidden"} name="tab" value={tab} />',
    // The picker a Button opens: visually hidden by a literal class or attribute.
    '<input ref={fileRef} type="file" className="hidden" onChange={pick} />',
    '<input type="file" className="peer sr-only" tabIndex={-1} />',
    '<input type="file" hidden />',
    '<input type="file" hidden={true} />',
    // Classes that hide it further, or only style it, do not undo the exemption.
    '<input type="file" className="hidden md:hidden w-full" />',
    '<input type="file" className="sr-only peer" hidden />',
    // A spread BEFORE the attributes it relies on cannot override them.
    '<input {...rest} type="hidden" name="tab" />',
    '<input {...rest} type="file" className="hidden" />',
    // JSX applies the last of a repeated attribute.
    '<input type="text" type="hidden" />',
  ],
  invalid: [
    { code: '<input type="text" value={v} />', errors: [{ messageId: "raw" }] },
    { code: "<input {...props} />", errors: [{ messageId: "raw" }] },
    // A type decided at runtime might be anything.
    { code: "<input type={kind} />", errors: [{ messageId: "raw" }] },
    { code: '<input type="checkbox" checked={on} />', errors: [{ messageId: "checkbox" }] },
    { code: '<input type="radio" name="tier" />', errors: [{ messageId: "radio" }] },
    // A visible file input should be <Input type="file">.
    { code: '<input type="file" className="block text-sm" />', errors: [{ messageId: "raw" }] },
    // Visibility decided at runtime, or a class that merely contains the word, is not exempt.
    { code: '<input type="file" className={cn("hidden", extra)} />', errors: [{ messageId: "raw" }] },
    { code: '<input type="file" className="md:hidden-ish" />', errors: [{ messageId: "raw" }] },
    { code: '<input type="file" hidden={collapsed} />', errors: [{ messageId: "raw" }] },
    // Hidden by class but not a file picker: still a control.
    { code: '<input type="text" className="hidden" />', errors: [{ messageId: "raw" }] },
    // A class token that can show the input again ends the exemption, with any variant prefix.
    ...[
      "hidden block", "hidden md:block", "sr-only focus:not-sr-only", "sr-only not-sr-only", "hidden lg:flex",
      "hidden sm:inline-block", "hidden !grid", "hidden hover:inline", "hidden [display:block]", "sr-only md:focus:table-cell",
    ].map((className) => ({ code: `<input type="file" className="${className}" />`, errors: [{ messageId: "raw" }] })),
    { code: '<input type="file" hidden className="block" />', errors: [{ messageId: "raw" }] },
    { code: '<input type="file" hidden className={cls} />', errors: [{ messageId: "raw" }] },
    // Only a prefixed hide: visible below that breakpoint.
    { code: '<input type="file" className="md:hidden" />', errors: [{ messageId: "raw" }] },
    // A spread AFTER an attribute the exemption relies on may replace it at runtime.
    { code: '<input type="hidden" {...rest} />', errors: [{ messageId: "raw" }] },
    { code: '<input type="file" className="hidden" {...rest} />', errors: [{ messageId: "raw" }] },
    { code: '<input type="file" hidden {...rest} />', errors: [{ messageId: "raw" }] },
    { code: '<input className="hidden" type="file" {...rest} />', errors: [{ messageId: "raw" }] },
    { code: '<input type="checkbox" {...rest} />', errors: [{ messageId: "raw" }] },
    { code: '<input type="hidden" type="text" />', errors: [{ messageId: "raw" }] },
  ],
});

tester.run("no-raw-select", rule("no-raw-select"), {
  valid: ['import { Select } from "@/components/ui/select";\nconst a = <Select value={v} />;'],
  invalid: [{ code: "<select value={v} onChange={set}><option>a</option></select>", errors: [{ messageId: "raw" }] }],
});

tester.run("no-raw-table", rule("no-raw-table"), {
  valid: ['import { Table } from "@/components/ui/table";\nconst a = <Table><tbody /></Table>;'],
  invalid: [{ code: '<table className="w-full"><tbody /></table>', errors: [{ messageId: "raw" }] }],
});

tester.run("no-native-confirm", rule("no-native-confirm"), {
  valid: [
    // The sanctioned dialog, however it is bound.
    'const { confirm } = useConfirm();\nasync function go() { if (!(await confirm({ title: "Delete?" }))) return; }',
    'import { confirm } from "./dialog";\nconfirm({ title: "x" });',
    "function run(confirm) { return confirm(); }",
    "async function confirm() {}\nconfirm();",
    "const confirm = () => true;\nconfirm();",
    // Not the browser's confirm.
    "dialog.confirm();",
    "window.confirmation();",
    "const ask = confirmed();",
    "const { prompt } = window;",
    "const { confirm } = dialogs;",
    "const { confirm } = useConfirm();",
    "let confirm; ({ confirm } = useConfirm());",
    "frame.confirm();",
  ],
  invalid: [
    { code: 'if (!window.confirm("Delete?")) stop();', errors: [{ messageId: "native" }] },
    { code: 'globalThis.confirm("Delete?");', errors: [{ messageId: "native" }] },
    { code: 'self.confirm("Delete?");', errors: [{ messageId: "native" }] },
    { code: 'window["confirm"]("Delete?");', errors: [{ messageId: "native" }] },
    { code: 'window.confirm?.("Delete?");', errors: [{ messageId: "native" }] },
    { code: 'if (!confirm("Delete this period?")) stop();', errors: [{ messageId: "native" }] },
    // A `confirm` declared in another function does not cover this one.
    { code: 'function a() { const confirm = 1; }\nfunction b() { return confirm("x"); }', errors: [{ messageId: "native" }] },
    { code: 'top.confirm("Delete?");', errors: [{ messageId: "native" }] },
    { code: 'parent.confirm("Delete?");', errors: [{ messageId: "native" }] },
    { code: 'window[`confirm`]("Delete?");', errors: [{ messageId: "native" }] },
    { code: '(0, window.confirm)("Delete?");', errors: [{ messageId: "native" }] },
    { code: 'window.confirm.call(window, "Delete?");', errors: [{ messageId: "native" }] },
    { code: 'globalThis.confirm.apply(null, ["Delete?"]);', errors: [{ messageId: "native" }] },
    // Destructured from the global: the destructure is reported, the later call is local.
    { code: 'const { confirm } = window;\nconfirm("Delete?");', errors: [{ messageId: "native" }] },
    { code: 'const { confirm: ask, alert } = globalThis;', errors: [{ messageId: "native" }] },
    { code: 'const { ["confirm"]: ask } = self;', errors: [{ messageId: "native" }] },
    { code: 'let confirm; ({ confirm } = window);', errors: [{ messageId: "native" }] },
  ],
});

tester.run("no-native-confirm (browser globals configured)", rule("no-native-confirm"), {
  valid: [],
  invalid: [
    {
      code: 'if (!confirm("Delete?")) stop();',
      languageOptions: { globals: { confirm: "readonly", window: "readonly" } },
      errors: [{ messageId: "native" }],
    },
  ],
});

// The scope lives in eslint.config.mjs, so it is proved through the real config.
const RAW = [
  "export function A() {",
  '  if (!window.confirm("Delete?")) return null;',
  '  return <div><button type="button">x</button><input type="text" /><select /><table /></div>;',
  "}",
].join("\n");

async function designSystemRules(filePath, code = RAW) {
  const [result] = await new ESLint().lintText(code, { filePath });
  return result.messages
    .map((message) => message.ruleId)
    .filter((ruleId) => ruleId?.startsWith("design-system/"))
    .sort();
}

// Every rule the plugin has: RAW must trip each one, so a new rule fails here until it does.
const ALL = Object.keys(designSystem.rules).map((name) => `design-system/${name}`).sort();

describe("design-system rules through the repository config", () => {
  it("switches on every rule the plugin has, as an error", async () => {
    const config = await new ESLint().calculateConfigForFile("src/app/(admin)/admin/probe/page.tsx");
    for (const ruleId of ALL) expect([config.rules[ruleId]].flat()[0], ruleId).toBe(2);
  }, 20_000);

  it("reports every raw control in app code, and the browser confirm in a .ts hook", async () => {
    expect(await designSystemRules("src/app/(admin)/admin/probe/page.tsx")).toEqual(ALL);
    expect(await designSystemRules("src/components/probe-panel.tsx")).toEqual(ALL);
    // A bare confirm resolves to the browser global the repository config declares.
    expect(await designSystemRules("src/app/(admin)/admin/probe/_hooks/use-probe.ts", 'export const go = () => confirm("x") && window.confirm("y");'))
      .toEqual(["design-system/no-native-confirm", "design-system/no-native-confirm"]);
    expect(await designSystemRules("src/app/(admin)/admin/probe/use-probe.ts", 'import { useConfirm } from "@/components/confirm-dialog";\nexport function useProbe() { const { confirm } = useConfirm(); return () => confirm({ title: "x" }); }'))
      .toEqual([]);
  }, 20_000);

  it("leaves the primitives and test files alone", async () => {
    expect(await designSystemRules("src/components/ui/probe.tsx")).toEqual([]);
    expect(await designSystemRules("src/components/ui/nested/probe.tsx")).toEqual([]);
    expect(await designSystemRules("src/components/__tests__/probe.test.tsx")).toEqual([]);
    expect(await designSystemRules("src/lib/probe.test.tsx")).toEqual([]);
    expect(await designSystemRules("src/test/providers/probe.tsx")).toEqual([]);
  }, 20_000);

  it("lifts exactly one rule for each named primitive implementation", async () => {
    expect(PRIMITIVE_IMPLEMENTATIONS.length).toBeGreaterThan(0);
    for (const { file, rule: lifted, reason } of PRIMITIVE_IMPLEMENTATIONS) {
      // A stale entry would be an exemption waiting for a new file of that name.
      expect(existsSync(file), file).toBe(true);
      expect(Object.keys(designSystem.rules)).toContain(lifted);
      expect(reason.length).toBeGreaterThan(20);
      expect(await designSystemRules(file)).toEqual(ALL.filter((ruleId) => ruleId !== `design-system/${lifted}`));
    }
  }, 20_000);
});

// The rules carry no inline escape. Each one names a primitive that is
// available everywhere, so a disable comment only signs a raw control off as
// migrated, and the ratchet exists to make that count fall honestly. This is
// the money and cents guards' "never a disable comment" census, but the
// comments are found by ESLint's own directive parser rather than by grep, so
// a block directive naming the rule on its second line, a JSX `{/* … */}`
// directive and an inline rule-config comment are all seen, and prose that
// merely mentions a directive is not.
const directiveProbe = {
  rules: {
    directives: {
      meta: { schema: [] },
      create(context) {
        return {
          "Program:exit"() {
            const { sourceCode } = context;
            for (const directive of sourceCode.getDisableDirectives().directives) {
              if (directive.type === "enable") continue;
              context.report({ loc: directive.node.loc, message: JSON.stringify({ kind: directive.type, rules: directive.value.trim() }) });
            }
            for (const comment of sourceCode.getInlineConfigNodes()) {
              if (/^\s*eslint\s/.test(comment.value)) {
                context.report({ loc: comment.loc, message: JSON.stringify({ kind: "config", rules: comment.value.trim() }) });
              }
            }
          },
        };
      },
    },
  },
};

// Directives are read, not applied: an applied one could hide the probe itself.
const directiveReader = () => new ESLint({
  allowInlineConfig: false,
  overrideConfig: { plugins: { "directive-probe": directiveProbe }, rules: { "directive-probe/directives": "error" } },
});

/** Each directive that silences a design-system rule, as `file:line kind rules`. */
async function escapesIn(results) {
  const repoConfig = new ESLint();
  const escapes = [];
  for (const result of results) {
    const file = result.filePath.slice(process.cwd().length + 1);
    for (const message of result.messages) {
      if (message.ruleId !== "directive-probe/directives") continue;
      const { kind, rules } = JSON.parse(message.message);
      const names = rules.includes("design-system/");
      // A disable naming no rule silences every rule, these included, wherever they apply.
      const bare = kind !== "config" && rules === "";
      if (!names && !(bare && await appliesTo(repoConfig, file))) continue;
      escapes.push(`${file}:${message.line} ${kind} ${rules || "(every rule)"}`);
    }
  }
  return escapes;
}

async function appliesTo(eslint, file) {
  const config = await eslint.calculateConfigForFile(file);
  return Object.keys(designSystem.rules).some((name) => [config?.rules?.[`design-system/${name}`]].flat()[0] === 2);
}

describe("design-system rules have no inline escape", () => {
  const DIRECTIVE_FIXTURES = [
    ["a next-line disable naming a rule", 'const a = 1;\n// eslint-disable-next-line design-system/no-raw-button\nconst b = <button />;\n', 1],
    ["a same-line disable", 'const b = <button />; // eslint-disable-line design-system/no-raw-button -- legacy\n', 1],
    ["a file-wide block disable naming it on its second line", '/* eslint-disable\n   design-system/no-native-confirm */\nwindow.confirm("x");\n', 1],
    ["a JSX comment directive", 'const a = <div>\n  {/* eslint-disable-next-line design-system/no-raw-select */}\n  <select />\n</div>;\n', 1],
    ["an inline rule-config comment", '/* eslint design-system/no-raw-table: "off" */\nconst t = <table />;\n', 1],
    ["a bare disable in app code", '// eslint-disable-next-line\nconst b = <button />;\n', 1],
    ["a disable naming another rule", '// eslint-disable-next-line no-console\nconsole.log(1);\n', 0],
    ["prose about a directive", '// An eslint-disable naming design-system/no-raw-button is banned.\nconst a = 1;\n', 0],
    ["a string holding a directive", 'const a = "// eslint-disable-next-line design-system/no-raw-button";\n', 0],
  ];

  it.each(DIRECTIVE_FIXTURES)("counts %s", async (_label, code, expected) => {
    const results = await directiveReader().lintText(code, { filePath: "src/app/(admin)/admin/probe/page.tsx" });
    expect(await escapesIn(results)).toHaveLength(expected);
  }, 20_000);

  it("allows a bare disable where the rules do not apply", async () => {
    const results = await directiveReader().lintText('// eslint-disable-next-line\nconst b = <button />;\n', { filePath: "src/components/ui/probe.tsx" });
    expect(await escapesIn(results)).toEqual([]);
  }, 20_000);

  it("has none anywhere in the tree", async () => {
    // Only files that could hold one are parsed: a disable or a rule name.
    const candidates = execFileSync(
      "git",
      ["grep", "-l", "-e", "eslint-disable", "-e", "design-system/", "--", "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"],
      { encoding: "utf8" },
    ).split("\n").filter(Boolean);
    expect(candidates.length, "the search found nothing, so it proves nothing").toBeGreaterThan(10);
    const results = await directiveReader().lintFiles(candidates);
    expect(
      await escapesIn(results),
      "Never an eslint-disable comment for a design-system rule: migrate to the primitive, or for a shared primitive outside src/components/ui/, add it to PRIMITIVE_IMPLEMENTATIONS with its reason.",
    ).toEqual([]);
  }, 60_000);
});
