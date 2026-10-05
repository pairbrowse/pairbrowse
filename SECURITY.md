# Security policy

PairBrowse controls a browser that is signed into real accounts, so security reports are
very welcome.

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on
this repository (Security tab), not in a public issue. Include steps to reproduce and the
PairBrowse version. You'll get an answer within a few days.

## How we handle a report

1. **Acknowledge** within 3 working days, in the private advisory.
2. **Confirm and rate** it (CVSS) together with you, within 14 days.
3. **Fix** it in a private fork of the advisory; a confirmed high or critical issue is fixed and
   released within 30 days, a medium one within 60. You may test the fix before it ships.
4. **Release and disclose**: the fixed version, a published GitHub security advisory (with a CVE
   when the issue warrants one) and its `CHANGELOG.md` entry go out together.
5. **Credit**: the advisory and the changelog name you, unless you ask to stay anonymous.

Only the latest release gets security fixes. Updating is one command (see
[docs/install.md](docs/install.md#update)); the changelog says when an update needs anything more.

## Checking a download

Every file of a native browser release is checked in GitHub Actions against the SHA-256 the
plugin pins (`scripts/native-pack.mjs`), and that check is signed and recorded in Sigstore's
public transparency log. Verify a file you downloaded with:

```bash
gh attestation verify pairbrowse-150.0.7871.114-macos-arm64.zip -R pairbrowse/pairbrowse
```

This shows the file is exactly the one the plugin installs. The builds are made by the
maintainers, not in CI, so it doesn't show what they were built from.

Each file is also scanned by VirusTotal; the reports are linked in the release notes.

The repository is also scanned by [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/pairbrowse/pairbrowse),
CodeQL and Dependabot; results are in the Security tab.

## Threat model

The threat model and its limits are described in [docs/security.md](docs/security.md).
