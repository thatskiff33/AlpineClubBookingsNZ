- Updated the DOMPurify HTML sanitiser to 3.4.13, which carries a published fix
  for a cross-site-scripting weakness in earlier versions. The affected code path
  is not one this application uses — DOMPurify only arrives here through the PDF
  library, and only its HTML-to-PDF feature reaches the sanitiser, which the
  reports never call — so nothing was exposed. The version is raised anyway so the
  dependency is clean rather than merely unreachable.
