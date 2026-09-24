"use client";

import { DragEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, type KnowledgeBase, type KnowledgeDocument, type KnowledgeSearchResult } from "../../lib/api-client";
import { ConfirmButton, EmptyState, ErrorState, LoadingBlock, StatusBadge, useToast } from "../ui";

type KnowledgeDraft = {
  name: string;
  description: string;
};

const ACCEPTED_FILE_TYPES = [
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".docx",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
].join(",");

function draftFromKnowledgeBase(kb: KnowledgeBase | null): KnowledgeDraft {
  return { name: kb?.name ?? "", description: kb?.description ?? "" };
}

function metadataRecordValue(metadata: Record<string, unknown> | null | undefined, key: string) {
  if (!metadata || typeof metadata !== "object") return null;
  const value = metadata[key];
  if (value === undefined || value === null) return null;
  return String(value);
}

function metadataValue(document: KnowledgeDocument, key: string) {
  return metadataRecordValue(document.source_metadata as Record<string, unknown> | null | undefined, key);
}

function formatSize(value?: string | number | null) {
  if (value == null) return "Unknown size";
  const bytes = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(bytes)) return String(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatDebugScore(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toFixed(4);
}

function compactId(value?: string | null) {
  return value ? value.slice(0, 8) : "unknown";
}

function relevanceFromScore(score?: number | null): { label: string; tone: "success" | "info" | "warning" } {
  if (typeof score !== "number" || !Number.isFinite(score)) return { label: "Unknown", tone: "warning" };
  if (score >= 0.7) return { label: "High", tone: "success" };
  if (score >= 0.4) return { label: "Medium", tone: "info" };
  return { label: "Low", tone: "warning" };
}

export function KnowledgeManager() {
  const toast = useToast();
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [createDraft, setCreateDraft] = useState<KnowledgeDraft>({ name: "", description: "" });
  const [editDraft, setEditDraft] = useState<KnowledgeDraft>({ name: "", description: "" });
  const [documentTitles, setDocumentTitles] = useState<Record<string, string>>({});
  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(5);
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [embeddingNotice, setEmbeddingNotice] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingBases, setLoadingBases] = useState(true);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savingKb, setSavingKb] = useState(false);
  const [creatingKb, setCreatingKb] = useState(false);
  const [reembedding, setReembedding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedKb = useMemo(() => knowledgeBases.find((kb) => kb.id === selectedId) ?? null, [knowledgeBases, selectedId]);
  const readyDocuments = documents.filter((document) => document.ingest_status === "ready").length;
  const failedDocuments = documents.filter((document) => document.ingest_status === "failed").length;
  const processingDocuments = documents.filter((document) => ["queued", "processing"].includes(document.ingest_status)).length;
  const selectedArchived = selectedKb?.status === "archived";

  async function loadKnowledgeBases() {
    setLoadingBases(true);
    setError(null);
    try {
      const data = await apiClient.knowledge.list();
      const bases = data.knowledgeBases ?? [];
      setKnowledgeBases(bases);
      setSelectedId((current) => current || bases[0]?.id || "");
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to load knowledge bases", message: nextError, variant: "error" });
    } finally {
      setLoadingBases(false);
    }
  }

  async function loadDocuments(knowledgeBaseId: string) {
    if (!knowledgeBaseId) {
      setDocuments([]);
      return;
    }
    setLoadingDocuments(true);
    try {
      const data = await apiClient.knowledge.documents(knowledgeBaseId);
      const nextDocuments = data.documents ?? [];
      setDocuments(nextDocuments);
      setDocumentTitles(Object.fromEntries(nextDocuments.map((document) => [document.id, document.title])));
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to load documents", message: nextError, variant: "error" });
    } finally {
      setLoadingDocuments(false);
    }
  }

  useEffect(() => {
    void loadKnowledgeBases();
  }, []);

  useEffect(() => {
    setEditDraft(draftFromKnowledgeBase(selectedKb));
    setSearchResults([]);
    setSearched(false);
    setEmbeddingNotice("");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    void loadDocuments(selectedId);
  }, [selectedId, selectedKb?.id]);

  async function createKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creatingKb) return;
    setCreatingKb(true);
    setMessage("");
    setError(null);
    try {
      const name = createDraft.name.trim();
      if (!name) throw new Error("Knowledge base name is required.");
      const data = await apiClient.knowledge.create({ name, description: createDraft.description.trim() });
      setCreateDraft({ name: "", description: "" });
      setSelectedId(data.knowledgeBaseId);
      await loadKnowledgeBases();
      setMessage("Knowledge base created.");
      toast({ message: "Knowledge base created.", variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to create knowledge base", message: nextError, variant: "error" });
    } finally {
      setCreatingKb(false);
    }
  }

  async function saveKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedKb || savingKb) return;
    setSavingKb(true);
    setMessage("");
    setError(null);
    try {
      const name = editDraft.name.trim();
      if (!name) throw new Error("Knowledge base name is required.");
      const data = await apiClient.knowledge.update(selectedKb.id, { name, description: editDraft.description.trim() || null });
      setKnowledgeBases((current) => current.map((kb) => (kb.id === selectedKb.id ? { ...kb, ...data.knowledgeBase } : kb)));
      setEditDraft(draftFromKnowledgeBase(data.knowledgeBase));
      setMessage("Knowledge base updated.");
      toast({ message: "Knowledge base updated.", variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to update knowledge base", message: nextError, variant: "error" });
    } finally {
      setSavingKb(false);
    }
  }

  async function uploadFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !selectedId || uploading) return;
    setUploading(true);
    setMessage("");
    setError(null);
    try {
      const form = new FormData();
      form.set("knowledgeBaseId", selectedId);
      form.set("file", file);
      await apiClient.knowledge.uploadFile(form);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadDocuments(selectedId);
      await loadKnowledgeBases();
      setMessage("File uploaded and queued for ingestion.");
      toast({ message: "File uploaded and queued for ingestion.", variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to upload file", message: nextError, variant: "error" });
    } finally {
      setUploading(false);
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (selectedArchived || uploading) return;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (selectedArchived || uploading) return;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    if (selectedArchived || uploading) return;
    const dropped = event.dataTransfer?.files?.[0];
    if (!dropped) return;
    setFile(dropped);
  }

  async function searchKnowledge(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selectedId || !query.trim() || searching) return;
    setSearching(true);
    setMessage("");
    setError(null);
    setEmbeddingNotice("");
    setSearchResults([]);
    setSearched(true);
    try {
      const data = await apiClient.knowledge.search(selectedId, { query, limit });
      const results = data.results ?? [];
      setSearchResults(results);
      const embeddings = data.embeddings as { fallback?: boolean; missing?: number; outdated?: number; invalid?: number };
      if (embeddings?.fallback || embeddings?.missing || embeddings?.outdated || embeddings?.invalid) {
        setEmbeddingNotice(`Embedding fallback detected: ${embeddings.missing ?? 0} missing, ${embeddings.outdated ?? 0} outdated, ${embeddings.invalid ?? 0} invalid.`);
      }
      setMessage(results.length ? `Search complete. ${results.length} result${results.length === 1 ? "" : "s"}.` : "No matching chunks found.");
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Knowledge search failed", message: nextError, variant: "error" });
    } finally {
      setSearching(false);
    }
  }

  function handleQueryKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void searchKnowledge();
    }
  }

  async function archiveKnowledgeBase(kb: KnowledgeBase) {
    setMessage("");
    setError(null);
    try {
      const data = await apiClient.knowledge.update(kb.id, { archived: true });
      setKnowledgeBases((current) => current.map((item) => (item.id === kb.id ? { ...item, ...data.knowledgeBase } : item)));
      setMessage("Knowledge base archived.");
      toast({ message: "Knowledge base archived.", variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to archive knowledge base", message: nextError, variant: "error" });
    }
  }

  async function deleteKnowledgeBase(kb: KnowledgeBase) {
    setMessage("");
    setError(null);
    try {
      await apiClient.knowledge.delete(kb.id);
      setKnowledgeBases((current) => current.filter((item) => item.id !== kb.id));
      if (selectedId === kb.id) {
        setSelectedId("");
        setDocuments([]);
        setSearchResults([]);
        setSearched(false);
      }
      setMessage("Knowledge base deleted.");
      toast({ message: "Knowledge base deleted.", variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to delete knowledge base", message: nextError, variant: "error" });
    }
  }

  async function renameDocument(document: KnowledgeDocument) {
    if (!selectedId || renamingDocId) return;
    const next = (documentTitles[document.id] ?? document.title).trim();
    if (!next) {
      setError("Document title is required.");
      toast({ message: "Document title is required.", variant: "error" });
      return;
    }
    if (next === document.title) {
      setMessage("No change.");
      toast({ message: "No change.", variant: "info" });
      return;
    }
    setRenamingDocId(document.id);
    setMessage("");
    setError(null);
    try {
      await apiClient.knowledge.updateDocument(selectedId, document.id, { title: next });
      await loadDocuments(selectedId);
      setMessage("Document renamed.");
      toast({ message: "Document renamed.", variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to rename document", message: nextError, variant: "error" });
    } finally {
      setRenamingDocId(null);
    }
  }

  async function deleteDocument(document: KnowledgeDocument) {
    if (!selectedId) return;
    setMessage("");
    setError(null);
    try {
      await apiClient.knowledge.deleteDocument(selectedId, document.id);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      await loadKnowledgeBases();
      setMessage("Document deleted.");
      toast({ message: "Document deleted.", variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to delete document", message: nextError, variant: "error" });
    }
  }

  async function reembedKnowledgeBase() {
    if (!selectedId || reembedding) return;
    setReembedding(true);
    setMessage("");
    setError(null);
    setEmbeddingNotice("");
    try {
      const result = await apiClient.knowledge.reembed(selectedId, { limit: 100 });
      const skipped = result.skippedCurrent ?? 0;
      const reasons = result.reasons ? Object.entries(result.reasons).filter(([, count]) => count > 0).map(([reason, count]) => `${reason}: ${count}`).join(", ") : "";
      const summary = `Scanned ${result.scanned}, updated ${result.updated}, skipped ${skipped}${result.hasMore ? " (more remaining)" : ""}${reasons ? ` - reasons: ${reasons}` : ""}.`;
      setEmbeddingNotice(summary);
      setMessage(summary);
      toast({ title: "Embeddings refreshed", message: `${result.updated} updated / ${result.scanned} scanned${result.hasMore ? " (run again for remainder)" : ""}.`, variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to refresh embeddings", message: nextError, variant: "error" });
    } finally {
      setReembedding(false);
    }
  }

  const dropZoneStyle = {
    border: dragActive ? "1px dashed var(--accent)" : "1px dashed var(--line-2)",
    borderRadius: 12,
    padding: "16px",
    background: dragActive ? "var(--accent-soft)" : "var(--bg-3)",
    transition: "background 120ms ease, border-color 120ms ease",
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  };

  return (
    <section className="knowledge-library">
      <div className="card card--hero knowledge-hero">
        <div>
          <div className="eyebrow">Knowledge</div>
          <h1>Knowledge library</h1>
          <p className="muted">Create private document collections, upload files, and test local hybrid retrieval before attaching knowledge to chats or agents.</p>
        </div>
        <button className="button" type="button" onClick={() => void loadKnowledgeBases()} disabled={loadingBases}>{loadingBases ? "Refreshing..." : "Refresh"}</button>
      </div>

      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <ErrorState message={error} onRetry={() => void loadKnowledgeBases()} /> : null}

      <div className="knowledge-layout">
        <aside className="card knowledge-sidebar" aria-label="Knowledge bases">
          <form className="knowledge-create" onSubmit={(event) => void createKnowledgeBase(event)}>
            <div>
              <div className="eyebrow">Create</div>
              <h2>New base</h2>
            </div>
            <label>
              Name
              <input className="input" value={createDraft.name} onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))} required disabled={creatingKb} />
            </label>
            <label>
              Description
              <textarea value={createDraft.description} onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))} rows={3} disabled={creatingKb} />
            </label>
            <button className="button" type="submit" disabled={creatingKb || !createDraft.name.trim()}>{creatingKb ? "Creating..." : "Create knowledge base"}</button>
          </form>

          {loadingBases ? <LoadingBlock title="Loading bases" /> : null}
          {!loadingBases && knowledgeBases.length === 0 ? <EmptyState title="No knowledge bases" description="Create one before uploading documents." /> : null}

          <div className="knowledge-base-list">
            {knowledgeBases.map((kb) => (
              <button className="knowledge-base-card" key={kb.id} type="button" aria-pressed={kb.id === selectedId} onClick={() => setSelectedId(kb.id)}>
                <span className="knowledge-base-card__title">{kb.name}</span>
                <span className="knowledge-base-card__meta">{kb.document_count ?? 0} docs</span>
                <StatusBadge>{kb.status}</StatusBadge>
              </button>
            ))}
          </div>
        </aside>

        <main className="knowledge-workspace" aria-label="Selected knowledge base">
          {!selectedKb ? (
            <EmptyState title="Select a knowledge base" description="Choose a base from the library or create a new one." />
          ) : (
            <div className="grid knowledge-detail" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
              <section className="card knowledge-summary grid__full" aria-label={`Overview for ${selectedKb.name}`}>
                <div className="panel-title">
                  <div>
                    <div className="eyebrow">Selected base</div>
                    <h2>{selectedKb.name}</h2>
                    <p className="muted">{selectedKb.description || "No description"}</p>
                  </div>
                  <div className="knowledge-metric-row">
                    <span><strong>{documents.length}</strong> documents</span>
                    <span><strong>{readyDocuments}</strong> ready</span>
                    <span><strong>{processingDocuments}</strong> processing</span>
                    <span><strong>{failedDocuments}</strong> failed</span>
                  </div>
                </div>

                <form className="knowledge-edit-form" onSubmit={(event) => void saveKnowledgeBase(event)}>
                  <label>
                    Name
                    <input className="input" value={editDraft.name} onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))} required disabled={savingKb} />
                  </label>
                  <label>
                    Description
                    <textarea value={editDraft.description} onChange={(event) => setEditDraft((current) => ({ ...current, description: event.target.value }))} rows={3} disabled={savingKb} />
                  </label>
                  <div className="actions-row">
                    <button className="button" type="submit" disabled={savingKb || !editDraft.name.trim()}>{savingKb ? "Saving..." : "Save base"}</button>
                    <ConfirmButton message={`Archive ${selectedKb.name}?`} disabled={selectedArchived || savingKb} onConfirm={() => archiveKnowledgeBase(selectedKb)}>Archive</ConfirmButton>
                    <ConfirmButton className="button button--danger" message={`Delete ${selectedKb.name} and its documents?`} confirmLabel="Delete" disabled={savingKb} onConfirm={() => deleteKnowledgeBase(selectedKb)}>Delete</ConfirmButton>
                  </div>
                </form>
              </section>

              <section className="card knowledge-upload">
                <div>
                  <div className="eyebrow">Upload</div>
                  <h2>Upload documents</h2>
                  <p className="muted">Drop in .txt, .md, .pdf, .docx, images, and more.</p>
                </div>
                <form className="knowledge-upload-form" onSubmit={(event) => void uploadFile(event)}>
                  <div
                    style={dropZoneStyle}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    aria-label="Drop a file to upload"
                  >
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <span>{dragActive ? "Release to attach file" : "File (drag & drop or browse)"}</span>
                      <input
                        ref={fileInputRef}
                        className="input"
                        aria-label="File to upload"
                        type="file"
                        accept={ACCEPTED_FILE_TYPES}
                        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                        disabled={selectedArchived || uploading}
                      />
                    </label>
                    {file ? (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={file.name}>
                          <strong>{file.name}</strong> <span className="muted">({formatSize(file.size)})</span>
                        </span>
                        <button
                          type="button"
                          className="button button--ghost"
                          onClick={() => {
                            setFile(null);
                            if (fileInputRef.current) fileInputRef.current.value = "";
                          }}
                          disabled={uploading}
                        >
                          Clear
                        </button>
                      </div>
                    ) : (
                      <span className="muted" style={{ fontSize: 12 }}>No file selected.</span>
                    )}
                  </div>
                  <button className="button" type="submit" disabled={selectedArchived || !file || uploading}>{uploading ? "Uploading..." : "Upload and queue"}</button>
                </form>
                {selectedArchived ? <p className="warning" role="status">Archived knowledge bases cannot receive uploads or searches.</p> : null}
              </section>

              <section className="card knowledge-documents">
                <div className="panel-title">
                  <div>
                    <div className="eyebrow">Documents</div>
                    <h2>Ingestion status</h2>
                  </div>
                  <button className="button button--ghost" type="button" disabled={!selectedId || loadingDocuments} onClick={() => void loadDocuments(selectedId)}>{loadingDocuments ? "Refreshing..." : "Refresh documents"}</button>
                </div>
                {loadingDocuments ? <LoadingBlock title="Loading documents" /> : null}
                {!loadingDocuments && documents.length === 0 ? <EmptyState title="No documents" description="Upload a file to queue extraction, chunking, and embeddings." /> : null}
                <div className="knowledge-document-list">
                  {documents.map((document) => {
                    const currentTitle = documentTitles[document.id] ?? document.title;
                    const isRenaming = renamingDocId === document.id;
                    const isDirty = currentTitle.trim() !== document.title && currentTitle.trim().length > 0;
                    return (
                      <article className="knowledge-document-card" key={document.id}>
                        <div>
                          <input
                            className="input"
                            value={currentTitle}
                            onChange={(event) => setDocumentTitles((current) => ({ ...current, [document.id]: event.target.value }))}
                            aria-label={`Title for ${document.title}`}
                            disabled={isRenaming}
                          />
                          <div className="knowledge-document-meta">
                            <StatusBadge>{document.ingest_status}</StatusBadge>
                            <span>{document.mime_type ?? metadataValue(document, "detectedType") ?? "unknown type"}</span>
                            <span>{formatSize(document.size_bytes)}</span>
                            {metadataValue(document, "chunkCount") ? <span>{metadataValue(document, "chunkCount")} chunks</span> : null}
                          </div>
                          {metadataValue(document, "error") ? <p className="error-state" role="alert">{metadataValue(document, "error")}</p> : null}
                        </div>
                        <div className="actions-row knowledge-document-actions">
                          <button className="button button--ghost" type="button" onClick={() => void renameDocument(document)} disabled={isRenaming || !isDirty}>
                            {isRenaming ? "Renaming..." : "Rename"}
                          </button>
                          <ConfirmButton className="button button--danger" message={`Delete ${document.title}?`} confirmLabel="Delete" disabled={isRenaming} onConfirm={() => deleteDocument(document)}>Delete</ConfirmButton>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="card knowledge-search grid__full" aria-label={`Retrieval for ${selectedKb.name}`}>
                <div className="panel-title">
                  <div>
                    <div className="eyebrow">Retrieval</div>
                    <h2>Test search</h2>
                  </div>
                  <button className="button button--ghost" type="button" disabled={selectedArchived || reembedding} onClick={() => void reembedKnowledgeBase()}>{reembedding ? "Refreshing..." : "Refresh embeddings"}</button>
                </div>
                <form className="knowledge-search-form" onSubmit={(event) => void searchKnowledge(event)}>
                  <label>
                    Query
                    <input
                      className="input"
                      aria-label="Search query"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={handleQueryKeyDown}
                      placeholder="Search ready documents (Enter to submit)"
                      required
                      disabled={searching}
                    />
                  </label>
                  <label>
                    Results
                    <input className="input" type="number" min={1} max={50} value={limit} onChange={(event) => setLimit(Number(event.target.value))} disabled={searching} />
                  </label>
                  <button className="button" type="submit" disabled={selectedArchived || !query.trim() || searching}>{searching ? "Searching..." : "Search knowledge"}</button>
                </form>
                {embeddingNotice ? <p className="warning" role="status">{embeddingNotice}</p> : null}
                {searched && !searching ? (
                  <p className="muted" role="status" style={{ fontSize: 13 }}>
                    {searchResults.length} result{searchResults.length === 1 ? "" : "s"}{query.trim() ? ` for "${query.trim()}"` : ""}.
                  </p>
                ) : null}
                {!searched && searchResults.length === 0 ? <EmptyState title="No search yet" description="Search results will appear here after documents finish ingestion." /> : null}
                <div className="knowledge-search-results">
                  {searchResults.map((result) => {
                    const source = result.source;
                    const freshness = result.freshness;
                    const detectedType = source?.detectedType ?? metadataRecordValue(source?.metadata, "detectedType") ?? result.mimeType ?? "unknown type";
                    const objectKey = metadataRecordValue(source?.metadata, "objectKey");
                    const chunkCount = metadataRecordValue(source?.metadata, "chunkCount");
                    const sourceName = source?.fileName ?? source?.name ?? result.title;
                    const relevance = relevanceFromScore(result.score);
                    const matchedTerms = result.matchedTerms ?? [];

                    return (
                      <article key={result.chunkId} className="knowledge-search-result">
                        <strong>{result.title}</strong>
                        <p>{result.snippet}</p>
                        <div className="knowledge-score-row">
                          <StatusBadge tone={relevance.tone}>{`${relevance.label} relevance`}</StatusBadge>
                          {result.citation ? <span>{result.citation}</span> : null}
                        </div>
                        {matchedTerms.length ? (
                          <div className="knowledge-debug-chip-row" aria-label="Matched terms">
                            {matchedTerms.map((term) => <span key={term} className="knowledge-debug-chip">{term}</span>)}
                          </div>
                        ) : null}
                        {result.explanation ? <p className="muted" style={{ fontSize: 13 }}>{result.explanation}</p> : null}
                        <details className="knowledge-result-debug">
                          <summary>Technical details</summary>
                          <div className="knowledge-result-debug__grid">
                            <div className="knowledge-result-debug__section">
                              <span className="eyebrow">Source</span>
                              <span><strong>Citation</strong> {result.citation}</span>
                              <span><strong>File</strong> {sourceName}</span>
                              <span><strong>Type</strong> {detectedType}</span>
                              {source?.sizeBytes != null ? <span><strong>Size</strong> {formatSize(source.sizeBytes)}</span> : null}
                              {source?.attachmentId ? <span><strong>Attachment</strong> {compactId(source.attachmentId)}</span> : null}
                              {objectKey ? <span><strong>Object</strong> {objectKey}</span> : null}
                            </div>
                            <div className="knowledge-result-debug__section">
                              <span className="eyebrow">Freshness</span>
                              <span><strong>Document</strong> {freshness?.label ?? "unknown"} ({formatDateTime(freshness?.updatedAt)})</span>
                              <span><strong>Chunk</strong> {formatDateTime(freshness?.chunkCreatedAt)}</span>
                              <span><strong>Embedding</strong> {freshness?.embeddingStatus ?? result.embeddingStatus ?? "unknown"}</span>
                              {freshness?.embeddingVersion ? <span><strong>Version</strong> {freshness.embeddingVersion}</span> : null}
                              {freshness?.embeddingCreatedAt ? <span><strong>Embedded</strong> {formatDateTime(freshness.embeddingCreatedAt)}</span> : null}
                              {freshness?.embeddingRefreshedAt ? <span><strong>Refreshed</strong> {formatDateTime(freshness.embeddingRefreshedAt)}</span> : null}
                            </div>
                            <div className="knowledge-result-debug__section">
                              <span className="eyebrow">Ranking</span>
                              <span><strong>Score</strong> {formatDebugScore(result.score)}</span>
                              <span><strong>Lexical</strong> {result.lexicalScore ?? 0}</span>
                              <span><strong>Semantic</strong> {formatDebugScore(result.semanticScore)}</span>
                              <span><strong>Coverage</strong> {formatDebugScore(result.coverageScore)}</span>
                              {chunkCount ? <span><strong>Document chunks</strong> {chunkCount}</span> : null}
                            </div>
                            <div className="knowledge-result-debug__section">
                              <span className="eyebrow">Identifiers</span>
                              <span><strong>Document</strong> {result.documentId}</span>
                              <span><strong>Chunk</strong> {result.chunkId}</span>
                            </div>
                          </div>
                        </details>
                      </article>
                    );
                  })}
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
