import { readFileSync, existsSync } from "node:fs";
import ts from "typescript";

const SOURCES = [
  "src/app/api/admin/deletion-requests/[id]/route.ts",
  "src/lib/member-lifecycle-actions.ts",
];
const BANNED = ["callXeroApi","getAuthenticatedXeroClient","findOrCreateXeroContact","createXeroContactForMember","updateXeroContact","retryXeroWriteWithContactRepair","updateContact"];
function parse(p){return ts.createSourceFile(p, readFileSync(p,"utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);}
function specs(sf){const out=[];const walk=n=>{if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier))out.push(n.moduleSpecifier.text);n.forEachChild(walk);};walk(sf);return out;}
function resolve(spec, fromFile){
  if(spec.startsWith("@/")) { const base = "src/"+spec.slice(2); for(const e of [".ts",".tsx","/index.ts"]) if(existsSync(base+e)) return base+e; return null; }
  if(spec.startsWith("./")||spec.startsWith("../")){ const dir = fromFile.split("/").slice(0,-1).join("/"); const base = dir+"/"+spec.replace(/^\.\//,""); for(const e of [".ts",".tsx","/index.ts"]) if(existsSync(base+e)) return base+e; return null; }
  return null;
}
for(const src of SOURCES){
  const sf=parse(src);
  console.log("=== "+src);
  for(const s of new Set(specs(sf))){
    const r=resolve(s, src);
    if(!r) continue;
    const text=readFileSync(r,"utf8");
    const hits=[];
    if(/\benqueueXero\w+/.test(text)) hits.push(...new Set(text.match(/\benqueueXero\w+/g)));
    for(const b of BANNED) if(new RegExp("\b"+b+"\b").test(text)) hits.push(b);
    if(hits.length) console.log("  "+s+"  ->  "+[...new Set(hits)].join(", "));
  }
}
