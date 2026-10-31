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

// #4553 — axe `nested-interactive`: a link or button inside another link or
// button. `<Link><Button>…</Button></Link>` renders `<a><button>…</button></a>`,
// two tab stops for one action and an invalid content model. The fix is
// `<Button asChild><Link>…</Link></Button>`: the Button's Slot renders no element
// of its own, so it is not an interactive ancestor. Link and Button are matched
// by import (next/link's default export, the ui `Button`), so an unrelated
// `Link` such as an icon is not mistaken for one.
const INTRINSIC_INTERACTIVE = new Set(["a", "button"]);

function isTruthyAttribute(attribute) {
  if (attribute.value === null) return true;
  const expression = attribute.value.type === "JSXExpressionContainer" ? attribute.value.expression : attribute.value;
  return !(expression.type === "Literal" && expression.value === false);
}

const noNestedInteractive = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      nested: "<{{inner}}> sits inside <{{outer}}>: interactive controls must not nest (axe nested-interactive). Use <Button asChild><Link>…</Link></Button> (#4553).",
    },
  },
  create(context) {
    const linkNames = new Set();
    const buttonNames = new Set();

    function kind(openingElement) {
      if (openingElement.name.type !== "JSXIdentifier") return null;
      const name = openingElement.name.name;
      if (INTRINSIC_INTERACTIVE.has(name)) return "intrinsic";
      if (linkNames.has(name)) return "link";
      if (buttonNames.has(name)) return "button";
      return null;
    }

    function rendersNoElement(openingElement) {
      return kind(openingElement) === "button" && openingElement.attributes.some(
        (attribute) => attribute.type === "JSXAttribute" && attribute.name.name === "asChild" && isTruthyAttribute(attribute),
      );
    }

    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        for (const specifier of node.specifiers) {
          if (source === "next/link" && specifier.type === "ImportDefaultSpecifier") linkNames.add(specifier.local.name);
          if (/(^|\/)ui\/button$|^\.\/button$/.test(source) && specifier.type === "ImportSpecifier"
            && (specifier.imported.name ?? specifier.imported.value) === "Button") buttonNames.add(specifier.local.name);
        }
      },
      JSXElement(node) {
        if (!kind(node.openingElement)) return;
        for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
          // An element passed as a prop is rendered wherever the receiver puts it.
          if (parent.type === "JSXAttribute") return;
          if (parent.type !== "JSXElement" || child === parent.openingElement) continue;
          if (!kind(parent.openingElement) || rendersNoElement(parent.openingElement)) continue;
          context.report({
            node: node.openingElement,
            messageId: "nested",
            data: { inner: context.sourceCode.getText(node.openingElement.name), outer: context.sourceCode.getText(parent.openingElement.name) },
          });
          return;
        }
      },
    };
  },
};

const accessibility = { rules: { "minimum-text-size": minimumTextSize, "no-nested-interactive": noNestedInteractive } };
export default accessibility;
