/*
  The raw Xero request and response of one operation, redacted by
  `formatJson`. Split out of `operations-panel.tsx` (#5134) so the panel stays
  inside its size budget.
*/

import { formatJson } from "./shared"
import type { XeroOperation } from "./types"

export function RawPayloads({ operation, className }: { operation: XeroOperation; className?: string }) {
  return (
    <div className={`grid gap-3 lg:grid-cols-2${className ? ` ${className}` : ""}`}>
      <div>
        <p className="mb-1 text-xs font-medium text-foreground">Request</p>
        <pre className="max-h-64 overflow-auto rounded border bg-background p-2 text-[11px]">{formatJson(operation.requestPayload)}</pre>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-foreground">Response</p>
        <pre className="max-h-64 overflow-auto rounded border bg-background p-2 text-[11px]">{formatJson(operation.responsePayload)}</pre>
      </div>
    </div>
  )
}
