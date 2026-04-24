"use client";

import { FormEvent, useEffect, useState } from "react";
import { apiClient, type Project } from "../../lib/api-client";

export function ProjectsClient() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function loadProjects() {
    const data = await apiClient.projects.list();
    setProjects(data.projects ?? []);
  }

  useEffect(() => {
    loadProjects()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);

    try {
      const form = new FormData(event.currentTarget);
      const data = await apiClient.projects.create({
        name: form.get("name"),
        description: form.get("description"),
        instructions: form.get("instructions")
      });

      setProjects((current) => [data.project, ...current]);
      event.currentTarget.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function updateProject(project: Project) {
    const name = window.prompt("Project name", project.name);
    if (name == null) return;
    const description = window.prompt("Project description", project.description ?? "");
    if (description == null) return;
    const instructions = window.prompt("Project instructions", project.instructions ?? "");
    if (instructions == null) return;
    setError(null);
    try {
      const data = await apiClient.projects.update(project.id, { name, description, instructions });
      setProjects((current) => current.map((item) => (item.id === project.id ? data.project : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteProject(project: Project) {
    if (!window.confirm(`Delete project "${project.name}"?`)) return;
    setError(null);
    try {
      await apiClient.projects.delete(project.id);
      setProjects((current) => current.filter((item) => item.id !== project.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="card">
      <div className="eyebrow">Projects</div>
      <h1>User-owned project workspace</h1>
      <p className="muted">Create and list projects owned by your signed-in user.</p>

      <form className="grid" onSubmit={createProject} style={{ alignItems: "start", marginTop: 24 }}>
        <label>
          Name
          <input className="input" name="name" required />
        </label>
        <label>
          Description
          <input className="input" name="description" />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>
          Instructions
          <textarea name="instructions" rows={4} />
        </label>
        <button className="button" disabled={saving} type="submit">{saving ? "Creating..." : "Create project"}</button>
      </form>

      {error ? <p className="error-state" role="alert">{error}</p> : null}
      {loading ? <p className="loading-state">Loading projects...</p> : null}
      {!loading && !error && projects.length === 0 ? <p className="empty-state">No projects yet. Create one to keep instructions and workspace context together.</p> : null}

      <div className="grid" style={{ marginTop: 24 }}>
        {projects.map((project) => (
          <article className="card" key={project.id}>
            <h3>{project.name}</h3>
            {project.description ? <p>{project.description}</p> : null}
            {project.instructions ? <p className="muted">{project.instructions}</p> : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="button secondary" type="button" onClick={() => updateProject(project)}>Edit</button>
              <button className="button secondary" type="button" onClick={() => deleteProject(project)}>Delete</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
