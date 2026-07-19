# Contributing to E-GAOP

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

1. Fork the repository on GitHub.
2. Clone your fork locally.
3. Create a feature branch.

## Development Guidelines

### Protobuf First

Changes to the core resource model must start with a modification to the `.proto` files in `api/proto/`. We follow standard protobuf backward-compatibility rules.

### Testing

- **Unit tests**: Mandatory for all new logic.
- **Integration tests**: Required for changes affecting inter-plane communication (testcontainers-based).
- **Policy tests**: New engine capabilities should include Rego test cases.

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` — new capability
- `fix:` — bug fix
- `docs:` — documentation changes
- `refactor:` — code restructuring
- `chore:` — tooling, dependencies, CI

## Pull Request Process

1. Ensure linting and typecheck pass.
2. Write atomic commits with descriptive messages.
3. Self-review for security implications, especially in `policy-plane/` and `execution-plane/`.
4. Link any related PR descriptions in `prs/` for traceability.

## Reporting Issues

Use the issue templates (see `.github/ISSUE_TEMPLATE/`). Include:
- E-GAOP version (git commit hash)
- Component (e.g., llm-router, workflow-engine)
- Expected vs actual behavior
- Relevant logs or traces

---

> **Note on production readiness:** This project has a published readiness assessment at `docs/production-readiness-final.md`. Known limitations are documented there — please check before reporting capability gaps.
