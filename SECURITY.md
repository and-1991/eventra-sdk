# Security Policy

This policy covers `@eventra_dev/eventra-sdk` (Eventra SDK), published at https://www.npmjs.com/package/@eventra_dev/eventra-sdk. The Eventra service itself is covered on https://eventra.dev/security.

## Supported versions

Only the latest published version receives security fixes. Please update before reporting, and say which version you tested.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- Use GitHub's private reporting: the **Report a vulnerability** button on the [Security tab](https://github.com/and-1991/eventra-sdk/security/advisories/new) of this repository.
- Or email **security@eventra.dev** with the steps to reproduce, the affected version and what an attacker could do.

We aim to confirm that we received your report within 5 business days, and to tell you what we found and what we plan to do after that. Please give us a reasonable chance to release a fix before you disclose the issue. We credit reporters in the release notes unless you ask us not to.

## How releases are made

Releases are built and published to npm by a GitHub Actions workflow in this repository, with no stored npm token (npm trusted publishing). Recent versions carry an npm provenance attestation, shown on the package page, that links the package to the commit and workflow run that built it.
