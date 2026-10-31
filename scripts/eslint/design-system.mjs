/**
 * `design-system/*` (#4467 item 2): raw form controls and the browser's own
 * confirm box, outside the design-system primitives.
 *
 * Five rules, one per thing banned, so `eslint-suppressions.json` records each
 * one's count per file and the ratchet holds each count on its own: a file that
 * trades a raw `<select>` for a raw `<button>` still fails.
 *
 * - `no-raw-button`, `no-raw-input`, `no-raw-select`, `no-raw-table`: the
 *   intrinsic JSX element (`<button>`, not `<Button>` or `<ui.button>`).
 * - `no-native-confirm`: the browser's `confirm`, called through `window`,
 *   `globalThis`, `self`, `top` or `parent` (dotted, bracketed, as
 *   `(0, window.confirm)(…)` or via `.call`/`.apply`), destructured from one of
 *   them (`const { confirm } = window`), or called bare when the name resolves
 *   to the global. `const { confirm } = useConfirm()` and any other local,
 *   imported or parameter `confirm` is the sanctioned dialog and is not
 *   reported.
 *
 * Which files the rules apply to is decided in `eslint.config.mjs`, with
 * `PRIMITIVE_IMPLEMENTATIONS` below for the named primitive files. The element
 * exceptions are decided here: `<input type="hidden">`, which is form data
 * rather than a control, and a visually hidden `<input type="file">` (a literal
 * `hidden` attribute, or a literal `className` with an unprefixed `hidden` or
 * `sr-only` token), which is the picker a `Button` opens. Neither exception
 * holds when a JSX spread comes after an attribute it relies on, or when a class
 * token could show the input again (`block`, `md:flex`, `focus:not-sr-only`…).
 * A visible file input is reported: `Input` takes `type="file"`.
 *
 * An inline disable comment is never the answer: migrate to the primitive.
 * `design-system.test.mjs` fails on any disable comment naming these rules.
 *
 * Not covered: `React.createElement("button")`, an element named through a
 * variable (`const Tag = "button"; <Tag />`), a `confirm` reached through an
 * alias (`const ask = window.confirm`), and `<textarea>`, which the issue did
 * not name.
 */

const ISSUE = "Never an eslint-disable comment: migrate to the primitive (#4467; docs/UX_FLOW_MAP.md -> design-system controls).";

/**
 * Files outside `src/components/ui/` that ARE a design-system primitive, with
 * the one rule each may break and why. `eslint.config.mjs` switches exactly
 * that rule off for exactly that file. Add an entry only for a shared primitive
 * that the docs name as one; a page or feature component migrates instead.
 */
export const PRIMITIVE_IMPLEMENTATIONS = [
  {
    file: "src/components/admin/admin-data-table.tsx",
    rule: "no-raw-table",
    reason: "The #1805 admin table shell. It supplies its own sticky scroll container, which Table's overflow wrapper would sit inside and break.",
  },
  {
    file: "src/components/admin/sort-header.tsx",
    rule: "no-raw-button",
    reason: "The #1805 sort header. Its callback-mode control is the column label styled exactly like its URL-mode Link, not a Button.",
  },
];

/** The attribute JSX applies: the last one of that name, as React does. */
function attribute(openingElement, name) {
  return openingElement.attributes.findLast(
    (candidate) => candidate.type === "JSXAttribute" && candidate.name.type === "JSXIdentifier" && candidate.name.name === name,
  );
}

/** Whether a `{...spread}` comes after `attr`, so it may override it at runtime. */
function overriddenBySpread(openingElement, attr) {
  const index = openingElement.attributes.indexOf(attr);
  return openingElement.attributes.slice(index + 1).some((candidate) => candidate.type === "JSXSpreadAttribute");
}

/** The attribute's value when it is a string literal, written `a="x"` or `a={"x"}`; otherwise null. */
function literalString(attr) {
  if (!attr || attr.value === null) return null;
  const value = attr.value.type === "JSXExpressionContainer" ? attr.value.expression : attr.value;
  return value.type === "Literal" && typeof value.value === "string" ? value.value : null;
}

/** A bare `hidden` or `hidden={true}`. */
function literalTrue(attr) {
  if (!attr) return false;
  if (attr.value === null) return true;
  const value = attr.value.type === "JSXExpressionContainer" ? attr.value.expression : attr.value;
  return value.type === "Literal" && value.value === true;
}

// Utilities that set `display` to something visible, and the one that undoes
// `sr-only`. With any variant prefix (`md:`, `focus:`) they can show the input
// again in that state, so their presence ends the exemption.
const SHOWING_UTILITIES = new Set([
  "block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid",
  "contents", "flow-root", "list-item", "table", "inline-table", "table-caption",
  "table-cell", "table-column", "table-column-group", "table-footer-group",
  "table-header-group", "table-row", "table-row-group", "not-sr-only",
]);

/** A class token's utility, without its variant prefixes and important marks. */
function utility(token) {
  // Variants are separated by `:` outside brackets; an arbitrary value such as
  // `[display:block]` keeps its own colon.
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === "[") depth += 1;
    else if (token[i] === "]") depth -= 1;
    else if (token[i] === ":" && depth === 0) start = i + 1;
  }
  return token.slice(start).replace(/^!|!$/g, "");
}

