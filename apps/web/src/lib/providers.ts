// Provider account and model-binding resolution moved into
// @packetchat/agent-runtime so the queue worker can reach it (the worker cannot
// import from apps/web). This shim keeps the chat and provider routes on their
// existing import path; it goes away once they import the package directly.
export { getEnabledModelBindingForRuntime, getProviderAccountForRuntime } from "@packetchat/agent-runtime";
