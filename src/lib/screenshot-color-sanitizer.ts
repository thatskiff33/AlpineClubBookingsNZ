const UNSUPPORTED_COLOR_FUNCTION_NAMES = [
  "color-mix",
  "oklch",
  "oklab",
  "lab",
  "lch",
  "color",
] as const;

const UNSUPPORTED_COLOR_FUNCTION_PATTERN = new RegExp(
  `\\b(?:${UNSUPPORTED_COLOR_FUNCTION_NAMES.join("|")})\\(`,
  "gi"
);

export function containsUnsupportedColorFunction(value: string) {
  UNSUPPORTED_COLOR_FUNCTION_PATTERN.lastIndex = 0;
  return UNSUPPORTED_COLOR_FUNCTION_PATTERN.test(value);
}

function findMatchingCloseParen(value: string, openParenIndex: number) {
  let depth = 0;

  for (let index = openParenIndex; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function substituteCssVariables(
  value: string,
  getCssVariableValue: (name: string) => string | null,
  seen = new Set<string>()
): string {
  let output = "";
  let searchFrom = 0;

  while (searchFrom < value.length) {
    const varIndex = value.indexOf("var(", searchFrom);
    if (varIndex === -1) {
      output += value.slice(searchFrom);
      break;
    }

    const openParenIndex = varIndex + "var".length;
    const closeParenIndex = findMatchingCloseParen(value, openParenIndex);
    if (closeParenIndex === -1) {
      output += value.slice(searchFrom);
      break;
    }

    output += value.slice(searchFrom, varIndex);

    const originalExpression = value.slice(varIndex, closeParenIndex + 1);
    const expressionBody = value.slice(openParenIndex + 1, closeParenIndex);
    let separatorIndex = -1;
    let depth = 0;

    for (let index = 0; index < expressionBody.length; index += 1) {
      const character = expressionBody[index];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      } else if (character === "," && depth === 0) {
        separatorIndex = index;
        break;
      }
    }

    const variableName =
      separatorIndex === -1
        ? expressionBody.trim()
        : expressionBody.slice(0, separatorIndex).trim();
    const fallbackValue =
      separatorIndex === -1
        ? null
        : expressionBody.slice(separatorIndex + 1).trim();

    if (!/^--[-_a-zA-Z0-9]+$/.test(variableName)) {
      output += originalExpression;
    } else if (seen.has(variableName)) {
      output += fallbackValue
        ? substituteCssVariables(fallbackValue, getCssVariableValue, seen)
        : originalExpression;
    } else {
      const variableValue = getCssVariableValue(variableName)?.trim();
      if (variableValue) {
        seen.add(variableName);
        output += substituteCssVariables(
          variableValue,
          getCssVariableValue,
          seen
        );
        seen.delete(variableName);
      } else if (fallbackValue) {
        seen.add(variableName);
        output += substituteCssVariables(
          fallbackValue,
          getCssVariableValue,
          seen
        );
        seen.delete(variableName);
      } else {
        output += originalExpression;
      }
    }

    searchFrom = closeParenIndex + 1;
  }

  return output;
}

export function normalizeUnsupportedColorFunctions(
  value: string,
  convertColor: (colorExpression: string) => string | null,
  getCssVariableValue: (name: string) => string | null = () => null
) {
  const valueWithVariables = substituteCssVariables(value, getCssVariableValue);
  if (!containsUnsupportedColorFunction(valueWithVariables)) {
    return valueWithVariables;
  }

  let output = "";
  let searchFrom = 0;
  let changed = false;

  UNSUPPORTED_COLOR_FUNCTION_PATTERN.lastIndex = 0;
  while (true) {
    UNSUPPORTED_COLOR_FUNCTION_PATTERN.lastIndex = searchFrom;
    const match = UNSUPPORTED_COLOR_FUNCTION_PATTERN.exec(valueWithVariables);
    if (!match) {
      output += valueWithVariables.slice(searchFrom);
      break;
    }

    const functionStart = match.index;
    const openParenIndex = functionStart + match[0].length - 1;
    const closeParenIndex = findMatchingCloseParen(
      valueWithVariables,
      openParenIndex
    );

    if (closeParenIndex === -1) {
      output += valueWithVariables.slice(searchFrom);
      break;
    }

    const colorExpression = valueWithVariables.slice(
      functionStart,
      closeParenIndex + 1
    );
    const convertedColor = convertColor(colorExpression);

    output += valueWithVariables.slice(searchFrom, functionStart);
    if (convertedColor) {
      output += convertedColor;
      changed = true;
    } else {
      output += colorExpression;
    }

    searchFrom = closeParenIndex + 1;
  }

  return changed ? output : valueWithVariables;
}
