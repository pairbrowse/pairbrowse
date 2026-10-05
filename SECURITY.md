# Security policy

PairBrowse controls a browser that is signed into real accounts, so security reports are
very welcome.

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on
this repository (Security tab), not in a public issue. Include steps to reproduce and the
PairBrowse version. You'll get an answer within a few days.

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
