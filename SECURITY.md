# Security Policy

TokenPanel handles provider credentials, customer API keys, balances, and usage records. Please report security problems privately so maintainers can investigate before public disclosure.

## Reporting a Vulnerability

Use [GitHub private vulnerability reporting](https://github.com/tokenpanel/tokenpanel/security/advisories/new).

Include, when possible:

- Affected version, commit, or deployment mode
- Reproduction steps or proof of concept
- Expected impact and affected data
- Suggested mitigation

Do not open a public issue for suspected vulnerabilities. Do not access data that is not yours, degrade a service, or perform destructive testing.

## Response

Maintainers will acknowledge valid reports as soon as practical, investigate impact, coordinate a fix, and publish an advisory when users need to act. Timelines depend on severity and reproducibility.

## Supported Versions

Before the first stable release, security fixes target the latest release and the current `main` branch. Older development snapshots may not receive patches.

## Deployment Responsibility

Operators remain responsible for TLS, network access controls, host updates, backups, secret rotation, and secure MongoDB configuration. Never expose MongoDB directly to the public internet.
