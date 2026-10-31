// @vitest-environment jsdom

// #4467 item 3: the shared form layer. What these tests pin is the part a
// screen reader depends on and a sighted test would never notice: which
// element is described by what, in which order, and where focus goes when a
// submit fails — and where it does NOT go while the person is typing.

import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormErrorSummary,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  collectFormErrors,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useZodForm } from "@/hooks/use-zod-form";
import { applyServerValidationErrors } from "@/lib/forms/server-validation-errors";
import {
  expectToHoldFocus,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "@/lib/__tests__/helpers/focus";

const schema = z.object({
  name: z.string().trim().min(1, "Enter a name"),
  email: z.string().trim().email("Enter an email address"),
  agree: z.boolean().refine((value) => value, "Tick to agree"),
});
type Values = z.input<typeof schema>;

function TestForm({
  onValid = async () => {},
  serverBody,
  withHint = true,
  extraDescribedBy,
}: {
  onValid?: (values: z.output<typeof schema>) => Promise<void>;
  serverBody?: unknown;
  withHint?: boolean;
  extraDescribedBy?: string;
}) {
  const form = useZodForm(schema, {
    defaultValues: { name: "", email: "", agree: false } satisfies Values,
  });
  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit(async (values) => {
          await onValid(values);
          if (serverBody !== undefined) applyServerValidationErrors(form, 400, serverBody);
        })}
      >
        <FormErrorSummary />
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl aria-describedby={extraDescribedBy}>
                <Input {...field} />
              </FormControl>
              <FormMessage />
              {withHint ? <FormDescription>Example: Ruth</FormDescription> : null}
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input {...field} type="email" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="agree"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Checkbox
                  ref={field.ref}
                  name={field.name}
                  checked={field.value}
                  onBlur={field.onBlur}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <FormLabel>I agree</FormLabel>
              <FormMessage />
            </FormItem>
          )}
        />
        <button type="submit">Save</button>
      </form>
    </Form>
  );
}

function describedByIds(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  });
}

beforeEach(() => {
  installScrollIntoViewSpy();
});

afterEach(() => {
  cleanup();
  removeScrollIntoViewSpy();
});

describe("form primitives: the control's accessible wiring", () => {
  it("labels the control and is described by the hint only, while valid", async () => {
    render(<TestForm />);

    const name = screen.getByLabelText("Name");
    expect(name).toHaveAttribute("aria-invalid", "false");
    // The hint registers itself in a layout effect; wait for the commit it causes.
    await waitFor(() => expect(describedByIds(name)).toHaveLength(1));
    expect(document.getElementById(describedByIds(name)[0]!)).toHaveTextContent(
      "Example: Ruth",
    );
  });

  it("names no description that is not rendered", () => {
    render(<TestForm withHint={false} />);

    // axe fails an aria-describedby whose ids resolve to nothing; a field with
    // no hint and no error must carry no attribute at all.
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-describedby");
    expect(screen.getByLabelText("Email")).not.toHaveAttribute("aria-describedby");
  });

  it("marks a failed field invalid and announces its error BEFORE its hint", async () => {
    render(<TestForm extraDescribedBy="view-only-reason" />);
    await submit();

    const name = screen.getByLabelText("Name");
    expect(name).toHaveAttribute("aria-invalid", "true");
    const ids = describedByIds(name);
    // Error, then a caller's own description, then the example (#2257's order).
    expect(ids).toHaveLength(3);
    expect(document.getElementById(ids[0]!)).toHaveTextContent("Enter a name");
    expect(ids[1]).toBe("view-only-reason");
    expect(document.getElementById(ids[2]!)).toHaveTextContent("Example: Ruth");
    expect(screen.getByText("I agree")).toHaveAttribute(
      "for",
      screen.getByRole("checkbox").id,
    );
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-invalid", "true");
  });

  it("clears the invalid state as the field is fixed", async () => {
    render(<TestForm />);
    await submit();

    const name = screen.getByLabelText("Name");
    await act(async () => {
      fireEvent.change(name, { target: { value: "Ruth" } });
    });

    expect(name).toHaveAttribute("aria-invalid", "false");
    expect(describedByIds(name)).toHaveLength(1);
    expect(screen.queryByText("Enter a name")).toBeNull();
  });
});

