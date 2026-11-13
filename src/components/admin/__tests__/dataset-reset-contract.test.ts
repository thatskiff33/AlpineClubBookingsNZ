import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

vi.setConfig({ testTimeout: 30_000 })

const INCLUDED_DATASETS = [
  ["Members", "src/app/(admin)/admin/members/_components/member-filter-toolbar.tsx"],
  ["Bookings", "src/components/admin/booking-filters.tsx"],
  ["Payments", "src/app/(admin)/admin/finance/payments/page.tsx"],
  ["Subscriptions", "src/app/(admin)/admin/finance/subscriptions/page.tsx"],
  ["Audit Log", "src/app/(admin)/admin/system/audit-log/page.tsx"],
  ["Reports", "src/app/(admin)/admin/finance/reports/page.tsx"],
  ["Refund Requests", "src/app/(admin)/admin/finance/refund-requests/page.tsx"],
  ["Waitlist", "src/app/(admin)/admin/booking-desk/waitlist/page.tsx"],
  ["Xero Operations", "src/app/(admin)/admin/finance/xero/_components/operations-panel.tsx"],
  ["Xero Inbound Events", "src/app/(admin)/admin/finance/xero/_components/inbound-events-panel.tsx"],
  ["Family Groups", "src/app/(admin)/admin/family-groups/page.tsx"],
  ["Issue Reports", "src/app/(admin)/admin/system/issue-reports/page.tsx"],
  ["Deletion Requests", "src/app/(admin)/admin/deletion-requests/deletion-requests-client.tsx"],
  ["Membership Cancellations", "src/app/(admin)/admin/membership-cancellations/page.tsx"],
  ["Member Applications", "src/app/(admin)/admin/member-applications/page.tsx"],
  ["Booking Request Approvals", "src/components/admin/booking-requests/booking-approvals-panel.tsx"],
  ["Booking Request Changes", "src/components/admin/booking-requests/booking-change-requests-panel.tsx"],
  ["Public Booking Requests", "src/components/admin/booking-requests/public-booking-requests-panel.tsx"],
  ["Induction Register", "src/components/admin/induction-register-table.tsx"],
  ["Promo Redemptions", "src/app/(admin)/admin/rules/promo-codes/promo-redemptions-panel.tsx"],
  ["Lockers", "src/app/(admin)/admin/lockers/page.tsx"],
  ["Finance Dashboard", "src/app/(finance)/finance/_components/finance-dashboard-client.tsx"],
] as const

function conditionalAncestor(node: ts.Node): ts.Node | null {
  let current = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isConditionalExpression(current) ||
      ts.isIfStatement(current) ||
      ts.isSwitchStatement(current) ||
      (ts.isBinaryExpression(current) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(current.operatorToken.kind))
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

function nearestResetRegion(node: ts.Node): ts.Node {
  let current = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current)
    ) {
      return current
    }
    current = current.parent
  }
  return node.getSourceFile()
}

function buttonLabelAncestor(node: ts.Node, region: ts.Node): ts.JsxElement | null {
  let current = node.parent
  while (current && current !== region.parent) {
    if (ts.isJsxElement(current)) {
      const tagName = current.openingElement.tagName.getText()
      if (tagName === "Button" || tagName === "button") return current
    }
    if (current === region) break
    current = current.parent
  }
  return null
}

function visibleString(node: ts.Node): string | null {
  if (ts.isJsxText(node)) return node.getText().trim()
  if (
    ts.isJsxExpression(node) &&
    node.expression &&
    (ts.isStringLiteral(node.expression) ||
      ts.isNoSubstitutionTemplateLiteral(node.expression))
  ) {
    return node.expression.text.trim()
  }
  return null
}

function inspectDatasetResetSource(source: string, relativePath = "synthetic.tsx") {
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const resetControls: ts.JsxSelfClosingElement[] = []

  function collectResetControls(node: ts.Node) {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === "DatasetResetButton"
    ) {
      resetControls.push(node)
    }
    ts.forEachChild(node, collectResetControls)
  }
  collectResetControls(sourceFile)

  const resetRegions = new Set(resetControls.map(nearestResetRegion))
  const legacyDatasetClearText = new Set<string>()
  for (const region of resetRegions) {
    function collectLegacyClear(node: ts.Node) {
      const text = visibleString(node)
      if (
        text &&
        /^Clear\b/.test(text) &&
        buttonLabelAncestor(node, region)
      ) {
        legacyDatasetClearText.add(text)
      }
      ts.forEachChild(node, collectLegacyClear)
    }
    collectLegacyClear(region)
  }

  return {
    resetControls,
    conditionalResetControls: resetControls.filter(conditionalAncestor),
    legacyDatasetClearText: [...legacyDatasetClearText],
  }
}

describe("admin dataset Reset inventory contract", () => {
  it("keeps the audited inventory explicit", () => {
    expect(INCLUDED_DATASETS).toHaveLength(22)
    expect(new Set(INCLUDED_DATASETS.map(([name]) => name)).size).toBe(22)
    expect(new Set(INCLUDED_DATASETS.map(([, path]) => path)).size).toBe(22)
  })

  it.each([
    "hidden && <DatasetResetButton disabled={false} onReset={() => undefined} />",
    "hidden || <DatasetResetButton disabled={false} onReset={() => undefined} />",
    "hidden ?? <DatasetResetButton disabled={false} onReset={() => undefined} />",
    "hidden ? null : <DatasetResetButton disabled={false} onReset={() => undefined} />",
  ])("detects a conditionally rendered Reset in %s", (expression) => {
    const inspection = inspectDatasetResetSource(
      `function Example() { return <div>{${expression}}</div> }`,
    )

    expect(inspection.resetControls).toHaveLength(1)
    expect(inspection.conditionalResetControls).toHaveLength(1)
  })

  it("detects expression-wrapped legacy dataset Clear labels", () => {
    const inspection = inspectDatasetResetSource(`
      function Example() {
        return <div><Button>{"Clear filters"}</Button><DatasetResetButton disabled={false} onReset={() => undefined} /></div>
      }
    `)

    expect(inspection.legacyDatasetClearText).toEqual(["Clear filters"])
  })

  it("ignores unrelated Clear actions outside the Reset control region", () => {
    const inspection = inspectDatasetResetSource(`
      function Example() {
        return <><section><Button>Clear cache</Button></section><div><DatasetResetButton disabled={false} onReset={() => undefined} /></div></>
      }
    `)

    expect(inspection.legacyDatasetClearText).toEqual([])
  })

  it.each(INCLUDED_DATASETS)(
    "%s always renders exactly one shared Reset control",
    (_name, relativePath) => {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8")
      const inspection = inspectDatasetResetSource(source, relativePath)

      expect(
        inspection.resetControls,
        `${relativePath} Reset count`,
      ).toHaveLength(1)
      expect(
        inspection.conditionalResetControls,
        `${relativePath} conditionally hides Reset`,
      ).toEqual([])
      expect(
        inspection.legacyDatasetClearText,
        `${relativePath} retains visible dataset Clear text`,
      ).toEqual([])
    },
  )
})
