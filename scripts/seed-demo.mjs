#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const envFile = process.env.PACKETCHAT_ENV_FILE || ".env";
const seedKey = "ui-redesign-demo-v1";

function loadEnv(path) {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      if (process.env[key] !== undefined) continue;
      process.env[key] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Environment variables may already be provided by the shell or Compose.
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const embeddingDimensions = 128;
const embeddingModel = "packetchat-local-hash";
const embeddingSchemaVersion = 2;
const embeddingVersion = `${embeddingModel}-v${embeddingSchemaVersion}`;

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function createLocalEmbedding(text) {
  const vector = Array.from({ length: embeddingDimensions }, () => 0);
  const terms = text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];

  for (const term of terms) {
    const hash = fnv1a(term);
    const index = hash % embeddingDimensions;
    const sign = hash & 0x80000000 ? -1 : 1;
    vector[index] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude > 0) {
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = Number((vector[index] / magnitude).toFixed(6));
    }
  }

  return {
    schemaVersion: embeddingSchemaVersion,
    model: embeddingModel,
    version: embeddingVersion,
    dimensions: embeddingDimensions,
    vector,
    normalized: true,
    createdAt: "1970-01-01T00:00:00.000Z"
  };
}

function textContent(text) {
  return [{ type: "text", text }];
}

async function getAdminUser(sql) {
  const email = process.env.PACKETCHAT_DEMO_ADMIN_EMAIL || process.env.DEMO_ADMIN_EMAIL || "";
  const rows = email
    ? await sql`select id, email, display_name from users where lower(email) = lower(${email}) and role = 'admin' and status = 'active' limit 1`
    : await sql`select id, email, display_name from users where role = 'admin' and status = 'active' order by created_at asc limit 1`;

  if (!rows[0]) {
    const hint = email ? `No active admin user found for ${email}.` : "No active admin user found.";
    throw new Error(`${hint} Bootstrap an admin first, or set PACKETCHAT_DEMO_ADMIN_EMAIL.`);
  }

  return rows[0];
}

async function ensureProject(tx, ownerId, input) {
  const existing = await tx`select id from projects where owner_user_id = ${ownerId} and name = ${input.name} limit 1`;
  if (existing[0]) {
    await tx`
      update projects
      set description = ${input.description}, instructions = ${input.instructions}, updated_at = now()
      where id = ${existing[0].id}
    `;
    return existing[0].id;
  }

  const rows = await tx`
    insert into projects (owner_user_id, name, description, instructions)
    values (${ownerId}, ${input.name}, ${input.description}, ${input.instructions})
    returning id
  `;
  return rows[0].id;
}

async function ensurePrompt(tx, ownerId, input) {
  const variablesJson = JSON.stringify(input.variables);
  const existing = await tx`select id from prompt_templates where owner_user_id = ${ownerId} and name = ${input.name} limit 1`;
  const templateId = existing[0]?.id;

  if (templateId) {
    await tx`
      update prompt_templates
      set description = ${input.description}, body = ${input.body}, variables = ${variablesJson}::jsonb, updated_at = now()
      where id = ${templateId}
    `;
  } else {
    const rows = await tx`
      insert into prompt_templates (owner_user_id, name, description, body, variables)
      values (${ownerId}, ${input.name}, ${input.description}, ${input.body}, ${variablesJson}::jsonb)
      returning id
    `;
    const newTemplateId = rows[0].id;
    await tx`
      insert into prompt_versions (prompt_template_id, version_number, body, variables, change_summary)
      values (${newTemplateId}, 1, ${input.body}, ${variablesJson}::jsonb, 'Demo seed initial version')
    `;
    return newTemplateId;
  }

  const version = await tx`select id from prompt_versions where prompt_template_id = ${templateId} and version_number = 1 limit 1`;
  if (version[0]) {
    await tx`
      update prompt_versions
      set body = ${input.body}, variables = ${variablesJson}::jsonb, change_summary = 'Demo seed initial version'
      where id = ${version[0].id}
    `;
  } else {
    await tx`
      insert into prompt_versions (prompt_template_id, version_number, body, variables, change_summary)
      values (${templateId}, 1, ${input.body}, ${variablesJson}::jsonb, 'Demo seed initial version')
    `;
  }

  return templateId;
}