describe("FormErrorSummary", () => {
  it("is not rendered before a submit", () => {
    render(<TestForm />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists every error as a link to its control and takes focus on a failed submit", async () => {
    render(<TestForm />);
    await submit();

    const summary = screen.getByRole("alert");
    expect(summary).toHaveAccessibleName("There is a problem");
    const links = Array.from(summary.querySelectorAll("a"));
    expect(links.map((link) => link.textContent)).toEqual([
      "Enter a name",
      "Enter an email address",
      "Tick to agree",
    ]);
    expect(links[0]).toHaveAttribute("href", `#${screen.getByLabelText("Name").id}`);
    expect(links[2]).toHaveAttribute("href", `#${screen.getByRole("checkbox").id}`);

    // Holds focus across settled turns: react-hook-form's own focus-the-first-
    // error runs again on a timer, and `useZodForm` must keep it off.
    await expectToHoldFocus(summary, "the error summary");
  });

  it("moves focus to the field a link names", async () => {
    render(<TestForm />);
    await submit();

    fireEvent.click(screen.getByRole("link", { name: "Enter an email address" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Email"));
  });

  it("never moves focus while the person types, and only shrinks between submits", async () => {
    render(<TestForm />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ruth" } });
    });
    await submit();
    await expectToHoldFocus(screen.getByRole("alert"), "the error summary");
    const listed = () =>
      Array.from(screen.queryByRole("alert")?.querySelectorAll("a") ?? []).map(
        (link) => link.textContent,
      );
    expect(listed()).toEqual(["Enter an email address", "Tick to agree"]);

    const email = screen.getByLabelText("Email");
    email.focus();
    await act(async () => {
      fireEvent.change(email, { target: { value: "ruth@example.org" } });
    });
    expect(listed()).toEqual(["Tick to agree"]);

    // A field that was valid at the submit and breaks while typing shows its
    // inline error and waits for the next submit to join the summary.
    const name = screen.getByLabelText("Name");
    name.focus();
    await act(async () => {
      fireEvent.change(name, { target: { value: "" } });
    });
    expect(screen.getByText("Enter a name")).toBeInTheDocument();
    expect(listed()).toEqual(["Tick to agree"]);

    // Fix the last listed field: the summary goes. Break a fixed one again:
    // it does not come back, so nothing is announced mid-typing.
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox"));
    });
    email.focus();
    await act(async () => {
      fireEvent.change(email, { target: { value: "ruth@" } });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Enter an email address")).toBeInTheDocument();
    expect(document.activeElement).toBe(email);
  });

  it("moves no focus when it mounts after a failed submit", async () => {
    function Toggled() {
      const form = useZodForm(schema, {
        defaultValues: { name: "", email: "", agree: false },
      });
      const [shown, setShown] = React.useState(false);
      return (
        <Form {...form}>
          <form noValidate onSubmit={form.handleSubmit(async () => {})}>
            {shown ? <FormErrorSummary /> : null}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <button type="submit">Save</button>
            <button type="button" onClick={() => setShown(true)}>
              Show summary
            </button>
          </form>
        </Form>
      );
    }
    render(<Toggled />);
    await submit();
    const toggle = screen.getByRole("button", { name: "Show summary" });
    toggle.focus();
    await act(async () => {
      fireEvent.click(toggle);
    });

    // It shows what is wrong, and leaves focus where the person put it.
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name");
    await expectToHoldFocus(toggle, "the control the person used");
  });

  it("takes focus again on the next failed submit", async () => {
    render(<TestForm />);
    await submit();
    screen.getByLabelText("Name").focus();
    await submit();
    await expectToHoldFocus(screen.getByRole("alert"), "the error summary");
  });

  it("goes away when a submit succeeds", async () => {
    render(<TestForm />);
    await submit();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ruth" } });
      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "ruth@example.org" },
      });
      fireEvent.click(screen.getByRole("checkbox"));
    });
    await submit();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("server field errors on the form", () => {
  async function fillValid() {
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ruth" } });
      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "ruth@example.org" },
      });
      fireEvent.click(screen.getByRole("checkbox"));
    });
  }

  it("puts a route's field error on that field and in the focused summary", async () => {
    render(
      <TestForm
        serverBody={{
          error: "Invalid input",
          details: {
            formErrors: [],
            fieldErrors: { email: ["That address is already a role's alias"] },
          },
        }}
      />,
    );
    await fillValid();
    await submit();

    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById(describedByIds(email)[0]!)).toHaveTextContent(
      "That address is already a role's alias",
    );
    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent("That address is already a role's alias");
    await expectToHoldFocus(summary, "the error summary");
  });

  it("shows a form-level error, or one for a field the form lacks, unlinked", async () => {
    render(
      <TestForm
        serverBody={{
          error: "Invalid input",
          details: {
            formErrors: ["Unrecognized key: \"colour\""],
            fieldErrors: { sortOrder: ["Too big"] },
          },
        }}
      />,
    );
    await fillValid();
    await submit();

    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent('Unrecognized key: "colour"; Sort order: Too big');
    expect(summary.querySelectorAll("a")).toHaveLength(0);
  });
});

