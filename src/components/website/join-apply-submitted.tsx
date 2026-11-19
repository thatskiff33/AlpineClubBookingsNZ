import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface JoinApplySubmittedProps {
  /**
   * Where "Application submitted" sits in its page's outline: 1 when nothing
   * else on the page is a level-1 heading once the form is gone, 2 under a
   * page that keeps its own.
   */
  headingLevel: 1 | 2;
  /** Anything the server accepted the application with but wants said. */
  warnings: readonly string[];
}

/** What the membership application shows in place of the form once it is sent. */
export function JoinApplySubmitted({
  headingLevel,
  warnings,
}: JoinApplySubmittedProps) {
  return (
    <section className="bg-brand-mist/40 py-12 sm:py-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <Card className="border-brand-ridge/20 bg-card shadow-[0_22px_46px_-34px_rgba(47,47,43,0.38)]">
          <CardHeader className="space-y-3 text-center">
            <CardTitle
              headingLevel={headingLevel}
              className="font-heading text-3xl text-brand-charcoal"
            >
              Application submitted
            </CardTitle>
            <CardDescription className="text-base text-brand-deep/75">
              Your details are in. We have asked both nominators to confirm
              your nomination before the committee review step.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-brand-deep/78">
            <p>
              Once both nominators approve, the application moves to the club
              admin panel for committee consideration.
            </p>
            <p>
              Nomination emails occasionally go missing. If a nominator has
              not received theirs, ask them to check their spam folder first
              — then contact the club and an administrator can send them a
              fresh nomination link.
            </p>
            {warnings.length > 0 && (
              <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-warning-11">
                {warnings.join(". ")}
              </div>
            )}
            <p>
              Existing members can return to{" "}
              <Link className="underline underline-offset-4" href="/login">
                login
              </Link>
              . If you need to update the application, contact the club.
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
