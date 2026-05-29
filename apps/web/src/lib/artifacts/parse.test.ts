import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArtifacts } from "./parse";

test("parses a single well-formed artifact block", () => {
  const text = [
    "Here is a diagram:",
    ":::artifact{identifier=\"chart-1\" type=\"application/vnd.mermaid\" title=\"Flow\"}",
    "graph TD;",
    "A-->B;",
    ":::",
    "Thanks."
  ].join("\n");

  const result = parseArtifacts(text);

  assert.equal(result.malformed, 0);
  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(result.artifacts[0], {
    identifier: "chart-1",
    type: "application/vnd.mermaid",
    title: "Flow",
    content: "graph TD;\nA-->B;"
  });
  assert.equal(result.strippedText, "Here is a diagram:\nThanks.");
});

test("parses multiple blocks with prose between them", () => {
  const text = [
    "First:",
    ":::artifact{identifier=\"a\" type=\"text/plain\"}",
    "alpha",
    ":::",
    "Middle prose.",
    ":::artifact{identifier=\"b\" type=\"text/plain\" title=\"Bee\"}",
    "beta",
    ":::",
    "Done."
  ].join("\n");

  const result = parseArtifacts(text);

  assert.equal(result.malformed, 0);
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.artifacts[0].identifier, "a");
  assert.equal(result.artifacts[0].title, undefined);
  assert.equal(result.artifacts[0].content, "alpha");
  assert.equal(result.artifacts[1].identifier, "b");
  assert.equal(result.artifacts[1].title, "Bee");
  assert.equal(result.artifacts[1].content, "beta");
  assert.equal(result.strippedText, "First:\nMiddle prose.\nDone.");
});

test("missing identifier marks block malformed and leaves it untouched", () => {
  const text = [
    "Before.",
    ":::artifact{type=\"text/plain\" title=\"No id\"}",
    "content",
    ":::",
    "After."
  ].join("\n");

  const result = parseArtifacts(text);

  assert.equal(result.malformed, 1);
  assert.equal(result.artifacts.length, 0);
  assert.ok(result.strippedText.includes(":::artifact{type=\"text/plain\" title=\"No id\"}"));
  assert.ok(result.strippedText.includes("content"));
});

test("unterminated fence is malformed and left in stripped text", () => {
  const text = [
    "Intro.",
    ":::artifact{identifier=\"x\" type=\"text/plain\"}",
    "dangling content"
  ].join("\n");

  const result = parseArtifacts(text);

  assert.equal(result.malformed, 1);
  assert.equal(result.artifacts.length, 0);
  assert.ok(result.strippedText.includes(":::artifact{identifier=\"x\" type=\"text/plain\"}"));
  assert.ok(result.strippedText.includes("dangling content"));
});

test("attribute order is independent", () => {
  const text = [
    ":::artifact{title=\"T\" type=\"text/plain\" identifier=\"z\"}",
    "body",
    ":::"
  ].join("\n");

  const result = parseArtifacts(text);

  assert.equal(result.malformed, 0);
  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(result.artifacts[0], {
    identifier: "z",
    type: "text/plain",
    title: "T",
    content: "body"
  });
});

test("collapses blank gaps left by a removed block", () => {
  const text = [
    "Intro paragraph.",
    "",
    ":::artifact{identifier=\"g\" type=\"text/plain\"}",
    "gamma",
    ":::",
    "",
    "Outro paragraph."
  ].join("\n");

  const result = parseArtifacts(text);

  assert.equal(result.malformed, 0);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.strippedText, "Intro paragraph.\n\nOutro paragraph.");
});

test("content with internal colons and backticks does not break parsing", () => {
  const text = [
    "Look:",
    ":::artifact{identifier=\"code-1\" type=\"text/markdown\"}",
    "```ts",
    "const x: number = 1; // ratio 3:2",
    "// not a fence: ::: in the middle of text",
    "```",
    ":::",
    "End."
  ].join("\n");

  const result = parseArtifacts(text);

  assert.equal(result.malformed, 0);
  assert.equal(result.artifacts.length, 1);
  assert.equal(
    result.artifacts[0].content,
    "```ts\nconst x: number = 1; // ratio 3:2\n// not a fence: ::: in the middle of text\n```"
  );
  assert.equal(result.strippedText, "Look:\nEnd.");
});
