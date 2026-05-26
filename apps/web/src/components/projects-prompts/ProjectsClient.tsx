"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiClient, type Project } from "../../lib/api-client";
import { ConfirmButton, EmptyState, ErrorState, LoadingBlock, StatusBadge, useToast } from "../ui";

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

function hasInstructions(project: Pick<Project, "instructions">) {
  return Boolean(project.instructions?.trim());
}

function defaultModelLabel(project: Project | null) {
  if (!project) return "Global default";
  if (project.default_model_preset) {
    return `${project.default_model_preset.name} - ${project.default_model_preset.model}`;
  }
  return project.default_model_preset_id ? "Preset configured" : "Global default";
}

function defaultModelDetail(project: Project | null) {
  if (!project) return "New workspaces inherit the account default model.";
  if (project.default_model_preset) {
    return `${project.default_model_preset.provider} provider preset`;
  }
  return project.default_model_preset_id ? "A preset is linked, but details are hidden for this account." : "Inherits the account default model.";
}

function formatUpdated(value?: string | null) {
  if (!value) return "recently";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function pluralize(count: number, label: string) {
  return `${count.toLocaleString()} ${label}${count === 1 ? "" : "s"}`;
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
    return projects.filter((project) =>
      [
        project.name,
        project.description,
        project.instructions,
        project.default_model_preset?.name,
        project.default_model_preset?.provider,
        project.default_model_preset?.model
      ].some((value) => value?.toLowerCase().includes(needle))
    );
  }, [projects, query]);

  const draftHasInstructions = draft.instructions.trim().length > 0;
  const selectedConversationCount = selectedProject?.conversation_count ?? 0;

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
                <div className="projects-prompts-list-item__header">
                  <strong>{project.name}</strong>
                  <small>{pluralize(project.conversation_count ?? 0, "chat")}</small>
                </div>
                {project.description ? <span>{project.description}</span> : <span className="muted">No description</span>}
                <div className="projects-prompts-chip-row" aria-label={`Workspace readiness for ${project.name}`}>
                  <span className={`projects-prompts-chip ${hasInstructions(project) ? "projects-prompts-chip--success" : "projects-prompts-chip--warning"}`}>
                    {hasInstructions(project) ? "Instructions ready" : "Needs instructions"}
                  </span>
                  <span className={`projects-prompts-chip ${project.default_model_preset_id ? "projects-prompts-chip--success" : ""}`}>
                    {defaultModelLabel(project)}
                  </span>
                </div>
                <small>Updated {formatUpdated(project.updated_at)}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="card projects-prompts-editor" aria-label={selectedProject ? "Edit project" : "Create project"}>
          <div className="panel-title">
            <div>
              <div className="eyebrow">{selectedProject ? "Edit" : "Create"}</div>
              <h2>{selectedProject ? selectedProject.name : "New project"}</h2>
              <p className="muted">Workspace settings collect the persistent context this project contributes to chats, prompts, and agents.</p>
            </div>
            {selectedProject ? (
              <ConfirmButton className="button button--danger" message="Delete this project?" confirmLabel="Delete" disabled={deletingId === selectedProject.id} onConfirm={() => deleteProject(selectedProject)}>
                Delete
              </ConfirmButton>
            ) : null}
          </div>

          <div className="projects-workspace-summary" aria-label="Workspace readiness">
            <div className="projects-workspace-summary__item">
              <StatusBadge tone={draftHasInstructions ? "success" : "warning"}>{draftHasInstructions ? "Ready" : "Missing"}</StatusBadge>
              <strong>Instructions</strong>
              <small>{draftHasInstructions ? `${draft.instructions.trim().length.toLocaleString()} characters of workspace guidance` : "No persistent guidance yet"}</small>
            </div>
            <div className="projects-workspace-summary__item">
              <StatusBadge tone={selectedProject?.default_model_preset_id ? "success" : "neutral"}>{selectedProject?.default_model_preset_id ? "Pinned" : "Inherited"}</StatusBadge>
              <strong>Default model</strong>
              <small>{defaultModelLabel(selectedProject)}. {defaultModelDetail(selectedProject)}</small>
            </div>
            <div className="projects-workspace-summary__item">
              <StatusBadge tone="neutral">Agent-level</StatusBadge>
              <strong>Knowledge</strong>
              <small>Project-level knowledge binding is not available in this workspace view.</small>
            </div>
            <div className="projects-workspace-summary__item">
              <StatusBadge tone={selectedConversationCount > 0 ? "info" : "neutral"}>{selectedConversationCount > 0 ? "Active" : "Empty"}</StatusBadge>
              <strong>Chats</strong>
              <small>{selectedProject ? pluralize(selectedConversationCount, "linked chat") : "No linked chats yet"}</small>
            </div>
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
