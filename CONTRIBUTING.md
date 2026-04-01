# Contributing

Thanks for your interest in contributing.

## Quick Start

1. Fork the repository on GitHub.
2. Create a feature branch from `main` in your fork.
3. Make focused changes with clear commit messages.
4. Run local checks before opening a pull request:
   - `npm ci`
   - `npm run build`
   - `docker build -t twgbellok/neurodivergent-memory:dev .` (if you changed container/release files)
5. Open a pull request to this repository.

## Contribution Expectations

- Keep changes scoped to a clear purpose.
- Update documentation when behavior, APIs, or workflows change.
- Follow the existing code style and project structure.
- Do not include secrets, credentials, or private keys.

## Pull Request Guidance

- Explain what changed and why.
- Include validation steps and results.
- Link related issues when applicable.

## Post-Release Documentation Sync Checklist

After each tagged release, verify these docs are updated to the released version:

- `Roadmap_0_1_8_push_to_1_0_0.md`: Current Position header and Release History row
- `SMOKE_TEST_REPORT.md`: Server Version and report date
- `EXPERIMENT_REPORT.md`: Version under test and report date
- `README.md`: any release-specific labels or migration notes
- `CHANGELOG.md`: release entry date and summary (sanity check)

If any item is out of sync, open and link a docs issue before the next release candidate cut.

## Communication

For questions or proposal discussion, use GitHub issues or pull request comments.
No email support channel is provided.
