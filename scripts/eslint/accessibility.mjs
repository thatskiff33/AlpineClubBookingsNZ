// Static sizes only: rem/em assume the normal 16px root. Dynamic sizes remain
// the responsibility of browser checks and design review.
const MINIMUM_TEXT_SIZE_PX = 12;

const UNIT_PIXELS = { px: 1, rem: 16, em: 16, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
const SIZE_PATTERN = `(\\d*\\.?\\d+)(${Object.keys(UNIT_PIXELS).join("|")})`;
function pixels(value, unit) {
  return Number(value) * UNIT_PIXELS[unit.toLowerCase()];
}

const minimumTextSize = {
  meta: {
    type: "problem",
    schema: [],
    messages: { small: `Text must be at least ${MINIMUM_TEXT_SIZE_PX}px. Use text-xs or a larger font size (#4466).` },
  },
  create(context) {
    function checkText(node, text) {
      const patterns = [
        new RegExp(`\\btext-\\[(?:length:)?${SIZE_PATTERN}(?:/[^\\]]+)?\\]`, "gi"),
        new RegExp(`font-size\\s*:\\s*${SIZE_PATTERN}\\b`, "gi"),
      ];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          if (pixels(match[1], match[2]) < MINIMUM_TEXT_SIZE_PX) context.report({ node, messageId: "small" });
        }
      }
    }
    if (context.sourceCode.ast.type === "StyleSheet") {
      return {
        Declaration(node) { checkText(node, context.sourceCode.getText(node)); },
        Atrule(node) {
          if (node.name === "apply") checkText(node, context.sourceCode.getText(node));
        },
      };
    }
    return {
      Literal(node) {
        if (typeof node.value === "string") checkText(node, node.value);
      },
      TemplateElement(node) { checkText(node, node.value.raw); },
      Property(node) {
        if ((node.key.name ?? node.key.value) !== "fontSize") return;
        const value = node.value.value;
        const match = typeof value === "string" && new RegExp(`^${SIZE_PATTERN}$`, "i").exec(value);
        if ((typeof value === "number" && value < MINIMUM_TEXT_SIZE_PX) || (match && pixels(match[1], match[2]) < MINIMUM_TEXT_SIZE_PX)) {
          context.report({ node: node.value, messageId: "small" });
        }
      },
    };
  },
};

const accessibility = { rules: { "minimum-text-size": minimumTextSize } };
export default accessibility;
