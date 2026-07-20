# README Guidelines

## The one rule

> **Every factual claim in the README must be verified against running code before it's committed.**

This is not optional. This is the standing rule for this repo — not a
one-time fix, not a suggestion.

## Why this rule exists

In July 2026, a rebrand commit (`f0eee37`) replaced the entire
evidence-backed README with marketing copy. Among the problems:

- **Directly false claims** — "All gRPC services authenticate via mutual
  TLS" when `packages/shared/src/tls.ts` explicitly disables client-cert
  verification due to a library bug.
- **Reappearance of previously-removed claims** — "PII detection" had
  been removed in an earlier round as unsupported; it reappeared with no
  new evidence.
- **Lost honesty framework** — The Known Limitations section, the
  readiness score, and the link to `production-readiness-final.md` were
  all silently dropped.
- **Unverified new claims** — Redis Sentinel HA was claimed despite the
  docker-compose.yml having a single Redis instance with no sentinel
  containers.
- **CI badge restored** — Despite no confirmed green CI run ever
  existing.

The corrections from that incident are documented in the git history
(commit `4a58e60`), and the README has been restored to evidence-backed
discipline. This document exists to prevent a third occurrence.

## How to apply it

### Adding a new capability claim

1. Find where in `docs/production-readiness-final.md` the capability is
   scored and what evidence is cited.
2. If it's not in the readiness document, check the actual code — not
   just that the code exists, but that it works as claimed (test, log,
   or verified run).
3. Add a `Status` column or inline note: `✅ Verified`, `⚠️ Partial
   (reason)`, or `❌ Not deployed`.
4. Never say "mTLS" without noting the `@grpc/grpc-js` bug. Never say
   "PII detection" without noting it's warn-only. Never say "Sentinel
   HA" without sentinel containers in compose.

### Removing or modifying the Known Limitations section

Don't. The Known Limitations section is the README's credibility. If
a limitation has been genuinely fixed, update it in
`docs/production-readiness-final.md` first, then reflect the change
here. Do not delete the section.

### Adding a badge

Before adding any badge, verify the thing it claims. A CI badge requires
a real, uncancelled green CI run you can point to. A code coverage badge
requires a real coverage report. A "passing" badge for anything that has
never been run is a misrepresentation.

## Enforcement

This rule is enforced at PR review time. The PR template (see
`CONTRIBUTING.md`) includes a "claims traceability" line. If a README
change adds capability claims without citing verification evidence,
the PR should not be approved.

## Scope

These guidelines apply to the README specifically. Other documentation
files (`docs/`, `evals/`, etc.) should also be accurate, but the README
is the public face of the project and carries the highest bar.
