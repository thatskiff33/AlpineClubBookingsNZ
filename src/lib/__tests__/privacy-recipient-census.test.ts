import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { INTEGRATION_CREDENTIAL_NAMESPACES } from "@/lib/integration-credential-namespaces";
import {
  CREDENTIAL_RECIPIENTS,
  NON_RECIPIENT_HTTPS_HOSTS,
  PRIVACY_RECIPIENTS,
} from "@/lib/privacy-recipient-classification";

const root = process.cwd();

/** Parse strings and template fragments, rather than treating comments as code. */
function outboundHosts(source: string, filename = "source.ts"): Set<string> {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const hosts = new Set<string>();
  function collect(text: string) {
    for (const match of text.matchAll(/https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?=[:/\s"'<>)}?]|$)/gi)) {
      hosts.add(match[1].toLowerCase());
    }
  }
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) collect(node.text);
    if (ts.isTemplateExpression(node)) {
      collect(node.head.text);
      for (const span of node.templateSpans) collect(span.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return hosts;
}

function serverFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__" || entry.name === "test") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return serverFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) return [];
    if (entry.name === "privacy-recipient-classification.ts") return [];
    const source = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    if (file.statements.some((statement) => ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression) && statement.expression.text === "use client")) return [];
    return [path];
  });
}

function recipientRows(): string[] {
  return Object.entries(PRIVACY_RECIPIENTS).map(([id, entry]) => {
    const namespaces = Object.entries(CREDENTIAL_RECIPIENTS)
      .filter(([, recipient]) => recipient === id).map(([namespace]) => `\`${namespace}\``).join(", ") || "None";
    return `| ${id} | [${entry.name}](${entry.privacyUrl}) | ${namespaces} | ${entry.dataSent} | ${entry.enablement} | ${entry.processing} | ${entry.memberFacing ? "Yes" : "No"} |`;
  });
}

describe("privacy recipient register census", () => {
  it("classifies every compiler-held credential namespace exactly once", () => {
    expect(Object.keys(CREDENTIAL_RECIPIENTS).sort()).toEqual([...INTEGRATION_CREDENTIAL_NAMESPACES].sort());
    for (const recipient of Object.values(CREDENTIAL_RECIPIENTS)) expect(PRIVACY_RECIPIENTS).toHaveProperty(recipient);
  });

  it("keeps the documented recipient rows equal to the code register", () => {
    const document = readFileSync(join(root, "docs/PRIVACY_RECIPIENTS.md"), "utf8");
    const rows = document.split("\n").filter((line) => /^\| [a-z][a-z-]* \|/.test(line));
    expect(rows).toEqual(recipientRows());
  });

  it("keeps the security credential list equal to the typed namespace tuple", () => {
    const document = readFileSync(join(root, "docs/SECURITY-ATTACK-SURFACE.md"), "utf8");
    const list = document.split("### The provider list, and the one place it lives (#2720)")[1]?.split("\n### ")[0];
    expect(list).toBeDefined();
    const namespaces = [...list!.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]);
    expect(namespaces.sort()).toEqual([...INTEGRATION_CREDENTIAL_NAMESPACES].sort());
  });

  it("classifies literal HTTPS hosts in every server-capable source file", () => {
    const registered = new Set<string>(Object.values(PRIVACY_RECIPIENTS).flatMap((entry) => [...entry.hosts]));
    const exceptions = new Set<string>(Object.keys(NON_RECIPIENT_HTTPS_HOSTS));
    for (const [host, reason] of Object.entries(NON_RECIPIENT_HTTPS_HOSTS)) {
      expect(reason.trim(), host).not.toBe("");
      expect(registered.has(host), `${host} must have one classification`).toBe(false);
    }
    const files = serverFiles(join(root, "src"));
    expect(files.length).toBeGreaterThan(100);
    const unclassified: string[] = [];
    for (const path of files) {
      for (const host of outboundHosts(readFileSync(path, "utf8"), path)) {
        if (!registered.has(host) && !exceptions.has(host)) unclassified.push(`${relative(root, path)}: ${host}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("sees a new outbound host, including template URLs, and ignores prose comments", () => {
    expect([...outboundHosts('fetch("https://new-recipient.invalid/send");')]).toEqual(["new-recipient.invalid"]);
    expect([...outboundHosts('fetch(`https://new-recipient.invalid/${id}`);')]).toEqual(["new-recipient.invalid"]);
    expect([...outboundHosts('// https://not-code.invalid\nconst url = "http://plain.invalid";')]).toEqual([]);
  });
});
