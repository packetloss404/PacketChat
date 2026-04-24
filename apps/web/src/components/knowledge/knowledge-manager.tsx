"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiClient, type KnowledgeBase, type KnowledgeDocument, type KnowledgeSearchResult } from "../../lib/api-client";
import { ConfirmButton, EmptyState, ErrorState, LoadingBlock, StatusBadge, useToast } from "../ui";

type KnowledgeDraft = {
  name: string;
  description: string;
};

function draftFromKnowledgeBase(kb: KnowledgeBase | null): KnowledgeDraft {
  return { name: kb?.name ?? "", description: kb?.description ?? "" };
}

function metadataValue(document: KnowledgeDocument, key: string) {
  const metadata = document.source_metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  if (value === undefined || value === null) return null;
  return String(value);
}

function formatSize(value?: string | number | null) {
  if (value == null) return "Unknown size";
  const bytes = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(bytes)) return String(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function KnowledgeManager() {
  const toast = useToast();
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [createDraft, setCreateDraft] = useState<KnowledgeDraft>({ name: "", description: "" });
  const [editDraft, setEditDraft] = useState<KnowledgeDraft>({ name: "", description: "" });
  const [documentTitles, setDocumentTitles] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(5);
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [embeddingNotice, setEmbeddingNotice] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingBases, setLoadingBases] = useState(true);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savingKb, setSavingKb] = useState(false);
  const [reembedding, setReembedding] = useState(false);

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
    setEmbeddingNotice("");
    void loadDocuments(selectedId);
  }, [selectedId, selectedKb?.id]);

  async function createKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    }
  }

  async function saveKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedKb) return;
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
    if (!file || !selectedId) return;
    setUploading(true);
    setMessage("");
    setError(null);
    try {
      const form = new FormData();
      form.set("knowledgeBaseId", selectedId);
      form.set("file", file);
      await apiClient.knowledge.uploadFile(form);
      setFile(null);
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

  async function searchKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || !query.trim()) return;
    setMessage("");
    setError(null);
    setEmbeddingNotice("");
    try {
      const data = await apiClient.knowledge.search(selectedId, { query, limit });
      setSearchResults(data.results ?? []);
      const embeddings = data.embeddings as { fallback?: boolean; missing?: number; outdated?: number; invalid?: number };
      if (embeddings?.fallback || embeddings?.missing || embeddings?.outdated || embeddings?.invalid) {
        setEmbeddingNotice(`Embedding fallback detected: ${embeddings.missing ?? 0} missing, ${embeddings.outdated ?? 0} outdated, ${embeddings.invalid ?? 0} invalid.`);
      }
      setMessage((data.results ?? []).length ? "Search complete." : "No matching chunks found.");
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Knowledge search failed", message: nextError, variant: "error" });
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
    if (!selectedId) return;
    const title = documentTitles[document.id]?.trim();
    if (!title) {
      setError("Document title is required.");
      return;
    }
    setMessage("");
    setError(null);
    try {
      await apiClient.knowledge.updateDocument(selectedId, document.id, { title });
      await loadDocuments(selectedId);
      setMessage("Document renamed.");
      toast({ message: "Document renamed.", variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to rename document", message: nextError, variant: "error" });
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
    if (!selectedId) return;
    setReembedding(true);
    setMessage("");
    setError(null);
    try {
      const result = await apiClient.knowledge.reembed(selectedId, { limit: 100 });
      setMessage(`Re-embed scanned ${result.scanned} chunks and updated ${result.updated}.`);
      toast({ title: "Embeddings refreshed", message: `${result.updated} chunks updated.`, variant: "success" });
    } catch (err) {
      const nextError = err instanceof Error ? err.message : String(err);
      setError(nextError);
      toast({ title: "Unable to refresh embeddings", message: nextError, variant: "error" });
    } finally {
      setReembedding(false);
    }
  }

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
              <input className="input" value={createDraft.name} onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))} required />
            </label>
            <label>
              Description
              <textarea value={createDraft.description} onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))} rows={3} />
            </label>
            <button className="button" type="submit">Create knowledge base</button>
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
            <>
              <section className="card knowledge-summary">
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
                    <input className="input" value={editDraft.name} onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))} required />
                  </label>
                  <label>
                    Description
                    <textarea value={editDraft.description} onChange={(event) => setEditDraft((current) => ({ ...current, description: event.target.value }))} rows={3} />
                  </label>
                  <div className="actions-row">
                    <button className="button" type="submit" disabled={savingKb}>{savingKb ? "Saving..." : "Save base"}</button>
                    <ConfirmButton message={`Archive ${selectedKb.name}?`} disabled={selectedArchived} onConfirm={() => archiveKnowledgeBase(selectedKb)}>Archive</ConfirmButton>
                    <ConfirmButton className="button button--danger" message={`Delete ${selectedKb.name} and its documents?`} confirmLabel="Delete" onConfirm={() => deleteKnowledgeBase(selectedKb)}>Delete</ConfirmButton>
                  </div>
                </form>
              </section>

              <section className="card knowledge-upload">
                <div>
                  <div className="eyebrow">Upload</div>
                  <h2>Ingest documents</h2>
                  <p className="muted">Supports text, markdown, JSON, CSV, embedded-text PDFs, images via English OCR, and modern Office files. Scanned PDFs are not OCR'd directly.</p>
                </div>
                <form className="knowledge-upload-form" onSubmit={(event) => void uploadFile(event)}>
                  <label>
                    File
                    <input className="input" aria-label="File to upload" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={selectedArchived} required />
                  </label>
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
                  <button className="button button--ghost" type="button" disabled={!selectedId} onClick={() => void loadDocuments(selectedId)}>Refresh documents</button>
                </div>
                {loadingDocuments ? <LoadingBlock title="Loading documents" /> : null}
                {!loadingDocuments && documents.length === 0 ? <EmptyState title="No documents" description="Upload a file to queue extraction, chunking, and embeddings." /> : null}
                <div className="knowledge-document-list">
                  {documents.map((document) => (
                    <article className="knowledge-document-card" key={document.id}>
                      <div>
                        <input className="input" value={documentTitles[document.id] ?? document.title} onChange={(event) => setDocumentTitles((current) => ({ ...current, [document.id]: event.target.value }))} aria-label={`Title for ${document.title}`} />
                        <div className="knowledge-document-meta">
                          <StatusBadge>{document.ingest_status}</StatusBadge>
                          <span>{document.mime_type ?? metadataValue(document, "detectedType") ?? "unknown type"}</span>
                          <span>{formatSize(document.size_bytes)}</span>
                          {metadataValue(document, "chunkCount") ? <span>{metadataValue(document, "chunkCount")} chunks</span> : null}
                        </div>
                        {metadataValue(document, "error") ? <p className="error-state" role="alert">{metadataValue(document, "error")}</p> : null}
                      </div>
                      <div className="actions-row knowledge-document-actions">
                        <button className="button button--ghost" type="button" onClick={() => void renameDocument(document)}>Rename</button>
                        <ConfirmButton className="button button--danger" message={`Delete ${document.title}?`} confirmLabel="Delete" onConfirm={() => deleteDocument(document)}>Delete</ConfirmButton>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section className="card knowledge-search">
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
                    <input className="input" aria-label="Search query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ready documents" required />
                  </label>
                  <label>
                    Results
                    <input className="input" type="number" min={1} max={50} value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
                  </label>
                  <button className="button" type="submit" disabled={selectedArchived || !query.trim()}>Search knowledge</button>
                </form>
                {embeddingNotice ? <p className="warning" role="status">{embeddingNotice}</p> : null}
                {!query && searchResults.length === 0 ? <EmptyState title="No search yet" description="Search results will appear here after documents finish ingestion." /> : null}
                <div className="knowledge-search-results">
                  {searchResults.map((result) => (
                    <article key={result.chunkId} className="knowledge-search-result">
                      <strong>{result.title}</strong>
                      <p>{result.snippet}</p>
                      <div className="knowledge-score-row">
                        <span>{result.citation}</span>
                        <span>score {result.score}</span>
                        <span>lexical {result.lexicalScore ?? 0}</span>
                        <span>semantic {result.semanticScore ?? 0}</span>
                        {result.embeddingStatus ? <span>{result.embeddingStatus}</span> : null}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </main>
      </div>
    </section>
  );
}
