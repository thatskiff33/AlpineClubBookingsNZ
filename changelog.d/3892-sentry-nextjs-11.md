- **Sentry upgraded to v11 (`@sentry/nextjs` 11.1.0).** Browser error reporting
  keeps console, DOM, fetch and navigation breadcrumbs as before: since v11 the
  console ones come from Sentry's default console integration rather than an
  option on the breadcrumbs integration, which v11 removed.
