"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiClient, type Project } from "../../lib/api-client";
import { ConfirmButton, EmptyState, ErrorState, LoadingBlock, useToast } from "../ui";

type ProjectDraft = {
  name: string;
  description: string;
  instructions: string;
};

const emptyDraft: ProjectDraft = { name: "", description: "", instructions: "" };

function draftFromProject(project: Project): ProjectDraft {
  return {
    name: project.name,
    description: project.description ?? "",
    instructions: project.instructions ?? ""
  };
}

export function ProjectsClient() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectDraft>(emptyDraft);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const toast = useToast();

  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) ?? null, [projects, selectedProjectId]);
  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) => [project.name, project.description, project.instructions].some((value) => value?.toLowerCase().includes(needle)));
  }, [projects, query]);

  async function loadProjects() {
    setError(null);
    const data = await apiClient.projects.list();
    setProjects(data.projects ?? []);
  }

  useEffect(() => {
    loadProjects()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  function startCreate() {
    setSelectedProjectId(null);
    setDraft(emptyDraft);
  }

  function selectProject(project: Project) {
    setSelectedProjectId(project.id);
    setDraft(draftFromProject(project));
  }

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const name = draft.name.trim();
    if (!name) {
      setError("Project name is required.");
      return;
    }

    setSaving(true);
    try {
      if (selectedProject) {
        const data = await apiClient.projects.update(selectedProject.id, {
          name,
          description: draft.description.trim() || null,
          instructions: draft.instructions.trim() || null
        });
        setProjects((current) => current.map((item) => (item.id === selectedProject.id ? data.project : item)));
        setDraft(draftFromProject(data.project));
        toast({ title: "Project updated", message: data.project.name, variant: "success" });
      } else {
        const data = await apiClient.projects.create({
          name,
          description: draft.description.trim(),
          instructions: draft.instructions.trim()
        });
        setProjects((current) => [data.project, ...current]);
        setSelectedProjectId(data.project.id);
        setDraft(draftFromProject(data.project));
        toast({ title: "Project created", message: data.project.name, variant: "success" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Project save failed", message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function deleteProject(project: Project) {
    setDeletingId(project.id);
    setError(null);
    try {
      await apiClient.projects.delete(project.id);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      if (selectedProjectId === project.id) startCreate();
      toast({ title: "Project deleted", message: project.name, variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast({ title: "Project delete failed", message, variant: "error" });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="projects-prompts-page">
      <div className="card card--hero projects-prompts-hero">
        <div>
          <div className="eyebrow">Projects</div>
          <h1>User-owned workspaces</h1>
          <p className="muted">Keep persistent instructions and context together before they flow into chats, prompts, and agents.</p>
        </div>
        <button className="button" type="button" onClick={startCreate}>New project</button>
      </div>

      {error ? <ErrorState message={error} onRetry={() => void loadProjects()} /> : null}

      <div className="projects-prompts-layout">
        <aside className="card projects-prompts-sidebar" aria-label="Project library">
          <label>
            Search projects
            <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, description, instructions" />
          </label>

          {loading ? <LoadingBlock title="Loading projects" /> : null}
          {!loading && filteredProjects.length === 0 ? <EmptyState title="No projects found" description="Create a project to store reusable workspace instructions." /> : null}

          <div className="projects-prompts-list">
            {filteredProjects.map((project) => (
              <button className="projects-prompts-list-item" key={project.id} type="button" aria-pressed={project.id === selectedProjectId} onClick={() => selectProject(project)}>
                <strong>{project.name}</strong>
                {project.description ? <span>{project.description}</span> : <span className="muted">No description</span>}
                <small>Updated {project.updated_at ? new Date(project.updated_at).toLocaleDateString() : "recently"}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="card projects-prompts-editor" aria-label={selectedProject ? "Edit project" : "Create project"}>
          <div className="panel-title">
            <div>
              <div className="eyebrow">{selectedProject ? "Edit" : "Create"}</div>
              <h2>{selectedProject ? selectedProject.name : "New project"}</h2>
              <p className="muted">Project instructions are private to your account in this V1 build.</p>
            </div>
            {selectedProject ? (
              <ConfirmButton className="button button--danger" message="Delete this project?" confirmLabel="Delete" disabled={deletingId === selectedProject.id} onConfirm={() => deleteProject(selectedProject)}>
                Delete
              </ConfirmButton>
            ) : null}
          </div>

          <form className="projects-prompts-form" onSubmit={(event) => void saveProject(event)}>
            <label>
              Name
              <input className="input" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required />
            </label>
            <label>
              Description
              <input className="input" value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="What this workspace is for" />
            </label>
            <label>
              Instructions
              <textarea value={draft.instructions} onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))} rows={8} placeholder="Persistent style, constraints, project context, or domain notes" />
            </label>
            <div className="projects-prompts-actions">
              <button className="button" disabled={saving} type="submit">{saving ? "Saving..." : selectedProject ? "Save project" : "Create project"}</button>
              {selectedProject ? <button className="button button--ghost" type="button" onClick={startCreate}>Clear selection</button> : null}
            </div>
          </form>
        </section>
      </div>
    </section>
  );
}
