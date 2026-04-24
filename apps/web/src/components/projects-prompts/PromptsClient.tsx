"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiClient, type Prompt } from "../../lib/api-client";
import { ConfirmButton, EmptyState, ErrorState, LoadingBlock, useToast } from "../ui";

type PromptDraft = {
  name: string;
  description: string;
  variables: string;
  body: string;
};

const emptyDraft: PromptDraft = { name: "", description: "", variables: "", body: "" };

function draftFromPrompt(prompt: Prompt): PromptDraft {
  return {
    name: prompt.name,
    description: prompt.description ?? "",
    variables: prompt.variables.join(", "),
    body: prompt.body
  };
}

function variableList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function PromptsClient() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PromptDraft>(emptyDraft);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const toast = useToast();

  const selectedPrompt = useMemo(() => prompts.find((prompt) => prompt.id === selectedPromptId) ?? null, [prompts, selectedPromptId]);
  const filteredPrompts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return prompts;
    return prompts.filter((prompt) => [prompt.name, prompt.description, prompt.body, prompt.variables.join(" ")].some((value) => value?.toLowerCase().includes(needle)));
  }, [prompts, query]);
  const variables = variableList(draft.variables);

  async function loadPrompts() {
    setError(null);
    const data = await apiClient.prompts.list();
    setPrompts(data.prompts ?? []);
  }

  useEffect(() => {
    loadPrompts()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  function startCreate() {
    setSelectedPromptId(null);
    setDraft(emptyDraft);
  }

  function selectPrompt(prompt: Prompt) {
    setSelectedPromptId(prompt.id);
    setDraft(draftFromPrompt(prompt));
  }

  async function savePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const name = draft.name.trim();
    const body = draft.body.trim();
    if (!name || !body) {
      setError("Prompt name and body are required.");
      return;
    }

    setSaving(true);
    try {
      if (selectedPrompt) {
        const data = await apiClient.prompts.update(selectedPrompt.id, {
          name,
          description: draft.description.trim() || null,
          body,
          variables
        });
        setPrompts((current) => current.map((item) => (item.id === selectedPrompt.id ? data.prompt : item)));
        setDraft(draftFromPrompt(data.prompt));
        toast({ title: "Prompt updated", message: data.prompt.name, variant: "success" });
      } else {
        const data = await apiClient.prompts.create({
          name,
          description: draft.description.trim(),
          body,
          variables
        });
        setPrompts((current) => [data.prompt, ...current]);
        setSelectedPromptId(data.prompt.id);
        setDraft(draftFromPrompt(data.prompt));
        toast({ title: "Prompt created", message: data.prompt.name, variant: "success" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Prompt save failed", message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function deletePrompt(prompt: Prompt) {
    setDeletingId(prompt.id);
    setError(null);
    try {
      await apiClient.prompts.delete(prompt.id);
      setPrompts((current) => current.filter((item) => item.id !== prompt.id));
      if (selectedPromptId === prompt.id) startCreate();
      toast({ title: "Prompt deleted", message: prompt.name, variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Prompt delete failed", message, variant: "error" });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="projects-prompts-page">
      <div className="card card--hero projects-prompts-hero">
        <div>
          <div className="eyebrow">Prompts</div>
          <h1>Private prompt library</h1>
          <p className="muted">Draft reusable instructions, track variables, and prepare prompts for chat insertion.</p>
        </div>
        <button className="button" type="button" onClick={startCreate}>New prompt</button>
      </div>

      {error ? <ErrorState message={error} onRetry={() => void loadPrompts()} /> : null}

      <div className="projects-prompts-layout projects-prompts-layout--wide">
        <aside className="card projects-prompts-sidebar" aria-label="Prompt library">
          <label>
            Search prompts
            <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, body, variables" />
          </label>

          {loading ? <LoadingBlock title="Loading prompts" /> : null}
          {!loading && filteredPrompts.length === 0 ? <EmptyState title="No prompts found" description="Create a template to start versioning reusable instructions." /> : null}

          <div className="projects-prompts-list">
            {filteredPrompts.map((prompt) => (
              <button className="projects-prompts-list-item" key={prompt.id} type="button" aria-pressed={prompt.id === selectedPromptId} onClick={() => selectPrompt(prompt)}>
                <strong>{prompt.name}</strong>
                <span>Version {prompt.latest_version_number ?? 1}</span>
                <span className="projects-prompts-chip-row" aria-label="Variables">
                  {prompt.variables.length ? prompt.variables.slice(0, 4).map((variable) => <span className="projects-prompts-chip" key={variable}>{variable}</span>) : <span className="muted">No variables</span>}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="card projects-prompts-editor" aria-label={selectedPrompt ? "Edit prompt" : "Create prompt"}>
          <div className="panel-title">
            <div>
              <div className="eyebrow">{selectedPrompt ? "Edit" : "Create"}</div>
              <h2>{selectedPrompt ? selectedPrompt.name : "New prompt"}</h2>
              <p className="muted">Changing body or variables creates a new prompt version.</p>
            </div>
            {selectedPrompt ? (
              <ConfirmButton className="button button--danger" message="Delete this prompt?" confirmLabel="Delete" disabled={deletingId === selectedPrompt.id} onConfirm={() => deletePrompt(selectedPrompt)}>
                Delete
              </ConfirmButton>
            ) : null}
          </div>

          <form className="projects-prompts-form" onSubmit={(event) => void savePrompt(event)}>
            <label>
              Name
              <input className="input" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required />
            </label>
            <label>
              Variables
              <input className="input" value={draft.variables} onChange={(event) => setDraft((current) => ({ ...current, variables: event.target.value }))} placeholder="topic, audience" />
            </label>
            <label>
              Description
              <input className="input" value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
            </label>
            <label>
              Body
              <textarea value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} required rows={10} />
            </label>
            <div className="projects-prompts-actions">
              <button className="button" disabled={saving} type="submit">{saving ? "Saving..." : selectedPrompt ? "Save prompt" : "Create prompt"}</button>
              {selectedPrompt ? <button className="button button--ghost" type="button" onClick={startCreate}>Clear selection</button> : null}
            </div>
          </form>
        </section>

        <aside className="card projects-prompts-preview" aria-label="Prompt preview">
          <div>
            <div className="eyebrow">Preview</div>
            <h2>{draft.name || "Untitled prompt"}</h2>
            {draft.description ? <p className="muted">{draft.description}</p> : null}
          </div>
          <div className="projects-prompts-chip-row">
            {variables.length ? variables.map((variable) => <span className="projects-prompts-chip" key={variable}>{variable}</span>) : <span className="muted">No variables configured</span>}
          </div>
          <pre className="projects-prompts-preview-body">{draft.body || "Prompt body preview appears here."}</pre>
        </aside>
      </div>
    </section>
  );
}
