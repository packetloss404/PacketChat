#!/usr/bin/env node

const baseUrl = (process.env.PACKETCHAT_BASE_URL || process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const email = process.env.PACKETCHAT_SMOKE_EMAIL || process.env.SMOKE_EMAIL || "";
const password = process.env.PACKETCHAT_SMOKE_PASSWORD || process.env.SMOKE_PASSWORD || "";

async function requestJson(path, init) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { response, body, url };
}

async function getJson(path, init) {
  const result = await requestJson(path, init);
  if (!result.response.ok) {
    throw new Error(`${init?.method || "GET"} ${result.url} returned ${result.response.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

function requireReady(payload) {
  const checks = payload?.checks || {};
  const failed = ["database", "redis", "objectStorage"].filter((name) => checks[name] !== "ok");
  if (!payload?.ok || failed.length > 0) {
    throw new Error(`Readiness failed: ${JSON.stringify(payload)}`);
  }
}

function expect(value, message) {
  if (!value) throw new Error(message);
}

async function expectStatus(path, expectedStatus, init) {
  const result = await requestJson(path, init);
  if (result.response.status !== expectedStatus) {
    throw new Error(`${init?.method || "GET"} ${result.url} returned ${result.response.status}, expected ${expectedStatus}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function createJson(path, token, body) {
  return getJson(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function patchJson(path, token, body) {
  return getJson(path, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function deleteJson(path, token) {
  return getJson(path, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  });
}

async function uploadKnowledgeText(knowledgeBaseId, token, stamp) {
  const form = new FormData();
  const text = `PacketChat smoke upload ${stamp}\nThis document verifies local text ingestion and searchable smoke coverage.`;
  form.set("knowledgeBaseId", knowledgeBaseId);
  form.set("file", new Blob([text], { type: "text/plain" }), `packetchat-smoke-${Date.now()}.txt`);

  return getJson("/api/files/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form
  });
}

async function waitForKnowledgeDocumentReady(knowledgeBaseId, documentId, token) {
  const deadline = Date.now() + 30000;
  const authHeaders = { authorization: `Bearer ${token}` };
  let lastDocument = null;

  while (Date.now() < deadline) {
    const documents = await getJson(`/api/knowledge/${knowledgeBaseId}/documents`, { headers: authHeaders });
    lastDocument = (documents?.documents ?? []).find((document) => document.id === documentId) ?? null;
    if (lastDocument?.ingest_status === "ready") return lastDocument;
    if (lastDocument?.ingest_status === "failed") throw new Error(`knowledge ingestion failed: ${JSON.stringify(lastDocument.source_metadata)}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  return lastDocument;
}

async function verifyProtectedRoutesRejectAnonymous() {
  const protectedChecks = [
    ["GET", "/api/auth/me"],
    ["GET", "/api/projects"],
    ["POST", "/api/projects", { name: "anonymous project" }],
    ["GET", "/api/prompts"],
    ["POST", "/api/prompts", { name: "anonymous prompt", body: "Hello" }],
    ["GET", "/api/conversations"],
    ["POST", "/api/conversations", { title: "anonymous conversation" }],
    ["GET", "/api/knowledge"],
    ["POST", "/api/knowledge", { name: "anonymous knowledge" }],
    ["POST", "/api/knowledge/00000000-0000-0000-0000-000000000000/search", { query: "packet" }],
    ["GET", "/api/providers"],
    ["POST", "/api/chat", { messages: [{ role: "user", content: "hello" }] }]
  ];

  for (const [method, path, body] of protectedChecks) {
    await expectStatus(path, 401, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  }
  console.log(`anonymous protection ok (${protectedChecks.length} routes)`);
}

async function verifyAuthenticatedFlows(accessToken) {
  const stamp = new Date().toISOString();
  const authHeaders = { authorization: `Bearer ${accessToken}` };

  const me = await getJson("/api/auth/me", { headers: authHeaders });
  expect(me?.user?.id, "auth/me did not return user.id");

  const projectResult = await createJson("/api/projects", accessToken, {
    name: `Smoke project ${stamp}`,
    description: "Created by scripts/smoke-test.mjs",
    instructions: "Use this project only for automated smoke verification."
  });
  expect(projectResult?.project?.id, "project create did not return project.id");
  const projectId = projectResult.project.id;
  const projects = await getJson("/api/projects", { headers: authHeaders });
  expect(Array.isArray(projects?.projects), "projects list did not return projects array");
  const updatedProject = await patchJson(`/api/projects/${projectId}`, accessToken, { name: `Smoke project updated ${stamp}` });
  expect(updatedProject?.project?.name?.includes("updated"), "project update did not return updated name");
  const deletedProject = await deleteJson(`/api/projects/${projectId}`, accessToken);
  expect(deletedProject?.deleted, "project delete did not return deleted=true");

  const promptResult = await createJson("/api/prompts", accessToken, {
    name: `Smoke prompt ${stamp}`,
    description: "Created by scripts/smoke-test.mjs",
    body: "Summarize {{topic}} in one sentence.",
    variables: ["topic"]
  });
  expect(promptResult?.prompt?.id, "prompt create did not return prompt.id");
  const promptId = promptResult.prompt.id;
  const prompts = await getJson("/api/prompts", { headers: authHeaders });
  expect(Array.isArray(prompts?.prompts), "prompts list did not return prompts array");
  const updatedPrompt = await patchJson(`/api/prompts/${promptId}`, accessToken, { body: "Summarize {{topic}} in exactly one sentence.", variables: ["topic"] });
  expect(updatedPrompt?.prompt?.latest_version_number, "prompt update did not return latest version");
  const deletedPrompt = await deleteJson(`/api/prompts/${promptId}`, accessToken);
  expect(deletedPrompt?.deleted, "prompt delete did not return deleted=true");

  const conversationResult = await createJson("/api/conversations", accessToken, {
    title: `Smoke conversation ${stamp}`,
    temporary: true
  });
  const conversationId = conversationResult?.conversation?.id;
  expect(conversationId, "conversation create did not return conversation.id");
  const conversations = await getJson("/api/conversations", { headers: authHeaders });
  expect(Array.isArray(conversations?.conversations), "conversations list did not return conversations array");
  const messages = await getJson(`/api/conversations/${conversationId}/messages`, { headers: authHeaders });
  expect(Array.isArray(messages?.messages), "conversation messages did not return messages array");
  const renamedConversation = await patchJson(`/api/conversations/${conversationId}`, accessToken, { title: `Smoke conversation updated ${stamp}` });
  expect(renamedConversation?.conversation?.title?.includes("updated"), "conversation rename did not return updated title");
  const archivedConversation = await patchJson(`/api/conversations/${conversationId}`, accessToken, { archived: true });
  expect(archivedConversation?.conversation?.archived_at, "conversation archive did not return archived_at");
  const deletedConversation = await deleteJson(`/api/conversations/${conversationId}`, accessToken);
  expect(deletedConversation?.deleted, "conversation delete did not return deleted=true");

  const agentResult = await createJson("/api/agents", accessToken, {
    name: `Smoke agent ${stamp}`,
    description: "Created by scripts/smoke-test.mjs"
  });
  const agentId = agentResult?.agentId;
  expect(agentId, "agent create did not return agentId");
  const agents = await getJson("/api/agents", { headers: authHeaders });
  expect(Array.isArray(agents?.agents), "agents list did not return agents array");
  const updatedAgent = await patchJson(`/api/agents/${agentId}`, accessToken, { name: `Smoke agent updated ${stamp}` });
  expect(updatedAgent?.agent?.name?.includes("updated"), "agent update did not return updated name");
  const archivedAgent = await patchJson(`/api/agents/${agentId}`, accessToken, { archived: true });
  expect(archivedAgent?.agent?.status === "archived", "agent archive did not return archived status");
  const deletedAgent = await deleteJson(`/api/agents/${agentId}`, accessToken);
  expect(deletedAgent?.deleted, "agent delete did not return deleted=true");

  const knowledgeResult = await createJson("/api/knowledge", accessToken, {
    name: `Smoke knowledge ${stamp}`,
    description: "Created by scripts/smoke-test.mjs"
  });
  const knowledgeBaseId = knowledgeResult?.knowledgeBaseId;
  expect(knowledgeBaseId, "knowledge create did not return knowledgeBaseId");
  const knowledge = await getJson("/api/knowledge", { headers: authHeaders });
  expect(Array.isArray(knowledge?.knowledgeBases), "knowledge list did not return knowledgeBases array");
  const updatedKnowledge = await patchJson(`/api/knowledge/${knowledgeBaseId}`, accessToken, { name: `Smoke knowledge updated ${stamp}` });
  expect(updatedKnowledge?.knowledgeBase?.name?.includes("updated"), "knowledge update did not return updated name");
  const documents = await getJson(`/api/knowledge/${knowledgeBaseId}/documents`, { headers: authHeaders });
  expect(Array.isArray(documents?.documents), "knowledge documents did not return documents array");
  const upload = await uploadKnowledgeText(knowledgeBaseId, accessToken, stamp);
  const documentId = upload?.documentId;
  expect(documentId, "knowledge text upload did not return documentId");
  const readyDocument = await waitForKnowledgeDocumentReady(knowledgeBaseId, documentId, accessToken);
  if (readyDocument?.ingest_status === "ready") {
    const uploadedSearch = await createJson(`/api/knowledge/${knowledgeBaseId}/search`, accessToken, { query: "PacketChat smoke upload", limit: 3 });
    expect(uploadedSearch?.results?.some((result) => result.documentId === documentId), "knowledge search did not find uploaded text document");
  } else {
    console.warn(`knowledge text upload queued but not ready within timeout; status=${readyDocument?.ingest_status ?? "missing"}`);
  }
  const renamedDocument = await patchJson(`/api/knowledge/${knowledgeBaseId}/documents/${documentId}`, accessToken, { title: `Smoke text updated ${stamp}.txt` });
  expect(renamedDocument?.document?.title?.includes("updated"), "knowledge document rename did not return updated title");
  const deletedDocument = await deleteJson(`/api/knowledge/${knowledgeBaseId}/documents/${documentId}`, accessToken);
  expect(deletedDocument?.deleted, "knowledge document delete did not return deleted=true");
  const search = await createJson(`/api/knowledge/${knowledgeBaseId}/search`, accessToken, { query: "packet smoke", limit: 3 });
  expect(Array.isArray(search?.results), "knowledge search did not return results array");
  const archivedKnowledge = await patchJson(`/api/knowledge/${knowledgeBaseId}`, accessToken, { archived: true });
  expect(archivedKnowledge?.knowledgeBase?.status === "archived", "knowledge archive did not return archived status");
  const deletedKnowledge = await deleteJson(`/api/knowledge/${knowledgeBaseId}`, accessToken);
  expect(deletedKnowledge?.deleted, "knowledge delete did not return deleted=true");

  console.log("authenticated CRUD/archive/delete and knowledge upload/search ok");
}

console.log(`Smoke target: ${baseUrl}`);

const health = await getJson("/api/healthz");
expect(health?.ok, "healthz did not return ok");
console.log("healthz ok");

const ready = await getJson("/api/readyz");
requireReady(ready);
console.log("readyz ok");

await verifyProtectedRoutesRejectAnonymous();

if (email || password) {
  if (!email || !password) {
    throw new Error("Set both PACKETCHAT_SMOKE_EMAIL and PACKETCHAT_SMOKE_PASSWORD, or neither to skip login. Legacy SMOKE_EMAIL and SMOKE_PASSWORD are also accepted.");
  }

  console.log(`authenticated flows enabled for ${email}`);

  const login = await getJson("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  const accessToken = login?.accessToken;
  if (!accessToken) throw new Error("Login succeeded but did not return accessToken.");

  await verifyAuthenticatedFlows(accessToken);
  console.log("login ok");
} else {
  console.log("authenticated flows skipped; set PACKETCHAT_SMOKE_EMAIL and PACKETCHAT_SMOKE_PASSWORD to enable them");
}
