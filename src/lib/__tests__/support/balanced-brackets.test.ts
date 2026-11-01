import { describe, expect, it } from "vitest";
import { balancedBrackets, expressionAt } from "./balanced-brackets";

describe("balancedBrackets", () => {
  it.each([
    ["(one({ nested: [two(3)] }), four)", ["one({ nested: [two(3)] })", "four"]],
    ["{ data: { value: 1 }, select: [2, 3] }", ["data: { value: 1 }", "select: [2, 3]"]],
    ["[first, [second, third]]", ["first", "[second, third]"]],
    ["()", []],
    ["(first, second,)", ["first", "second"]],
    ["(/* comment */)", []],
    ["(first, /* trailing comment */)", ["first"]],
    ['("", /* explanation */ second)', ['""', '/* explanation */ second']],
  ] as const)("reads %s without absorbing the next call", (text, parts) => {
    const prefix = "before ";
    expect(balancedBrackets(`${prefix}${text}; next()`, prefix.length)).toEqual({
      text,
      end: prefix.length + text.length - 1,
      parts: [...parts],
    });
  });

  it.each([
    '("),", next)',
    "('escaped\\\' ),', next)",
    '(first /* ), } ] */ , next)',
    '(first // ), } ]\n, next)',
    '(/[,)]/.test(value), next)',
    '(`text ), ${nested({ value: `inner ), ${call(1)}` })}`, next)',
  ])("ignores literal and comment brackets in %s", (text) => {
    const region = balancedBrackets(`${text}; unrelated()`, 0);
    expect(region.text).toBe(text);
    expect(region.end).toBe(text.length - 1);
    expect(region.parts).toHaveLength(2);
    expect(region.parts[1]).toBe("next");
  });

  it("accepts already masked structure without lexing a blanked regex again", () => {
    const source = "expect(message).toMatch(/owed \\(/); next()";
    const structure = "expect(message).toMatch(/        ); next()";
    const open = source.indexOf("(", source.indexOf("toMatch"));
    const region = balancedBrackets(source, open, structure);
    expect(region.text).toBe("(/owed \\(/)");
    expect(region.end).toBe(source.indexOf("; next") - 1);
  });

  it("preserves the original spacing and literal text", () => {
    expect(balancedBrackets('prefix(  "one,two", { label: ")" } )suffix', 6).parts)
      .toEqual(['"one,two"', '{ label: ")" }']);
  });

  it.each([-1, 1, 99])("refuses a non-opening offset %s", (start) => {
    expect(() => balancedBrackets("(value)", start)).toThrow("Expected opening bracket");
  });

  it("refuses a structure whose length differs from the source", () => {
    expect(() => balancedBrackets("(value)", 0, "(value")).toThrow("offset-preserving");
  });

  it("says a non-opening offset may be inside a comment or literal", () => {
    const source = "// a prior .booking.update( call\nreal()";
    expect(() => balancedBrackets(source, source.indexOf("("))).toThrow(
      "inside a comment or literal",
    );
  });

  it.each(["([)", "{]", "[(])"])("refuses mismatched brackets in %s", (source) => {
    expect(() => balancedBrackets(source, 0)).toThrow("Mismatched bracket");
  });

  it.each(["(nested(value)", "{ nested: {}", "[[]"])("refuses an unclosed region %s", (source) => {
    expect(() => balancedBrackets(source, 0)).toThrow("Unbalanced brackets");
  });
});

describe("expressionAt", () => {
  it.each([
    ["{ key: value, other: 2 }", " value", ","],
    ["{ key: value }", " value ", "}"],
    ["f({ key: a ? b : c })", " a ? b : c ", "}"],
    ["{ key: build(a, b), not: x }", " build(a, b)", ","],
    ["{ key: [1, 2], z }", " [1, 2]", ","],
    ["{ key: c ? \"a,b)\" : 'x' } rest", " c ? \"a,b)\" : 'x' ", "}"],
    ["{ key: `p:${id}:` , z }", " `p:${id}:` ", ","],
    ["{ key: /* ) , */ v }", " /* ) , */ v ", "}"],
  ] as const)("reads the value of %s", (source, text, terminator) => {
    const read = expressionAt(source, source.indexOf(":") + 1);
    expect(read.text).toBe(text);
    expect(source[read.end]).toBe(terminator);
  });

  it("runs to the end of the source when nothing terminates it", () => {
    expect(expressionAt("key: value", 4)).toEqual({ text: " value", end: 10 });
  });

  it("refuses an expression that opens a bracket it never closes", () => {
    expect(() => expressionAt("{ key: f(a, b }", 6)).toThrow("Mismatched bracket");
    expect(() => expressionAt("key: f(a, b", 4)).toThrow("Unbalanced brackets");
  });

  it("refuses a structure whose length differs from the source", () => {
    expect(() => expressionAt("key: value", 4, "key: val")).toThrow("offset-preserving");
  });
});
