- **Deployment images have verifiable build records and pinned inputs (#4455).**
  Actions and external container images now use immutable references, updated
  through Dependabot. Published app and migration images include an SBOM and
  build provenance; the deployment guide explains how to verify them. App
  containers drop Linux capabilities, new npm releases wait seven days before
  installation, and OpenSSF Scorecard reports advisory security findings.
