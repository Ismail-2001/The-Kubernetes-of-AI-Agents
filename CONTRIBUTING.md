# Contributing to E-GAOP

We're excited that you're interested in contributing to the Enterprise-Grade Agent Orchestration Platform! As a FAANG-grade project, we maintain high standards for code quality, security, and documentation.

## 🤝 Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## 🚀 Getting Started

1.  **Fork the repository** on GitHub.
2.  **Clone your fork** locally:
    ```bash
    git clone https://github.com/YOUR_USERNAME/Enterprise-Grade-Agent-Orchestration-Platform.git
    ```
3.  **Create a feature branch**:
    ```bash
    git checkout -b feat/your-feature-name
    ```

## 🛠️ Development Standards

### 1. Protobuf First
Any changes to the core resource model must start with a modification to the `.proto` files in `api/proto/`. We follow strict backward compatibility rules.

### 2. Testing
- **Unit Tests**: Mandatory for all new logic.
- **Integration Tests**: Required for any change affecting inter-plane communication.
- **Policy Tests**: Any new engine capability must include Rego test cases.

### 3. Documentation
- Update `ARCHITECTURE.md` if you introduce new system patterns.
- Ensure all public APIs are documented with Protobuf comments.

## 📬 Pull Request Process

1.  **Linting**: Ensure your code passes all linting checks.
2.  **Atomic Commits**: Use descriptive, atomic commit messages following [Conventional Commits](https://www.conventionalcommits.org/).
3.  **Self-Review**: Review your own PR for security implications and performance bottlenecks.
4.  **Security Review**: Changes to the `policy-plane` or `execution-plane` sandboxes require an additional security audit.

## 🐞 Reporting Issues

Please use the provided issue templates for bug reports and feature requests. Provide as much context as possible, including:
- E-GAOP version
- Component (e.g., Tool Proxy)
- Expected vs. Actual behavior
- Relevant logs or traces

Thank you for helping us build the future of AI orchestration!
