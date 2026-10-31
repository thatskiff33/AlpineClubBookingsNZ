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

const ALL = [
  "design-system/no-native-confirm",
  "design-system/no-raw-button",
  "design-system/no-raw-input",
  "design-system/no-raw-select",
  "design-system/no-raw-table",
];

describe("design-system rules through the repository config", () => {
  it("reports every raw control in app code, and the browser confirm in a .ts hook", async () => {
    expect(await designSystemRules("src/app/(admin)/admin/probe/page.tsx")).toEqual(ALL);
    expect(await designSystemRules("src/components/probe-panel.tsx")).toEqual(ALL);
    expect(await designSystemRules("src/app/(admin)/admin/probe/_hooks/use-probe.ts", 'export const go = () => window.confirm("x");'))
      .toEqual(["design-system/no-native-confirm"]);
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
