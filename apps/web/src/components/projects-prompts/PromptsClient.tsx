"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiClient, type Prompt } from "../../lib/api-client";
import { ErrorState, LoadingBlock, useToast } from "../ui";
import { Icon } from "../icons";

type PromptDraft = {
  name: string;
  description: string;
  variables: string;
  body: string;
};

type SortKey = "title" | "updated";
type ViewMode = "grid" | "list";

type CatalogTemplate = {
  id: string;
  name: string;
  description: string;
  body: string;
  variables: string[];
};

const emptyDraft: PromptDraft = { name: "", description: "", variables: "", body: "" };

const FAVORITES_STORAGE_KEY = "packetchat.prompts.favorites";
const PENDING_PROMPT_STORAGE_KEY = "packetchat.chat.pendingPrompt";

const TEMPLATE_CATALOG: CatalogTemplate[] = [
  {
    id: "summarize-doc",
    name: "Summarize a document",
    description: "Concise summary of any long-form text with key points and action items.",
    body: "Summarize the following document for a {{audience}} reader. Highlight the 3-5 most important points and any explicit action items.\n\nDocument:\n{{document}}",
    variables: ["audience", "document"]
  },
  {
    id: "blog-outline",
    name: "Blog post outline",
    description: "Generate a structured outline for a blog post on any topic.",
    body: "Create a detailed blog post outline about {{topic}} aimed at {{audience}}. Include an intro hook, 4-6 section headings with bullet points, and a conclusion.",
    variables: ["topic", "audience"]
  },
  {
    id: "code-review",
    name: "Code review checklist",
    description: "Review a code diff for correctness, style, and security issues.",
    body: "Review the following {{language}} code change. Flag bugs, style issues, and security concerns. Suggest concrete improvements.\n\nDiff:\n{{diff}}",
    variables: ["language", "diff"]
  },
  {
    id: "meeting-notes",
    name: "Meeting notes cleanup",
    description: "Turn raw meeting notes into a clean recap with decisions and action items.",
    body: "Clean up these meeting notes into a recap with sections: Attendees, Decisions, Action Items (with owners), and Open Questions.\n\nNotes:\n{{notes}}",
    variables: ["notes"]
  },
  {
    id: "email-reply",
    name: "Professional email reply",
    description: "Draft a professional email response in a chosen tone.",
    body: "Draft a {{tone}} reply to the email below. Keep it under 150 words and end with a clear next step.\n\nEmail:\n{{email}}",
    variables: ["tone", "email"]
  },
  {
    id: "user-story",
    name: "Agile user story",
    description: "Convert a feature idea into a well-formed user story with acceptance criteria.",
    body: "Write a user story for: {{feature}}\n\nFormat: As a {{persona}}, I want ... so that ... Include 3-5 acceptance criteria in Given/When/Then form.",
    variables: ["feature", "persona"]
  }
];

function promptVariables(prompt: Prompt): string[] {
  return Array.isArray(prompt.variables) ? prompt.variables : [];
}

function draftFromPrompt(prompt: Prompt): PromptDraft {
  return {
    name: prompt.name,
    description: prompt.description ?? "",
    variables: promptVariables(prompt).join(", "),
    body: prompt.body
  };
}