async function ensureConversation(tx, ownerId, projectId, input) {
  const existing = await tx`select id from conversations where owner_user_id = ${ownerId} and title = ${input.title} limit 1`;
  const conversationId = existing[0]?.id ?? (await tx`
    insert into conversations (owner_user_id, project_id, title, mode, temporary)
    values (${ownerId}, ${projectId}, ${input.title}, 'chat', false)
    returning id
  `)[0].id;

  await tx`
    update conversations
    set project_id = ${projectId}, archived_at = null, updated_at = now()
    where id = ${conversationId}
  `;

  for (const [index, message] of input.messages.entries()) {
    const metadata = { seedKey, seedMessageKey: `${input.key}:${index}` };
    const found = await tx`
      select id from messages
      where conversation_id = ${conversationId}
        and owner_user_id = ${ownerId}
        and metadata ->> 'seedMessageKey' = ${metadata.seedMessageKey}
      limit 1
    `;
    if (found[0]) {
      await tx`
        update messages
        set role = ${message.role}, content = ${JSON.stringify(textContent(message.text))}::jsonb, metadata = ${JSON.stringify(metadata)}::jsonb
        where id = ${found[0].id}
      `;
    } else {
      await tx`
        insert into messages (conversation_id, owner_user_id, role, content, metadata)
        values (${conversationId}, ${ownerId}, ${message.role}, ${JSON.stringify(textContent(message.text))}::jsonb, ${JSON.stringify(metadata)}::jsonb)
      `;
    }
  }

  return conversationId;
}

async function ensureKnowledge(tx, ownerId) {
  const retrievalDefaults = JSON.stringify({ limit: 5, seedKey });
  const kbName = "Demo: PacketChat Product Knowledge";
  const existingKb = await tx`select id from knowledge_bases where owner_user_id = ${ownerId} and name = ${kbName} limit 1`;
  const knowledgeBaseId = existingKb[0]?.id ?? (await tx`
    insert into knowledge_bases (owner_user_id, name, description, retrieval_defaults)
    values (${ownerId}, ${kbName}, 'Seeded knowledge base for local UI redesign walkthroughs.', ${retrievalDefaults}::jsonb)
    returning id
  `)[0].id;

  await tx`
    update knowledge_bases
    set description = 'Seeded knowledge base for local UI redesign walkthroughs.', status = 'active', retrieval_defaults = ${retrievalDefaults}::jsonb, updated_at = now()
    where id = ${knowledgeBaseId}
  `;

  const documentTitle = "Demo Product Brief.md";
  const sourceMetadata = { seedKey, source: "scripts/seed-demo.mjs", nonDestructive: true };
  const existingDoc = await tx`
    select id from knowledge_documents
    where knowledge_base_id = ${knowledgeBaseId} and owner_user_id = ${ownerId} and title = ${documentTitle}
    limit 1
  `;
  const documentId = existingDoc[0]?.id ?? (await tx`
    insert into knowledge_documents (knowledge_base_id, owner_user_id, title, mime_type, ingest_status, source_metadata)
    values (${knowledgeBaseId}, ${ownerId}, ${documentTitle}, 'text/markdown', 'ready', ${JSON.stringify(sourceMetadata)}::jsonb)
    returning id
  `)[0].id;

  await tx`
    update knowledge_documents
    set mime_type = 'text/markdown', ingest_status = 'ready', source_metadata = ${JSON.stringify(sourceMetadata)}::jsonb, updated_at = now()
    where id = ${documentId}
  `;

  const chunks = [
    "PacketChat helps teams compare model providers, manage conversations, and keep projects organized around repeatable prompts.",
    "The knowledge workspace supports local text ingestion, deterministic local embeddings, lexical search, semantic ranking, and citations without external API keys.",
    "Agents can bind to knowledge bases, keep editable drafts, publish immutable versions, and expose future run history for operators.",
    "A UI redesign demo should show populated navigation counts, recent chats, project instructions, prompt variables, documents, and an active agent."
  ];

  for (const [index, content] of chunks.entries()) {
    const metadata = { seedKey, topic: ["overview", "knowledge", "agents", "redesign"][index] };
    await tx`
      insert into knowledge_chunks (document_id, owner_user_id, chunk_index, content, token_count, embedding, metadata)
      values (${documentId}, ${ownerId}, ${index}, ${content}, ${content.split(/\s+/).length}, ${JSON.stringify(createLocalEmbedding(content))}::jsonb, ${JSON.stringify(metadata)}::jsonb)
      on conflict (document_id, chunk_index) do update set
        content = excluded.content,
        token_count = excluded.token_count,
        embedding = excluded.embedding,
        metadata = excluded.metadata
    `;
  }

  return knowledgeBaseId;
}

