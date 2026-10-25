# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub's [private vulnerability reporting](https://github.com/roberjo/restaurant-ads/security/advisories/new). Include steps to reproduce and the affected version or commit.

You can expect an acknowledgement within 3 business days and a fix or mitigation plan within 30 days for confirmed issues.

## Supported versions

Pre-1.0: only the latest release receives security fixes.

## What's in place

| Control | Where |
|---|---|
| Static analysis (CodeQL, security-extended) | `.github/workflows/codeql.yml` |
| Vulnerability, secret and misconfiguration scanning (Trivy) of the repo and container image | `.github/workflows/security.yml` |
| Secret scanning of full git history (gitleaks) | `.github/workflows/security.yml` |
| Dependency review on pull requests; Dependabot for actions, Docker and npm | `.github/workflows/security.yml`, `.github/dependabot.yml` |
| Third-party actions pinned to commit SHAs | all workflows |
| Container runs as non-root with a health check | `Dockerfile` |
| Passwords hashed with scrypt; session and device secrets stored only as SHA-256 hashes | `server/src/auth.ts` |
| Tenant isolation checked on every request; out-of-scope rows return 404 | `server/src/routes/*` |
| Stripe webhook HMAC verification with timestamp tolerance | `server/src/stripe.ts` |
| Uploads sniffed by content and size-limited; served with a sandboxing CSP | `server/src/uploads.ts`, `server/src/app.ts` |
| Proof-of-play integrity checks (billing fraud) | `server/src/routes/device.ts` |
| No audience PII or cameras by design | `docs/roadmap.md` §4.4 |

## Deployment notes

- Always run behind HTTPS (TLS-terminating proxy or platform).
- Never set `SEED_DEMO=1` in production: demo accounts use a published password.
- Set `STRIPE_WEBHOOK_SECRET` whenever `STRIPE_SECRET_KEY` is set.
