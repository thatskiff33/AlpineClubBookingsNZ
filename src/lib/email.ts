import nodemailer from "nodemailer";
import {
  welcomeTemplate,
  passwordResetTemplate,
  bookingConfirmedTemplate,
  bookingPendingTemplate,
  bookingBumpedTemplate,
  bookingCancelledTemplate,
  choreRosterTemplate,
} from "./email-templates";
import logger from "@/lib/logger";

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

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {
  if (process.env.NODE_ENV === "development") {
    logger.info({ to, subject }, "Email sent (dev mode)");
    logger.debug({ html }, "Email HTML content");
    return;
  }

  await transporter.sendMail({
    from: `"TAC Bookings" <${FROM}>`,
    to,
    subject,
    html,
  });
}

export async function sendPasswordResetEmail(
  email: string,
  token: string
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  await sendEmail({
    to: email,
    subject: "Reset your TAC Bookings password",
    html: passwordResetTemplate(resetUrl),
  });
}

export async function sendBookingConfirmedEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number,
  options?: { discountCents?: number; promoCode?: string }
) {
  await sendEmail({
    to: email,
    subject: "Booking Confirmed - TAC Lodge",
    html: bookingConfirmedTemplate(firstName, checkIn, checkOut, guestCount, totalCents, options),
  });
}

export async function sendBookingPendingEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  holdUntil: Date
) {
  await sendEmail({
    to: email,
    subject: "Booking Pending - TAC Lodge",
    html: bookingPendingTemplate(firstName, checkIn, checkOut, guestCount, holdUntil),
  });
}

export async function sendBookingBumpedEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number
) {
  await sendEmail({
    to: email,
    subject: "Booking Update - TAC Lodge",
    html: bookingBumpedTemplate(firstName, checkIn, checkOut, guestCount),
  });
}

export async function sendBookingCancelledEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  refundCents: number
) {
  await sendEmail({
    to: email,
    subject: "Booking Cancelled - TAC Lodge",
    html: bookingCancelledTemplate(firstName, checkIn, checkOut, refundCents),
  });
}

export async function sendChoreRosterEmail(
  email: string,
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>
) {
  const formattedDate = new Date(date + "T00:00:00").toLocaleDateString("en-NZ", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  await sendEmail({
    to: email,
    subject: `Your chore roster for ${formattedDate} - TAC Lodge`,
    html: choreRosterTemplate(guestName, date, chores),
  });
}

export async function sendWelcomeEmail(email: string, firstName: string) {
  await sendEmail({
    to: email,
    subject: "Welcome to TAC Bookings",
    html: welcomeTemplate(firstName),
  });
}