function canShow(token) {
  const base = utility(token);
  return SHOWING_UTILITIES.has(base) || /^\[display:/.test(base);
}

/** Whether literal classes hide the input, with no token that could show it again. */
function hidingClasses(className) {
  const tokens = className.split(/\s+/).filter(Boolean);
  if (tokens.some(canShow)) return false;
  return tokens.some((token) => token === "hidden" || token === "sr-only");
}

function isVisuallyHidden(openingElement) {
  const classAttr = attribute(openingElement, "className");
  const hiddenAttr = attribute(openingElement, "hidden");
  if (classAttr && overriddenBySpread(openingElement, classAttr)) return false;
  const className = classAttr ? literalString(classAttr) : "";
  // A class decided at runtime may show the input whatever else is set.
  if (className === null) return false;
  if (literalTrue(hiddenAttr) && !overriddenBySpread(openingElement, hiddenAttr)) {
    return !className.split(/\s+/).filter(Boolean).some(canShow);
  }
  return classAttr !== undefined && hidingClasses(className);
}

function rawElementRule(element, messages, pick) {
  return {
    meta: { type: "suggestion", schema: [], messages },
    create(context) {
      return {
        JSXOpeningElement(node) {
          if (node.name.type !== "JSXIdentifier" || node.name.name !== element) return;
          const messageId = pick(node);
          if (messageId) context.report({ node, messageId });
        },
      };
    },
  };
}

const noRawButton = rawElementRule(
  "button",
  { raw: `Raw <button>: use Button from @/components/ui/button, with asChild to render a Link. ${ISSUE}` },
  () => "raw",
);

const noRawInput = rawElementRule(
  "input",
  {
    raw: `Raw <input>: use Input from @/components/ui/input (it takes type="file" too), or MoneyInput or SecretInput for money and secrets. ${ISSUE}`,
    checkbox: `Raw <input type="checkbox">: use Checkbox from @/components/ui/checkbox. ${ISSUE}`,
    radio: `Raw <input type="radio">: there is no radio primitive yet, so add one to src/components/ui/ and use it, rather than another raw input. ${ISSUE}`,
  },
  (node) => {
    const typeAttr = attribute(node, "type");
    // A spread after `type` may replace it, so the literal is not the answer.
    const type = typeAttr && !overriddenBySpread(node, typeAttr) ? literalString(typeAttr) : null;
    if (type === "hidden") return null;
    if (type === "file" && isVisuallyHidden(node)) return null;
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "raw";
  },
);

const noRawSelect = rawElementRule(
  "select",
  { raw: `Raw <select>: use Select with SelectTrigger, SelectValue, SelectContent and SelectItem from @/components/ui/select. ${ISSUE}` },
  () => "raw",
);

const noRawTable = rawElementRule(
  "table",
  { raw: `Raw <table>: use Table from @/components/ui/table, or AdminDataTable from @/components/admin/admin-data-table for an admin list. ${ISSUE}` },
  () => "raw",
);

const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "top", "parent"]);

/** Whether `confirm` at this identifier is declared anywhere above the global scope. */
function isLocallyBound(context, identifier) {
  for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (!variable) continue;
    // A configured browser global has no definition; a top-level declaration
    // in a script does.
    return scope.type !== "global" || variable.defs.length > 0;
  }
  return false;
}

/** A property key that is `confirm`: `.confirm`, `["confirm"]` or `` [`confirm`] ``. */
function isConfirmKey(key, computed) {
  if (!computed) return key.type === "Identifier" && key.name === "confirm";
  if (key.type === "Literal") return key.value === "confirm";
  return key.type === "TemplateLiteral" && key.expressions.length === 0 && key.quasis[0].value.cooked === "confirm";
}

/** `window.confirm` and its spellings, after `(0, …)`, `?.`, `!` and `as` wrappers. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (current.type === "SequenceExpression") current = current.expressions.at(-1);
    else if (current.type === "ChainExpression" || current.type === "TSNonNullExpression" || current.type === "TSAsExpression") current = current.expression;
    else return current;
  }
}

function isGlobalConfirm(node) {
  const member = unwrap(node);
  return member.type === "MemberExpression"
    && member.object.type === "Identifier"
    && GLOBAL_OBJECTS.has(member.object.name)
    && isConfirmKey(member.property, member.computed);
}

const noNativeConfirm = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      native: `The browser's confirm box: use useConfirm() from @/components/confirm-dialog and await confirm({ title, destructive }). ${ISSUE}`,
    },
  },
  create(context) {
    function reportDestructure(pattern, source) {
      if (pattern.type !== "ObjectPattern" || !source) return;
      const object = unwrap(source);
      if (object.type !== "Identifier" || !GLOBAL_OBJECTS.has(object.name)) return;
      for (const property of pattern.properties) {
        if (property.type === "Property" && isConfirmKey(property.key, property.computed)) {
          context.report({ node: property, messageId: "native" });
        }
      }
    }
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type === "Identifier") {
          if (callee.name === "confirm" && !isLocallyBound(context, callee)) context.report({ node, messageId: "native" });
          return;
        }
        if (isGlobalConfirm(callee)) {
          context.report({ node, messageId: "native" });
          return;
        }
        // `window.confirm.call(window, …)` and `.apply(…)`.
        if (
          callee.type === "MemberExpression"
          && !callee.computed
          && callee.property.type === "Identifier"
          && (callee.property.name === "call" || callee.property.name === "apply")
          && isGlobalConfirm(callee.object)
        ) {
          context.report({ node, messageId: "native" });
        }
      },
      VariableDeclarator(node) {
        reportDestructure(node.id, node.init);
      },
      AssignmentExpression(node) {
        reportDestructure(node.left, node.right);
      },
    };
  },
};

const designSystem = {
  rules: {
    "no-raw-button": noRawButton,
    "no-raw-input": noRawInput,
    "no-raw-select": noRawSelect,
    "no-raw-table": noRawTable,
    "no-native-confirm": noNativeConfirm,
  },
};

export default designSystem;
