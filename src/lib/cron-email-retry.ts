import { prisma } from "./prisma";
import nodemailer from "nodemailer";
import logger from "@/lib/logger";

const MAX_ATTEMPTS = 3;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "email-smtp.ap-southeast-2.amazonaws.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.AWS_SES_ACCESS_KEY_ID || "",
    pass: process.env.AWS_SES_SECRET_ACCESS_KEY || "",
  },
});

const FROM = process.env.EMAIL_FROM || "bookings@tacbookings.co.nz";

/**
 * N-11: Retry failed emails with backoff.
 * Queries EmailLog for FAILED records with attempts < 3 and re-sends.
 * Runs every 30 minutes.
 */
export async function retryFailedEmails(): Promise<{ retried: number; succeeded: number; failed: number }> {
  const failedEmails = await prisma.emailLog.findMany({
    where: {
      status: "FAILED",
      attempts: { lt: MAX_ATTEMPTS },
      htmlBody: { not: null },
    },
    orderBy: { createdAt: "asc" },
    take: 50, // Process in batches to avoid overload
  });

  let retried = 0;
  let succeeded = 0;
  let failed = 0;

  for (const emailLog of failedEmails) {
    retried++;
    const newAttempts = emailLog.attempts + 1;

    try {
      if (process.env.NODE_ENV === "development") {
        logger.info({ to: emailLog.to, subject: emailLog.subject }, "Email retry (dev mode)");
        await prisma.emailLog.update({
          where: { id: emailLog.id },
          data: {
            status: "SENT",
            sentAt: new Date(),
            attempts: newAttempts,
            lastAttemptAt: new Date(),
            errorMessage: null,
          },
        });
        succeeded++;
        continue;
      }

      const result = await transporter.sendMail({
        from: `"TAC Bookings" <${FROM}>`,
        to: emailLog.to,
        subject: emailLog.subject,
        html: emailLog.htmlBody!,
      });

      await prisma.emailLog.update({
        where: { id: emailLog.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          messageId: result.messageId || null,
          attempts: newAttempts,
          lastAttemptAt: new Date(),
          errorMessage: null,
        },
      });
      succeeded++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, emailLogId: emailLog.id, attempt: newAttempts }, "Email retry failed");

      await prisma.emailLog.update({
        where: { id: emailLog.id },
        data: {
          attempts: newAttempts,
          lastAttemptAt: new Date(),
          errorMessage,
          // Keep status as FAILED — will retry again if attempts < MAX
        },
      }).catch((updateErr) => {
        logger.error({ err: updateErr, emailLogId: emailLog.id }, "Failed to update EmailLog after retry failure");
      });
      failed++;
    }
  }

  return { retried, succeeded, failed };
}