function variableList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function PromptsClient() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("title");
  const [view, setView] = useState<ViewMode>("grid");
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [favoritesHydrated, setFavoritesHydrated] = useState(false);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<PromptDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [creatingFromTemplateId, setCreatingFromTemplateId] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const toast = useToast();

  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    prompts.forEach((prompt) => promptVariables(prompt).forEach((variable) => set.add(variable)));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [prompts]);

  const filteredPrompts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return prompts.filter((prompt) => {
      if (tagFilter && !promptVariables(prompt).includes(tagFilter)) return false;
      if (!needle) return true;
      return [prompt.name, prompt.description, prompt.body, promptVariables(prompt).join(" ")].some(
        (value) => value?.toLowerCase().includes(needle)
      );
    });
  }, [prompts, query, tagFilter]);

  const sortedPrompts = useMemo(() => {
    const copy = [...filteredPrompts];
    if (sort === "title") {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === "updated") {
      copy.sort((a, b) => {
        const aKey = a.updated_at ?? a.created_at ?? "";
        const bKey = b.updated_at ?? b.created_at ?? "";
        if (aKey && bKey && aKey !== bKey) return bKey.localeCompare(aKey);
        if (aKey && !bKey) return -1;
        if (!aKey && bKey) return 1;
        return a.name.localeCompare(b.name);
      });
    }
    return copy;
  }, [filteredPrompts, sort]);

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

  // Hydrate favorites from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setFavorites(new Set(parsed.filter((id): id is string => typeof id === "string")));
        }
      }
    } catch {
      // ignore corrupt storage
    } finally {
      setFavoritesHydrated(true);
    }
  }, []);

  // Persist favorites whenever they change (after initial hydration).
  useEffect(() => {
    if (!favoritesHydrated || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
    } catch {
      // ignore quota errors
    }
  }, [favorites, favoritesHydrated]);

  // Reset pending-delete state when filters/sort change so a stale row id can't linger.
  useEffect(() => {
    setPendingDeleteId(null);
  }, [query, tagFilter, sort]);

  function openCreate() {
    setEditing(null);
    setCreating(true);
    setDraft(emptyDraft);
    setFormError(null);
    dialogRef.current?.showModal();
  }

  function openEdit(prompt: Prompt) {
    setEditing(prompt);
    setCreating(false);
    setDraft(draftFromPrompt(prompt));
    setFormError(null);
    dialogRef.current?.showModal();
  }

  function closeDialog() {
    setFormError(null);
    setCreating(false);
    setEditing(null);
    dialogRef.current?.close();
  }

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyPrompt(prompt: Prompt) {
    const ok = await writeClipboard(prompt.body);
    if (ok) {
      toast({ message: `Copied "${prompt.name}" to clipboard.`, variant: "success" });
    } else {
      toast({ title: "Copy failed", message: "Clipboard access is unavailable.", variant: "error" });
    }
  }

  function handleUseNow(prompt: Prompt) {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        PENDING_PROMPT_STORAGE_KEY,
        JSON.stringify({ id: prompt.id, name: prompt.name, body: prompt.body, variables: promptVariables(prompt) })
      );
    } catch {
      // ignore storage errors – the link still navigates with ?prompt=<id>
    }
  }

  async function savePrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const name = draft.name.trim();
    const body = draft.body.trim();
    if (!name || !body) {
      setFormError("Prompt name and body are required.");
      return;
    }
    const variables = variableList(draft.variables);
    setSaving(true);
    try {
      if (editing) {
        const data = await apiClient.prompts.update(editing.id, {
          name,
          description: draft.description.trim() || null,
          body,
          variables
        });
        setPrompts((current) => current.map((item) => (item.id === editing.id ? data.prompt : item)));
        toast({ title: "Prompt updated", message: data.prompt.name, variant: "success" });
      } else {
        const data = await apiClient.prompts.create({
          name,
          description: draft.description.trim(),
          body,
          variables
        });
        setPrompts((current) => [data.prompt, ...current]);
        toast({ title: "Prompt created", message: data.prompt.name, variant: "success" });
      }
      closeDialog();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFormError(message);
      toast({ title: "Prompt save failed", message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  function requestDelete(prompt: Prompt) {
    setPendingDeleteId(prompt.id);
  }

  function cancelDelete() {
    setPendingDeleteId(null);
  }

  async function confirmDelete(prompt: Prompt) {
    setDeletingId(prompt.id);
    try {
      await apiClient.prompts.delete(prompt.id);
      setPrompts((current) => current.filter((item) => item.id !== prompt.id));
      setFavorites((current) => {
        if (!current.has(prompt.id)) return current;
        const next = new Set(current);
        next.delete(prompt.id);
        return next;
      });
      toast({ title: "Prompt deleted", message: prompt.name, variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: "Prompt delete failed", message, variant: "error" });
    } finally {
      setDeletingId(null);
      setPendingDeleteId(null);
    }
  }

  async function createFromTemplate(template: CatalogTemplate) {
    setCreatingFromTemplateId(template.id);
    try {
      const data = await apiClient.prompts.create({
        name: template.name,
        description: template.description,
        body: template.body,
        variables: template.variables
      });
      setPrompts((current) => [data.prompt, ...current]);
      toast({ title: "Prompt added", message: data.prompt.name, variant: "success" });
      setBrowseOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: "Couldn't add template", message, variant: "error" });
    } finally {
      setCreatingFromTemplateId(null);
    }
  }

  return (
    <section className="prompt-lib">
      <header className="prompt-lib__head">
        <div className="prompt-lib__heading">
          <h1>Prompt Library</h1>
          <p className="sub">Prompts are message templates that open in chat for review, editing, and sending.</p>
        </div>
        <div className="prompt-lib__head-actions">
          <button className="button button--primary" type="button" onClick={openCreate}>Add prompt</button>
          <button className="button button--white" type="button" onClick={() => setBrowseOpen(true)}>Browse prompts</button>
        </div>
      </header>

      {error ? <ErrorState message={error} onRetry={() => void loadPrompts()} /> : null}

      <div className="prompt-lib__toolbar">
        <label className="prompt-lib__search">
          <Icon.search />
          <input
            placeholder="Search your prompts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search your prompts"
          />
        </label>
        <label className="prompt-lib__select">
          <Icon.tag />
          <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} aria-label="Filter by tags">
            <option value="">Filter by Tags</option>
            {tagOptions.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
          <Icon.chev />
        </label>
        <label className="prompt-lib__select prompt-lib__select--sm">
          <Icon.sortDesc />
          <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort prompts">
            <option value="title">Title</option>
            <option value="updated">Recently updated</option>
          </select>
          <Icon.chev />
        </label>
        <div className="prompt-lib__view" role="group" aria-label="View mode">
          <button
            type="button"
            className={`ib ${view === "list" ? "on" : ""}`}
            onClick={() => setView("list")}
            aria-pressed={view === "list"}
            aria-label="List view"
            title="List view"
          >
            <Icon.list />
          </button>
          <button
            type="button"
            className={`ib ${view === "grid" ? "on" : ""}`}
            onClick={() => setView("grid")}
            aria-pressed={view === "grid"}
            aria-label="Grid view"
            title="Grid view"
          >
            <Icon.grid />
          </button>
        </div>
      </div>

      {loading ? <LoadingBlock title="Loading prompts" /> : null}
      {!loading && sortedPrompts.length === 0 ? (
        <div className="empty-state">
          {prompts.length === 0 ? "No prompts yet. Click Add prompt to create your first template." : "No prompts match your filters."}
        </div>
      ) : null}

      <div className={view === "grid" ? "prompt-lib__grid" : "prompt-lib__list"}>
        {sortedPrompts.map((prompt) => {
          const favored = favorites.has(prompt.id);
          const isPendingDelete = pendingDeleteId === prompt.id;
          const isDeleting = deletingId === prompt.id;
          return (
            <article className="prompt-card" key={prompt.id}>
              <div className="prompt-card__title">{prompt.name}</div>
              <div className="prompt-card__footer">
                <div className="prompt-card__actions">
                  <button
                    className={`ib ${favored ? "on" : ""}`}
                    type="button"
                    onClick={() => toggleFavorite(prompt.id)}
                    aria-pressed={favored}
                    aria-label={favored ? "Unstar prompt" : "Star prompt"}
                    title={favored ? "Unstar" : "Star"}
                  >
                    <Icon.star />
                  </button>
                  <button
                    className="ib"
                    type="button"
                    onClick={() => void copyPrompt(prompt)}
                    aria-label="Copy prompt"
                    title="Copy"
                  >
                    <Icon.copy />
                  </button>
                  <button
                    className="ib"
                    type="button"
                    onClick={() => openEdit(prompt)}
                    aria-label="Edit prompt"
                    title="Edit"
                  >
                    <Icon.edit />
                  </button>
                  {isPendingDelete ? (
                    <span
                      className="prompt-card__confirm"
                      style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
                    >
                      <button
                        className="button button--danger"
                        type="button"
                        onClick={() => void confirmDelete(prompt)}
                        disabled={isDeleting}
                        style={{ padding: "2px 10px", fontSize: 12 }}
                      >
                        {isDeleting ? "Deleting..." : "Confirm"}
                      </button>
                      <button
                        className="button button--ghost"
                        type="button"
                        onClick={cancelDelete}
                        disabled={isDeleting}
                        style={{ padding: "2px 10px", fontSize: 12 }}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      className="ib"
                      type="button"
                      onClick={() => requestDelete(prompt)}
                      disabled={isDeleting}
                      aria-label="Delete prompt"
                      title="Delete"
                    >
                      <Icon.trash />
                    </button>
                  )}
                </div>
                <Link
                  className="prompt-card__use"
                  href={`/chat?prompt=${encodeURIComponent(prompt.id)}`}
                  onClick={() => handleUseNow(prompt)}
                >
                  Use in chat
                </Link>
              </div>
            </article>
          );
        })}
      </div>

      <dialog ref={dialogRef} className="prompt-dialog" onClose={closeDialog} aria-label={editing ? "Edit prompt" : "Add prompt"}>
        <form className="prompt-dialog__form" onSubmit={(event) => void savePrompt(event)} method="dialog">
          <header className="prompt-dialog__head">
            <h2>{editing ? "Edit prompt" : creating ? "Add prompt" : "Prompt"}</h2>
            <button className="ib" type="button" onClick={closeDialog} aria-label="Close" title="Close">
              <Icon.plus style={{ transform: "rotate(45deg)" }} />
            </button>
          </header>

          <label>
            Name
            <input className="input" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required />
          </label>
          <label>
            Description
            <input className="input" value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} />
          </label>
          <label>
            Variables
            <input className="input" value={draft.variables} onChange={(event) => setDraft((current) => ({ ...current, variables: event.target.value }))} placeholder="topic, audience" />
          </label>
          <label>
            Body
            <textarea value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} rows={8} required />
          </label>

          {formError ? <p className="error-state">{formError}</p> : null}

          <div className="prompt-dialog__actions">
            <button className="button button--ghost" type="button" onClick={closeDialog}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={saving}>
              {saving ? "Saving..." : editing ? "Save prompt" : "Create prompt"}
            </button>
          </div>
        </form>
      </dialog>

      {browseOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Browse prompt templates"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(10, 12, 20, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 24
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setBrowseOpen(false);
          }}
        >
          <div
            style={{
              background: "var(--surface, #fff)",
              color: "var(--text, #111)",
              width: "min(720px, 100%)",
              maxHeight: "85vh",
              overflow: "auto",
              borderRadius: 12,
              boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
              padding: 20
            }}
          >
            <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>Browse prompt templates</h2>
                <p className="sub" style={{ margin: "4px 0 0", fontSize: 13 }}>
                  Pick a starter template and add it to your library.
                </p>
              </div>
              <button className="ib" type="button" onClick={() => setBrowseOpen(false)} aria-label="Close" title="Close">
                <Icon.plus style={{ transform: "rotate(45deg)" }} />
              </button>
            </header>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
              {TEMPLATE_CATALOG.map((template) => {
                const adding = creatingFromTemplateId === template.id;
                return (
                  <li
                    key={template.id}
                    style={{
                      border: "1px solid var(--border, #e3e4e8)",
                      borderRadius: 10,
                      padding: 14,
                      display: "grid",
                      gap: 8
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{template.name}</div>
                        <div className="sub" style={{ fontSize: 13, marginTop: 2 }}>{template.description}</div>
                      </div>
                      <button
                        type="button"
                        className="button button--primary"
                        onClick={() => void createFromTemplate(template)}
                        disabled={adding}
                        style={{ flexShrink: 0 }}
                      >
                        {adding ? "Adding..." : "Use template"}
                      </button>
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        padding: 10,
                        background: "var(--surface-2, #f5f6f8)",
                        borderRadius: 8,
                        fontSize: 12,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 120,
                        overflow: "auto"
                      }}
                    >
                      {template.body}
                    </pre>
                    {template.variables.length > 0 ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {template.variables.map((variable) => (
                          <span
                            key={variable}
                            style={{
                              fontSize: 11,
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "var(--surface-2, #eef0f4)",
                              border: "1px solid var(--border, #e3e4e8)"
                            }}
                          >
                            {variable}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