// Review F1 and F2 (#4467): a field with more than one rule, and a field that
// renders no FormMessage.
const codeSchema = z.object({
  code: z
    .string()
    .min(3, "Use at least 3 characters")
    .regex(/^[a-z]+$/, "Use lowercase letters only"),
  nickname: z.string(),
});

function CodeForm({ serverBody }: { serverBody?: unknown }) {
  const form = useZodForm(codeSchema, { defaultValues: { code: "", nickname: "" } });
  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit(async () => {
          if (serverBody !== undefined) applyServerValidationErrors(form, 400, serverBody);
        })}
      >
        <FormErrorSummary />
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Code</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="nickname"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nickname</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItem>
          )}
        />
        <button type="submit">Save</button>
      </form>
    </Form>
  );
}

describe("the summary's text between submits", () => {
  it("keeps the message the submit found while the field moves to another rule's", async () => {
    render(<CodeForm />);
    await submit();
    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent("Use at least 3 characters");

    const code = screen.getByLabelText("Code");
    code.focus();
    await act(async () => {
      fireEvent.change(code, { target: { value: "ABCD" } });
    });

    // The inline message follows the field; the alert's text does not change,
    // so nothing is re-announced while the person types.
    expect(screen.getByText("Use lowercase letters only")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBe(summary);
    expect(summary).toHaveTextContent("Use at least 3 characters");
    expect(summary).not.toHaveTextContent("Use lowercase letters only");
    expect(document.activeElement).toBe(code);

    await act(async () => {
      fireEvent.change(code, { target: { value: "abcd" } });
    });
    expect(screen.queryByRole("alert")).toBeNull();

    // The next submit shows what it finds now.
    await act(async () => {
      fireEvent.change(code, { target: { value: "AB" } });
    });
    await submit();
    expect(screen.getByRole("alert")).toHaveTextContent("Use at least 3 characters");
  });
});

describe("FormMessage registration", () => {
  it("names no message id for a failed field that renders no FormMessage", async () => {
    render(
      <CodeForm
        serverBody={{ error: "Invalid input", details: { fieldErrors: { nickname: ["Taken"] } } }}
      />,
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Code"), { target: { value: "abcd" } });
    });
    await submit();

    const nickname = screen.getByLabelText("Nickname");
    expect(nickname).toHaveAttribute("aria-invalid", "true");
    // Every id it names must resolve; with no message and no hint there are none.
    for (const id of describedByIds(nickname)) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
    expect(nickname).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("alert")).toHaveTextContent("Taken");
  });

  it("drops the message id when the error clears", async () => {
    render(<CodeForm />);
    await submit();
    const code = screen.getByLabelText("Code");
    expect(describedByIds(code)).toHaveLength(1);
    await act(async () => {
      fireEvent.change(code, { target: { value: "abcd" } });
    });
    expect(code).not.toHaveAttribute("aria-describedby");
  });
});

describe("collectFormErrors", () => {
  it("walks nested and array errors, and keeps root errors unlinked", () => {
    expect(
      collectFormErrors({
        name: { type: "too_small", message: "Enter a name" },
        guests: [
          undefined,
          { firstName: { type: "too_small", message: "Enter a first name" } },
        ] as never,
        root: { server: { type: "server", message: "Try again" } } as never,
      }),
    ).toEqual([
      { name: "name", message: "Enter a name" },
      { name: "guests.1.firstName", message: "Enter a first name" },
      { name: null, message: "Try again" },
    ]);
  });
});
