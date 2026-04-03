import nodemailer from "nodemailer";

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
    console.log(`[EMAIL] To: ${to} | Subject: ${subject}`);
    console.log(html);
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
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Password Reset</h2>
        <p>You requested a password reset for your Tokoroa Alpine Club booking account.</p>
        <p>Click the link below to reset your password. This link expires in 1 hour.</p>
        <p><a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: white; text-decoration: none; border-radius: 6px;">Reset Password</a></p>
        <p style="color: #666; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

export async function sendBookingConfirmedEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  totalCents: number
) {
  const checkInStr = checkIn.toLocaleDateString("en-NZ", { dateStyle: "medium" });
  const checkOutStr = checkOut.toLocaleDateString("en-NZ", { dateStyle: "medium" });
  const totalStr = `$${(totalCents / 100).toFixed(2)}`;

  await sendEmail({
    to: email,
    subject: "Booking Confirmed - TAC Lodge",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Booking Confirmed</h2>
        <p>Hi ${firstName}, your lodge booking has been confirmed!</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 8px; font-weight: bold;">Check-in:</td><td style="padding: 8px;">${checkInStr}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Check-out:</td><td style="padding: 8px;">${checkOutStr}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Guests:</td><td style="padding: 8px;">${guestCount}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Total:</td><td style="padding: 8px;">${totalStr}</td></tr>
        </table>
        <p>Payment has been processed. You can view your booking details in your account.</p>
        <p><a href="${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings" style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: white; text-decoration: none; border-radius: 6px;">View Booking</a></p>
      </div>
    `,
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
  const checkInStr = checkIn.toLocaleDateString("en-NZ", { dateStyle: "medium" });
  const checkOutStr = checkOut.toLocaleDateString("en-NZ", { dateStyle: "medium" });
  const holdStr = holdUntil.toLocaleDateString("en-NZ", { dateStyle: "medium" });

  await sendEmail({
    to: email,
    subject: "Booking Pending - TAC Lodge",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Booking Pending</h2>
        <p>Hi ${firstName}, your lodge booking has been received and is currently pending.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 8px; font-weight: bold;">Check-in:</td><td style="padding: 8px;">${checkInStr}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Check-out:</td><td style="padding: 8px;">${checkOutStr}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Guests:</td><td style="padding: 8px;">${guestCount}</td></tr>
        </table>
        <p>Because your booking includes non-member guests, it will be held as pending until <strong>${holdStr}</strong> (7 days before check-in).</p>
        <p>During this time, club members have priority. If the lodge fills up with member bookings, your booking may be bumped. Your card will only be charged when the booking is confirmed.</p>
        <p><a href="${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings" style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: white; text-decoration: none; border-radius: 6px;">View Booking</a></p>
      </div>
    `,
  });
}

export async function sendBookingBumpedEmail(
  email: string,
  firstName: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number
) {
  const checkInStr = checkIn.toLocaleDateString("en-NZ", { dateStyle: "medium" });
  const checkOutStr = checkOut.toLocaleDateString("en-NZ", { dateStyle: "medium" });

  await sendEmail({
    to: email,
    subject: "Booking Update - TAC Lodge",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Booking Update</h2>
        <p>Hi ${firstName}, unfortunately your pending lodge booking has been bumped due to member demand.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 8px; font-weight: bold;">Check-in:</td><td style="padding: 8px;">${checkInStr}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Check-out:</td><td style="padding: 8px;">${checkOutStr}</td></tr>
          <tr><td style="padding: 8px; font-weight: bold;">Guests:</td><td style="padding: 8px;">${guestCount}</td></tr>
        </table>
        <p>Your card has <strong>not</strong> been charged. As a non-member booking, priority is given to club members when the lodge reaches capacity.</p>
        <p>You're welcome to rebook for different dates where availability exists.</p>
        <p><a href="${process.env.NEXTAUTH_URL || "http://localhost:3000"}/book" style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: white; text-decoration: none; border-radius: 6px;">Book Again</a></p>
      </div>
    `,
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

  const choreList = chores
    .map(
      (c) =>
        `<tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: 600;">${c.name}</td><td style="padding: 8px; border: 1px solid #ddd; color: #555;">${c.description || ""}</td></tr>`
    )
    .join("");

  await sendEmail({
    to: email,
    subject: `Your chore roster for ${formattedDate} - TAC Lodge`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Chore Roster</h2>
        <p>Hi ${guestName},</p>
        <p>Here are your assigned chores for <strong>${formattedDate}</strong> at the Tokoroa Alpine Club lodge:</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <thead>
            <tr style="background: #f5f5f5;">
              <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Chore</th>
              <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Description</th>
            </tr>
          </thead>
          <tbody>${choreList}</tbody>
        </table>
        <p style="background: #fef3c7; padding: 12px; border-radius: 6px; font-weight: 600;">
          Last person to bed: Check heaters and fire are safe and doors are secure.
        </p>
        <p style="color: #666; font-size: 14px;">Thanks for helping keep the lodge running smoothly!</p>
      </div>
    `,
  });
}

export async function sendWelcomeEmail(email: string, firstName: string) {
  await sendEmail({
    to: email,
    subject: "Welcome to TAC Bookings",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome, ${firstName}!</h2>
        <p>Your Tokoroa Alpine Club booking account has been created.</p>
        <p>You can now log in to book stays at the lodge.</p>
        <p><a href="${process.env.NEXTAUTH_URL || "http://localhost:3000"}/login" style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: white; text-decoration: none; border-radius: 6px;">Log In</a></p>
      </div>
    `,
  });
}
