const currency =
  process.env.CURRENCY?.trim() ||
  process.env.NEXT_PUBLIC_CURRENCY?.trim() ||
  "NZD";
const timeZone =
  process.env.TZ?.trim() ||
  process.env.NEXT_PUBLIC_TZ?.trim() ||
  "Pacific/Auckland";
const locale =
  process.env.LOCALE?.trim() ||
  process.env.NEXT_PUBLIC_LOCALE?.trim() ||
  "en-NZ";

export const APP_CURRENCY = currency.toUpperCase();
export const APP_STRIPE_CURRENCY = APP_CURRENCY.toLowerCase();
export const APP_TIME_ZONE = timeZone;
export const APP_LOCALE = locale;
