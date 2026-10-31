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

const LINK = 'import Link from "next/link";\nimport { Button } from "@/components/ui/button";\n';
tester.run("no-nested-interactive", accessibility.rules["no-nested-interactive"], {
  valid: [
    `${LINK}const a = <Button asChild><Link href="/x">Go</Link></Button>;`,
    `${LINK}const a = <Button asChild={true} variant="outline"><a href="/x">Go</a></Button>;`,
    `${LINK}const a = <Link href="/x"><span>Go</span></Link>;`,
    `${LINK}const a = <div><Link href="/x">Go</Link><Button>Act</Button></div>;`,
    // A prop element is rendered wherever the receiver puts it, not here.
    `${LINK}const a = <Link href="/x" icon={<Button>Act</Button>}>Go</Link>;`,
    // Without the imports these are other components that happen to share a name.
    'import { Link } from "lucide-react";\nimport { Button } from "@/components/ui/button";\nconst a = <Button><Link /></Button>;',
    'import Button from "./fancy";\nconst a = <a href="/x"><Button>Go</Button></a>;',
  ],
  invalid: [
    { code: `${LINK}const a = <Link href="/x"><Button>Go</Button></Link>;`, errors: [{ messageId: "nested" }] },
    { code: `${LINK}const a = <Link href="/x">\n  {open && <Button variant="outline">Go</Button>}\n</Link>;`, errors: [{ messageId: "nested" }] },
    { code: `${LINK}const a = <Link href="/x"><span><button type="button">Go</button></span></Link>;`, errors: [{ messageId: "nested" }] },
    { code: `${LINK}const a = <a href="/x"><Button>Go</Button></a>;`, errors: [{ messageId: "nested" }] },
    { code: `${LINK}const a = <Button><Link href="/x">Go</Link></Button>;`, errors: [{ messageId: "nested" }] },
    { code: `${LINK}const a = <Button asChild={false}><Link href="/x">Go</Link></Button>;`, errors: [{ messageId: "nested" }] },
    // asChild that may be false at runtime renders a real <button> around the link.
    { code: `${LINK}const a = <Button asChild={isLink}><Link href="/x">Go</Link></Button>;`, errors: [{ messageId: "nested" }] },
    { code: `${LINK}const a = <button type="button"><a href="/x">Go</a></button>;`, errors: [{ messageId: "nested" }] },
    // asChild hands the Button's role to its child; a control inside that child still nests.
    { code: `${LINK}const a = <Button asChild><Link href="/x"><Button>Go</Button></Link></Button>;`, errors: [{ messageId: "nested" }] },
    { code: 'import NextLink from "next/link";\nimport { Button as UiButton } from "../ui/button";\nconst a = <NextLink href="/x"><UiButton>Go</UiButton></NextLink>;', errors: [{ messageId: "nested" }] },
  ],
});
