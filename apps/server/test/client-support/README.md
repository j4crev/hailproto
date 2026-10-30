# Provider integration-test client helpers

These helpers construct independent signed fixtures and drive in-process provider
handlers in tests. They were retained from the retired TypeScript CLI to preserve
provider protocol tests, including tests that inject HTTP transports and recovery
input. They have no executable entry point and are not part of production builds.

Production browser vault/transport modules live in `packages/hail-client-support`.
The supported CLI implementation is Rust in `apps/cli`. CLI process regressions
exercise that executable directly, including failure/retry and transfer workflows.