async function ensureAgent(tx, ownerId, knowledgeBaseId) {
  const name = "Demo: Support Triage Agent";
  const description = "Routes product questions to seeded knowledge and drafts concise responses.";
  const spec = {
    name,
    description,
    instructions: "Use the PacketChat product knowledge base first. Answer with concise next steps and cite the relevant demo source when useful.",
    temperature: 0.4,
    maxOutputTokens: 900,
    knowledgeBaseIds: [knowledgeBaseId],
    knowledgeLimit: 5,
    tools: {
      knowledgeSearch: true,
      calculator: false,
      urlFetch: false
    }
  };
  const editorState = { seedKey, layout: "demo-default" };

  const existing = await tx`select id, current_draft_id, published_version_id from agents where owner_user_id = ${ownerId} and name = ${name} limit 1`;
  const agentId = existing[0]?.id ?? (await tx`
    insert into agents (owner_user_id, name, description, status)
    values (${ownerId}, ${name}, ${description}, 'draft')
    returning id
  `)[0].id;

  let draftId = existing[0]?.current_draft_id;
  if (!draftId) {
    draftId = (await tx`
      insert into agent_drafts (agent_id, owner_user_id, spec, editor_state)
      values (${agentId}, ${ownerId}, ${JSON.stringify(spec)}::jsonb, ${JSON.stringify(editorState)}::jsonb)
      returning id
    `)[0].id;
  } else {
    await tx`
      update agent_drafts
      set
        revision = case when spec is distinct from ${JSON.stringify(spec)}::jsonb then revision + 1 else revision end,
        spec = ${JSON.stringify(spec)}::jsonb,
        editor_state = ${JSON.stringify(editorState)}::jsonb,
        updated_at = now()
      where id = ${draftId}
    `;
  }

  await tx`
    update agents
    set description = ${description}, current_draft_id = ${draftId}, updated_at = now()
    where id = ${agentId}
  `;
  await tx`
    insert into agent_permissions (agent_id, subject_user_id, role)
    values (${agentId}, ${ownerId}, 'owner')
    on conflict (agent_id, subject_user_id) do update set role = excluded.role
  `;

  const draftBinding = await tx`
    select id from agent_knowledge_bindings
    where agent_draft_id = ${draftId} and knowledge_base_id = ${knowledgeBaseId}
    limit 1
  `;
  if (!draftBinding[0]) {
    await tx`
      insert into agent_knowledge_bindings (agent_draft_id, knowledge_base_id, binding_config, retrieval_override)
      values (${draftId}, ${knowledgeBaseId}, ${JSON.stringify({ seedKey })}::jsonb, ${JSON.stringify({ limit: 5 })}::jsonb)
    `;
  }

  const manifest = { spec };
  const contentHash = createHash("sha256").update(stableJson(manifest)).digest("hex");
  const matchingVersion = await tx`
    select id from agent_versions
    where agent_id = ${agentId} and owner_user_id = ${ownerId} and content_hash = ${contentHash}
    order by version_number desc
    limit 1
  `;
  let versionId = matchingVersion[0]?.id;

  if (!versionId) {
    const nextVersion = await tx`select coalesce(max(version_number), 0) + 1 as version_number from agent_versions where agent_id = ${agentId}`;
    versionId = (await tx`
      insert into agent_versions (agent_id, owner_user_id, version_number, spec, manifest, content_hash, change_summary)
      values (${agentId}, ${ownerId}, ${nextVersion[0].version_number}, ${JSON.stringify(spec)}::jsonb, ${JSON.stringify(manifest)}::jsonb, ${contentHash}, 'Demo seed published version')
      returning id
    `)[0].id;
    await tx`
      insert into agent_knowledge_bindings (agent_version_id, knowledge_base_id, binding_config, retrieval_override)
      values (${versionId}, ${knowledgeBaseId}, ${JSON.stringify({ seedKey })}::jsonb, ${JSON.stringify({ limit: 5 })}::jsonb)
    `;
  }

  await tx`
    update agents
    set status = 'active', published_version_id = ${versionId}, updated_at = now()
    where id = ${agentId}
  `;

  return agentId;
}

