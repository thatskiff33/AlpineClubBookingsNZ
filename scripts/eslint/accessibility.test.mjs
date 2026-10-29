import { RuleTester } from "eslint";
import css from "@eslint/css";
import accessibility from "./accessibility.mjs";

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, parserOptions: { ecmaFeatures: { jsx: true } } } });
tester.run("minimum-text-size", accessibility.rules["minimum-text-size"], {
  valid: [
    '<span className="text-xs text-[12px] sm:text-[0.75rem]" />',
    'const style = { fontSize: 12 };',
    'const style = { fontSize: "0.75rem" };',
    'const style = { fontSize: "9pt" };',
    '<span className="text-[1pc]" />',
    'const style = { width: 10 };',
    'const color = "text-[#111111]";',
  ],
  invalid: [
    { code: '<span className="sm:text-[11px]" />', errors: [{ messageId: "small" }] },
    { code: 'const classes = `text-[0.625rem] ${active}`;', errors: [{ messageId: "small" }] },
    { code: 'const classes = "text-[length:10px]";', errors: [{ messageId: "small" }] },
    { code: 'const style = { fontSize: 11 };', errors: [{ messageId: "small" }] },
    { code: 'const style = { "fontSize": "0.5em" };', errors: [{ messageId: "small" }] },
    { code: 'const style = { fontSize: "8pt" };', errors: [{ messageId: "small" }] },
    { code: '<span className="text-[8pt]" />', errors: [{ messageId: "small" }] },
    { code: '<span className="text-[2mm]" />', errors: [{ messageId: "small" }] },
    { code: 'const css = `small { font-size: 10px; }`;', errors: [{ messageId: "small" }] },
  ],
});

const cssTester = new RuleTester({ plugins: { css }, language: "css/css", languageOptions: { tolerant: true } });
cssTester.run("minimum-text-size (CSS)", accessibility.rules["minimum-text-size"], {
  valid: ["p { font-size: 12px; }", "p { font-size: .75rem; }", "p { width: 10px; }"],
  invalid: [
    { code: "p { font-size: 11px; }", errors: [{ messageId: "small" }] },
    { code: "p { font-size: 8PT; }", errors: [{ messageId: "small" }] },
    { code: "p { font-size: 0.1in; }", errors: [{ messageId: "small" }] },
    { code: "p { @apply sm:text-[0.7rem]; }", errors: [{ messageId: "small" }] },
  ],
});
