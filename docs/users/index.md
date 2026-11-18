# User and administrator guides

Use these task-oriented guides to operate the implemented LicenX interfaces.

- [Getting started](getting-started.md): installation roles, onboarding, first administration.
- [Installation](installation.md): Docker/VPS modes, initial credentials and safe updates.
- [Configuration](configuration.md): storage, site appearance, security controls.
- [Feature guide index](features/index.md): admin modules, public portal, SDK and backups.
- [Workflows](workflows.md): end-to-end task sequences and expected state transitions.
- [Troubleshooting](troubleshooting.md) and [FAQ](faq.md).

**Roles:** the public visitor or license holder accesses `/`, `/check`, and `/tools`; an authenticated administrator uses `/vcon`; an application integrator installs the Python SDK or uses an explicitly scoped backend API key. UI paths are resolved by `src/App.tsx`, and admin navigation labels by `src/components/Sidebar.tsx`.