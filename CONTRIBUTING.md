# Contributing

1. Select one story from `docs/BACKLOG.md` and use a short-lived branch.
2. Preserve unrelated work and never commit secrets, production data, generated
   backups, `.env` files, or provider/SSH credentials.
3. Add tests and documentation with the implementation.
4. Run `make test` and `make release-check`; infrastructure changes also need
   the CI Docker/Ansible/Nginx validators.
5. Open a pull request using the template and attach concise acceptance,
   migration, accessibility/security, staging, and rollback evidence.

Changes to authentication, permissions, tenant scoping, money/invoices,
migrations, evidence access, release trust, or backups require explicit abuse/
failure tests and owner review. Do not deploy from a workstation or rebuild an
artifact after staging qualification.
