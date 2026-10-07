import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeLocalText,
  createLocalEmbedding,
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_VERSION,
  parseLocalEmbedding,
  rankLocalHybridResults
} from "../src/index";

test("local feature embeddings are versioned, normalized, and deterministic", () => {
  const first = createLocalEmbedding("Deploying releases safely");
  const second = createLocalEmbedding("Deploying releases safely");

  assert.equal(first.model, LOCAL_EMBEDDING_MODEL);
  assert.equal(first.version, LOCAL_EMBEDDING_VERSION);
  assert.equal(first.dimensions, LOCAL_EMBEDDING_DIMENSIONS);
  assert.deepEqual(first.vector, second.vector);
  assert.ok(Math.abs(Math.sqrt(first.vector.reduce((sum, value) => sum + value * value, 0)) - 1) < 0.00001);
  assert.deepEqual(parseLocalEmbedding(first).embedding?.vector, first.vector);
});

test("previous hash embeddings are explicitly marked outdated", () => {
  const parsed = parseLocalEmbedding({
    schemaVersion: 2,
    model: "packetchat-local-hash",
    version: "packetchat-local-hash-v2",
    dimensions: 128,
    vector: Array.from({ length: 128 }, () => 0),
    normalized: true,
    createdAt: "2026-01-01T00:00:00.000Z"
  });

  assert.equal(parsed.embedding, null);
  assert.equal(parsed.reason, "outdated");
  assert.equal(parseLocalEmbedding(Array.from({ length: 128 }, () => 0)).reason, "outdated");
});

test("malformed current embeddings are invalid rather than outdated", () => {
  const embedding = createLocalEmbedding("valid source");
  const parsed = parseLocalEmbedding({ ...embedding, vector: [Number.NaN] });

  assert.equal(parsed.embedding, null);
  assert.equal(parsed.reason, "invalid");
  assert.equal(parseLocalEmbedding({ ...embedding, normalized: false }).reason, "invalid");
});

test("analysis collapses related terms without claiming neural semantics", () => {
  const analysis = analyzeLocalText("How do login failures affect authentication errors?");

  assert.deepEqual(analysis.uniqueCanonicalTerms, ["auth", "issue", "affect"]);
});

test("hybrid ranking retrieves related concepts without exact query words", () => {
  const candidates = [
    {
      value: "relevant",
      title: "Authentication troubleshooting",
      content: "Credentials can fail after authorization expires. Renew the sign-in session.",
      embedding: createLocalEmbedding("Credentials can fail after authorization expires. Renew the sign-in session.")
    },
    {
      value: "unrelated",
      title: "Lunch menu",
      content: "The kitchen serves soup, bread, and seasonal fruit.",
      embedding: createLocalEmbedding("The kitchen serves soup, bread, and seasonal fruit.")
    }
  ];

  const ranked = rankLocalHybridResults("login errors", candidates);

  assert.equal(ranked[0]?.value, "relevant");
  assert.deepEqual(ranked[0]?.matchedTerms, ["login", "errors"]);
  assert.ok((ranked[0]?.lexicalScore ?? 0) > 0);
  assert.ok((ranked[0]?.relatednessScore ?? 0) > 0);
  assert.equal(ranked.some((result) => result.value === "unrelated"), false);
});

test("hybrid ranking rewards an ordered phrase", () => {
  const ranked = rankLocalHybridResults("reset password", [
    {
      value: "ordered",
      title: "Reset password guide",
      content: "Use the account screen.",
      embedding: createLocalEmbedding("Use the account screen.")
    },
    {
      value: "separated",
      title: "Password help",
      content: "Choose a password, then visit settings to reset account access.",
      embedding: createLocalEmbedding("Choose a password, then visit settings to reset account access.")
    }
  ]);

  assert.equal(ranked[0]?.value, "ordered");
  assert.equal(ranked[0]?.phraseScore, 1);
});
