import { readFileSync, existsSync, statSync } from "node:fs";
import ts from "typescript";

const SOURCES = [
  "src/app/api/admin/deletion-requests/[id]/route.ts",
  "src/lib/member-lifecycle-actions.ts",
];
const BANNED = [
  "callXeroApi",
  "getAuthenticatedXeroClient",
  "findOrCreateXeroContact",
  "createXeroContactForMember",
  "updateXeroContact",
  "retryXeroWriteWithContactRepair",
];

function specs(p) {
  const sf = ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const w = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) out.push(n.arguments[0].text);
    n.forEachChild(w);
  };
  w(sf);
  return out;
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function resolve(spec, from) {
  let base = null;
  if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
  else if (spec.startsWith(".")) {
    const dir = from.split("/").slice(0, -1).join("/");
    const parts = (dir + "/" + spec).split("/");
    const stack = [];
    for (const s of parts) {
      if (s === "." || s === "") continue;
      if (s === "..") { stack.pop(); continue; }
      stack.push(s);
    }
    base = stack.join("/");
  } else return null;
  for (const e of [".ts", ".tsx", "/index.ts", ""]) if (isFile(base + e)) return base + e;
  return null;
}

for (const src of SOURCES) {
  const seen = new Set();
  const q = [src];
  const reach = new Map();
  while (q.length) {
    const f = q.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    let txt;
    try { txt = readFileSync(f, "utf8"); } catch { continue; }
    const hits = new Set(txt.match(/enqueueXero[A-Za-z]+/g) || []);
    for (const b of BANNED) if (txt.includes(b + "(")) hits.add(b);
    if (hits.size && f !== src) reach.set(f, [...hits]);
    for (const s of specs(f)) { const r = resolve(s, f); if (r && !seen.has(r)) q.push(r); }
  }
  console.log("=== " + src + "  closure=" + seen.size + "  reachingXero=" + reach.size);
  for (const [f, h] of reach) console.log("   " + f + "  ->  " + h.slice(0, 3).join(", "));
}
