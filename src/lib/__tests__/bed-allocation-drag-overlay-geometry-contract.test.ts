import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
  #2595 contract test — the one invariant the board's `DragOverlay` must never
  break, because breaking it moves a guest to the wrong bed.

  `DndContext` resolves the drop with `closestCenter`, and the rect it centres is
  NOT the dragged chip's. When a `DragOverlay` is rendered, @dnd-kit/core uses the
  overlay's own measured child instead — `draggingNodeRect = dragOverlay.rect ??
  activeNodeRect` — and keeps re-measuring that child through a `ResizeObserver`
  for as long as the drag is live (`useDragOverlayMeasuring`). `getMeasurableNode`
  picks the overlay frame's single element child.

  So if the readable feedback card were that child, its own height would decide
  where the drop lands: the card grows the instant `activeDropPreview` appears,
  its centre sinks below the cell under the cursor, and the reviewed-move dialog
  opens for the bed one ROW BELOW the one the card had just named. That was
  measured, not theorised — chip 104.6px, card 138px, cell 57px, leaving 3px of
  margin on Windows and none on the hosted Linux runner, where the drop landed on
  A3 while the spec aimed at A2 on all three attempts of run 31196057937.

  The fix keeps the measured child a frame that FILLS the overlay — `DragOverlay`
  sizes the overlay from the dragged chip's rect — and takes the card out of flow
  inside it. Collisions then follow the chip and the preview copy may be any
  length. `e2e/bed-allocation.spec.ts` proves the resulting drop end to end, but
  only in whatever font metrics the runner happens to have; this asserts the
  structure the arithmetic depends on, in every environment.
*/

const PAGE = join(
  process.cwd(),
  "src",
  "app",
  "(admin)",
  "admin",
  "booking-desk",
  "bed-allocation",
  "page.tsx",
);

const FEEDBACK_TEST_ID = "bed-allocation-drag-feedback";

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function tagNameOf(node: JsxNode): string {
  const tag =
    ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText(source);
}

function attributesOf(node: JsxNode): ts.JsxAttributes {
  return ts.isJsxElement(node)
    ? node.openingElement.attributes
    : node.attributes;
}

/** The literal text of a string-valued JSX attribute, or null. */
function stringAttribute(node: JsxNode, name: string): string | null {
  for (const attribute of attributesOf(node).properties) {
    if (!ts.isJsxAttribute(attribute)) continue;
    if (attribute.name.getText(source) !== name) continue;
    const value = attribute.initializer;
    if (!value) return null;
    if (ts.isStringLiteral(value)) return value.text;
    if (
      ts.isJsxExpression(value) &&
      value.expression &&
      ts.isStringLiteral(value.expression)
    ) {
      return value.expression.text;
    }
    return null;
  }
  return null;
}

const fileText = readFileSync(PAGE, "utf8");
const source = ts.createSourceFile(
  PAGE,
  fileText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

/** The JSX element chain from `<DragOverlay>` down to the feedback card. */
function findChainToFeedbackCard(): JsxNode[] {
  let found: JsxNode[] | null = null;

  const walk = (node: ts.Node, chain: JsxNode[]) => {
    if (found) return;
    let nextChain = chain;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const inOverlay = chain.length > 0 || tagNameOf(node) === "DragOverlay";
      if (inOverlay) {
        nextChain = [...chain, node];
        if (stringAttribute(node, "data-testid") === FEEDBACK_TEST_ID) {
          found = nextChain;
          return;
        }
      }
    }
    node.forEachChild((child) => walk(child, nextChain));
  };

  walk(source, []);
  return found ?? [];
}

describe("bed-allocation DragOverlay collision geometry", () => {
  const chain = findChainToFeedbackCard();

  it("renders the feedback card inside the DragOverlay", () => {
    expect(
      chain.length,
      `no <DragOverlay> descendant carries data-testid="${FEEDBACK_TEST_ID}" in ${PAGE}`,
    ).toBeGreaterThan(0);
    expect(tagNameOf(chain[0]!)).toBe("DragOverlay");
  });

  it("keeps the overlay's measured child a frame that fills the dragged chip", () => {
    // Exactly one element between the overlay and the card: the frame dnd-kit
    // measures. Add another wrapper and getMeasurableNode() measures THAT, so
    // whichever element is second here is the one deciding drop targets.
    expect(
      chain.map((node) => tagNameOf(node)),
      "DragOverlay > frame > card — any extra nesting changes which element dnd-kit measures",
    ).toEqual(["DragOverlay", "div", "div"]);

    const frameClasses = (stringAttribute(chain[1]!, "className") ?? "").split(
      /\s+/,
    );
    expect(
      frameClasses,
      "the measured frame must fill the overlay, which DragOverlay sizes from the dragged chip",
    ).toContain("h-full");
    expect(frameClasses).toContain("w-full");
  });

  it("keeps the feedback card out of the measured frame's flow", () => {
    const cardClasses = (stringAttribute(chain[2]!, "className") ?? "").split(
      /\s+/,
    );
    expect(
      cardClasses,
      "an in-flow card grows the measured frame and drags the drop target down with it",
    ).toContain("absolute");
    expect(cardClasses).not.toContain("h-full");
  });
});