async function main() {
  loadEnv(envFile);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Start Postgres and configure .env first.");

  const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });

  try {
    const admin = await getAdminUser(sql);
    const summary = await sql.begin(async (tx) => {
      const onboardingProjectId = await ensureProject(tx, admin.id, {
        name: "Demo: Launch Readiness",
        description: "A populated project for reviewing the redesigned project and chat surfaces.",
        instructions: "Prioritize launch blockers, summarize provider dependencies, and keep responses action-oriented."
      });
      const supportProjectId = await ensureProject(tx, admin.id, {
        name: "Demo: Customer Support Workspace",
        description: "Example workspace with support tone, knowledge, and agent flows.",
        instructions: "Use a helpful support tone and include clear escalation criteria."
      });

      const promptIds = [];
      for (const prompt of [
        {
          name: "Demo: Release Risk Summary",
          description: "Summarize release risks for a PacketChat rollout.",
          body: "Review {{release_notes}} and return the top risks, owners, and a go/no-go recommendation.",
          variables: ["release_notes"]
        },
        {
          name: "Demo: Knowledge Answer",
          description: "Answer with citations from the local knowledge base.",
          body: "Using the provided context, answer {{question}} in three bullets and include citations when available.",
          variables: ["question"]
        },
        {
          name: "Demo: Support Handoff",
          description: "Create a concise internal support handoff.",
          body: "Turn this conversation into a handoff with customer goal, current blocker, attempted fixes, and next action: {{conversation}}",
          variables: ["conversation"]
        }
      ]) {
        promptIds.push(await ensurePrompt(tx, admin.id, prompt));
      }

      const conversationIds = [];
      conversationIds.push(await ensureConversation(tx, admin.id, onboardingProjectId, {
        key: "launch-readiness",
        title: "Demo: Launch readiness review",
        messages: [
          { role: "system", text: "Project context: focus on UI redesign readiness and local demo data completeness." },
          { role: "user", text: "What should we verify before sharing the redesigned workspace?" },
          { role: "assistant", text: "Verify populated projects, prompts, chat history, knowledge search, and the active support triage agent. No provider key is required for this walkthrough." }
        ]
      }));
      conversationIds.push(await ensureConversation(tx, admin.id, supportProjectId, {
        key: "support-triage",
        title: "Demo: Support triage with knowledge",
        messages: [
          { role: "user", text: "A teammate cannot find citations in knowledge search. What local checks should they run?" },
          { role: "assistant", text: "Confirm the demo knowledge document is ready, search for PacketChat or citations, and verify chunks include current local embeddings." }
        ]
      }));

      const knowledgeBaseId = await ensureKnowledge(tx, admin.id);
      const agentId = await ensureAgent(tx, admin.id, knowledgeBaseId);

      return {
        adminEmail: admin.email,
        projects: [onboardingProjectId, supportProjectId],
        prompts: promptIds,
        conversations: conversationIds,
        knowledgeBase: knowledgeBaseId,
        agent: agentId
      };
    });

    console.log(`Seeded demo data for ${summary.adminEmail}`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
