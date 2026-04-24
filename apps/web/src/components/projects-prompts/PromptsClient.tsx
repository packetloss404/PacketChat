"use client";

import { FormEvent, useEffect, useState } from "react";
import { apiClient, type Prompt } from "../../lib/api-client";

export function PromptsClient() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function loadPrompts() {
    const data = await apiClient.prompts.list();
    setPrompts(data.prompts ?? []);
  }

  useEffect(() => {
    loadPrompts()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  async function createPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);

    try {
      const form = new FormData(event.currentTarget);
      const data = await apiClient.prompts.create({
        name: form.get("name"),
        description: form.get("description"),
        body: form.get("body"),
        variables: form.get("variables")
      });

      setPrompts((current) => [data.prompt, ...current]);
      event.currentTarget.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function updatePrompt(prompt: Prompt) {
    const name = window.prompt("Prompt name", prompt.name);
    if (name == null) return;
    const variables = window.prompt("Variables", prompt.variables.join(", "));
    if (variables == null) return;
    const description = window.prompt("Prompt description", prompt.description ?? "");
    if (description == null) return;
    const body = window.prompt("Prompt body", prompt.body);
    if (body == null) return;
    setError(null);
    try {
      const data = await apiClient.prompts.update(prompt.id, { name, description, body, variables });
      setPrompts((current) => current.map((item) => (item.id === prompt.id ? data.prompt : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deletePrompt(prompt: Prompt) {
    if (!window.confirm(`Delete prompt "${prompt.name}"?`)) return;
    setError(null);
    try {
      await apiClient.prompts.delete(prompt.id);
      setPrompts((current) => current.filter((item) => item.id !== prompt.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="card">
      <div className="eyebrow">Prompts</div>
      <h1>Private prompt library</h1>
      <p className="muted">Create prompt templates with an initial version 1.</p>

      <form className="grid" onSubmit={createPrompt} style={{ alignItems: "start", marginTop: 24 }}>
        <label>
          Name
          <input className="input" name="name" required />
        </label>
        <label>
          Variables
          <input className="input" name="variables" placeholder="topic, audience" />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>
          Description
          <input className="input" name="description" />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>
          Body
          <textarea name="body" required rows={6} />
        </label>
        <button className="button" disabled={saving} type="submit">{saving ? "Creating..." : "Create prompt"}</button>
      </form>

      {error ? <p className="error-state" role="alert">{error}</p> : null}
      {loading ? <p className="loading-state">Loading prompts...</p> : null}
      {!loading && !error && prompts.length === 0 ? <p className="empty-state">No prompts yet. Create a template to start versioning reusable instructions.</p> : null}

      <div className="grid" style={{ marginTop: 24 }}>
        {prompts.map((prompt) => (
          <article className="card" key={prompt.id}>
            <h3>{prompt.name}</h3>
            <p className="muted">Version {prompt.latest_version_number ?? 1}</p>
            {prompt.description ? <p>{prompt.description}</p> : null}
            <pre style={{ whiteSpace: "pre-wrap" }}>{prompt.body}</pre>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="button secondary" type="button" onClick={() => updatePrompt(prompt)}>Edit</button>
              <button className="button secondary" type="button" onClick={() => deletePrompt(prompt)}>Delete</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
