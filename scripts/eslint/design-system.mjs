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
 * - `no-native-confirm`: a call to the browser's `confirm`, spelled
 *   `window.confirm(…)`, `globalThis.confirm(…)`, `self.confirm(…)` or a bare
 *   `confirm(…)` that resolves to the global. `const { confirm } = useConfirm()`
 *   and any other local or imported `confirm` is the sanctioned dialog and is
 *   not reported.
 *
 * Where the rules do not apply is decided in two places, both named:
 * - by path, in `eslint.config.mjs`: the primitives themselves
 *   (`src/components/ui/`), test files, and the files listed in
 *   `PRIMITIVE_IMPLEMENTATIONS` below for the one element each is built on;
 * - by element, here: `<input type="hidden">`, which is form data rather than a
 *   control, and a visually hidden `<input type="file">` (a literal `hidden`
 *   attribute, or a literal `className` with a `hidden` or `sr-only` token),
 *   which is the picker a `Button` opens. A visible file input is reported:
 *   `Input` takes `type="file"`.
 *
 * Not covered: `React.createElement("button")`, a `confirm` reached through an
 * alias (`const ask = window.confirm`), and `<textarea>`, which the issue did
 * not name.
 */

const ISSUE = "(#4467; docs/UX_FLOW_MAP.md -> design-system controls)";

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

function attribute(openingElement, name) {
  return openingElement.attributes.find(
    (candidate) => candidate.type === "JSXAttribute" && candidate.name.type === "JSXIdentifier" && candidate.name.name === name,
  );
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

function isVisuallyHidden(openingElement) {
  if (literalTrue(attribute(openingElement, "hidden"))) return true;
  const className = literalString(attribute(openingElement, "className"));
  return className !== null && className.split(/\s+/).some((token) => token === "hidden" || token === "sr-only");
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
  { raw: `Raw <button>: use Button from @/components/ui/button, with asChild to render a Link ${ISSUE}.` },
  () => "raw",
);

const noRawInput = rawElementRule(
  "input",
  {
    raw: `Raw <input>: use Input from @/components/ui/input (it takes type="file" too), or MoneyInput or SecretInput for money and secrets ${ISSUE}.`,
    checkbox: `Raw <input type="checkbox">: use Checkbox from @/components/ui/checkbox ${ISSUE}.`,
    radio: `Raw <input type="radio">: there is no radio primitive yet, so add one to src/components/ui/ and use it, rather than another raw input ${ISSUE}.`,
  },
  (node) => {
    const type = literalString(attribute(node, "type"));
    if (type === "hidden") return null;
    if (type === "file" && isVisuallyHidden(node)) return null;
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "raw";
  },
);

const noRawSelect = rawElementRule(
  "select",
  { raw: `Raw <select>: use Select with SelectTrigger, SelectValue, SelectContent and SelectItem from @/components/ui/select ${ISSUE}.` },
  () => "raw",
);

const noRawTable = rawElementRule(
  "table",
  { raw: `Raw <table>: use Table from @/components/ui/table, or AdminDataTable from @/components/admin/admin-data-table for an admin list ${ISSUE}.` },
  () => "raw",
);

const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);

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

function isConfirmProperty(member) {
  if (!member.computed) return member.property.type === "Identifier" && member.property.name === "confirm";
  return member.property.type === "Literal" && member.property.value === "confirm";
}

const noNativeConfirm = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      native: `The browser's confirm box: use useConfirm() from @/components/confirm-dialog and await confirm({ title, destructive }) ${ISSUE}.`,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier") {
          if (callee.name === "confirm" && !isLocallyBound(context, callee)) context.report({ node, messageId: "native" });
          return;
        }
        if (
          callee.type === "MemberExpression"
          && callee.object.type === "Identifier"
          && GLOBAL_OBJECTS.has(callee.object.name)
          && isConfirmProperty(callee)
        ) {
          context.report({ node, messageId: "native" });
        }
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
