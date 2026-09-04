import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artifactInstructions,
  externalActionApprovalInput,
  isBlockedAddress,
  isBlockedHost,
  parseCalculation,
  publicRunError,
  renderTemplate,
  runFailureStatus,
  snippetFor,
  termsFor,
  textOrNull
} from "../src/helpers";

const neverResolves = async () => {
  throw new Error("resolveHost must not be reached for a literal address");
};

test("textOrNull trims and rejects blank or non-string input", () => {
  assert.equal(textOrNull("  hello  "), "hello");
  assert.equal(textOrNull("   "), null);
  assert.equal(textOrNull(42), null);
  assert.equal(textOrNull(undefined), null);
});

test("parseCalculation honours precedence, parentheses and unary minus", () => {
  assert.deepEqual(parseCalculation("2 + 3 * 4"), { expression: "2 + 3 * 4", result: 14 });
  assert.deepEqual(parseCalculation("(2 + 3) * 4"), { expression: "(2 + 3) * 4", result: 20 });
  assert.deepEqual(parseCalculation("-3 + 10"), { expression: "-3 + 10", result: 7 });
});

test("parseCalculation strips the calculate/what-is prefixes and a trailing question mark", () => {
  assert.deepEqual(parseCalculation("Calculate 6 / 2"), { expression: "6 / 2", result: 3 });
  assert.deepEqual(parseCalculation("what is 7 - 1?"), { expression: "7 - 1", result: 6 });
});

test("parseCalculation returns null rather than throwing on anything it cannot evaluate", () => {
  assert.equal(parseCalculation("what is the capital of France?"), null);
  assert.equal(parseCalculation("1 / 0"), null);
  assert.equal(parseCalculation("(1 + 2"), null);
  assert.equal(parseCalculation("1.2.3 + 1"), null);
  // No digits at all, so the character-class guard rejects it before parsing.
  assert.equal(parseCalculation("()"), null);
});

test("isBlockedAddress covers loopback, link-local and the private ranges", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "169.254.1.1", "172.16.0.1", "172.31.255.255", "::1", "fe80::1", "fd00::1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("isBlockedHost blocks literal private addresses without a DNS lookup", async () => {
  assert.equal(await isBlockedHost("localhost", neverResolves), true);
  assert.equal(await isBlockedHost("api.localhost", neverResolves), true);
  assert.equal(await isBlockedHost("127.0.0.1", neverResolves), true);
  assert.equal(await isBlockedHost("172.20.0.9", neverResolves), true);
});

test("isBlockedHost blocks a name that resolves anywhere private, and an empty lookup", async () => {
  assert.equal(await isBlockedHost("rebind.example", async () => ["93.184.216.34", "10.0.0.1"]), true);
  assert.equal(await isBlockedHost("nxdomain.example", async () => []), true);
  assert.equal(await isBlockedHost("example.com", async () => ["93.184.216.34"]), false);
});

test("externalActionApprovalInput returns null when there is nothing external to approve", () => {
  assert.equal(externalActionApprovalInput({}, "hello"), null);
  assert.equal(externalActionApprovalInput({ tools: { urlFetch: true } }, "no links here"), null);
  assert.equal(externalActionApprovalInput({ openApiActions: [{ id: "a", enabled: false }] }, "hello"), null);
});

test("externalActionApprovalInput lists enabled actions and flags url fetch", () => {
  const approval = externalActionApprovalInput(
    { tools: { urlFetch: true }, openApiActions: [{ id: "a", name: "Lookup", method: "post", url: "https://api.example/x" }, { id: "b", enabled: false }] },
    "check https://example.com please"
  );

  assert.deepEqual(approval, {
    reason: "External network actions require approval before PacketChat executes them.",
    inputPreview: "check https://example.com please",
    openApiActions: [{ id: "a", name: "Lookup", method: "POST", url: "https://api.example/x" }],
    urlFetch: true
  });
});

test("publicRunError passes provider and cancellation messages through and hides the rest", () => {
  assert.equal(publicRunError(new Error("Provider account not found or is not available to this user.")), "Provider account not found or is not available to this user.");
  assert.equal(publicRunError(new Error("Agent run cancelled")), "Agent run cancelled");
  assert.equal(publicRunError(new Error("ECONNREFUSED 10.0.0.4:5432")), "Agent run failed. Check server logs or provider account settings for details.");
});

test("runFailureStatus maps the message to the run status", () => {
  assert.equal(runFailureStatus("Agent run cancelled"), "cancelled");
  assert.equal(runFailureStatus("Request timed out"), "timed_out");
  assert.equal(runFailureStatus("Agent run failed. Check server logs."), "failed");
});

test("renderTemplate substitutes every occurrence and tolerates an absent template", () => {
  assert.equal(renderTemplate("q={{input}}&again={{input}}", { input: "hi" }), "q=hi&again=hi");
  assert.equal(renderTemplate(undefined, { input: "hi" }), "");
});

test("termsFor and snippetFor centre the excerpt on the first matching term", () => {
  assert.deepEqual(termsFor("Deploy the WORKER_2 now"), ["deploy", "the", "worker_2", "now"]);
  const content = `${"a".repeat(400)} needle ${"b".repeat(400)}`;
  const snippet = snippetFor(content, ["needle"]);
  assert.ok(snippet.startsWith("..."));
  assert.ok(snippet.includes("needle"));
  assert.ok(snippet.endsWith("..."));
});

test("artifactInstructions is empty when disabled and verbatim in custom prompt mode", () => {
  assert.equal(artifactInstructions({}), "");
  assert.equal(artifactInstructions({ artifacts: { enabled: false, instructions: "ignored" } }), "");
  assert.equal(artifactInstructions({ artifacts: { enabled: true, customPromptMode: true, instructions: " mine " } }), "mine");
  const standard = artifactInstructions({ artifacts: { enabled: true, instructions: "also svg" } });
  assert.ok(standard.startsWith("When creating content that should be displayed as an artifact"));
  assert.ok(standard.endsWith("Additional artifact guidance:\nalso svg"));
});
