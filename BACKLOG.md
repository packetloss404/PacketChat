# Backlog

## MCP Tools

MCP tool support is intentionally deferred from V1 runtime scope. Before enabling it, PacketChat needs server-side MCP connection storage, per-user or owner-scoped credentials, tool allowlists, request/response auditing, timeout and size limits, and run-step persistence for tool calls and results.

Acceptance notes:

- Agents can attach only explicitly allowed MCP servers and tools.
- Tool credentials are encrypted and never exposed to the browser after save.
- Tool execution is bounded by timeout, payload size, and run step limits.
- Agent run events show each tool call, result, failure, and skipped call.
- Tests cover denied tools, revoked credentials, timeout behavior, and successful execution.

## Code Interpreter

Code interpreter support is intentionally deferred from V1 runtime scope. Before enabling it, PacketChat needs an isolated execution sandbox, per-run working directories, explicit file input/output handling, CPU and memory limits, network policy, artifact persistence, and cleanup jobs.

Acceptance notes:

- Code execution runs in a disposable sandbox with no host filesystem access.
- Network access is disabled by default and configurable only by an admin.
- Generated files are attached to the run as artifacts with size limits.
- Long-running or oversized executions fail clearly and leave audit events.
- Tests cover sandbox isolation, file artifacts, timeout behavior, and cleanup.
