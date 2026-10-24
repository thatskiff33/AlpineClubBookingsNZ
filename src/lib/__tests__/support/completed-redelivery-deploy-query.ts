import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * #4285: the read-only deploy query in `docs/UPGRADING.md`, read from the doc
 * itself so the pin (`completed-redelivery-deploy-note.test.ts`) and the
 * real-PostgreSQL proof (`completed-redelivery.realdb.test.ts`) both test the
 * text an operator runs.
 */
export function completedRedeliveryDeployQuery(): string {
  const doc = readFileSync(resolve(__dirname, "../../../../docs/UPGRADING.md"), "utf8");
  const start = doc.indexOf("**Deploy query (#4285).**");
  if (start < 0) throw new Error("docs/UPGRADING.md lost its #4285 deploy query marker");
  const sql = /```sql\n([\s\S]*?)\n```/.exec(doc.slice(start))?.[1];
  if (!sql) throw new Error("docs/UPGRADING.md's #4285 deploy query has no sql block");
  return sql;
}
