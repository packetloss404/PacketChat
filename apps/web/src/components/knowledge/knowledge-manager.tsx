"use client";

import { useEffect, useState } from "react";
import { authFetch } from "../../lib/auth-client";
import { ConfirmButton, EmptyState, LoadingBlock, StatusBadge, useToast } from "../ui";

type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  document_count: number;
};

type KnowledgeDocument = {
  id: string;
  title: string;
  mime_type: string | null;
  ingest_status: string;
  source_metadata?: { error?: string } | null;
  size_bytes: string | number | null;
  created_at: string;
};

type SearchResult = {
  documentId: string;
  chunkId: string;
  chunkIndex: number;
  title: string;
  score: number;
  lexicalScore?: number;
  semanticScore?: number;
  snippet: string;
  citation: string;
};

export function KnowledgeManager() {
  const toast = useToast();
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [message, setMessage] = useState("");
  const [loadingBases, setLoadingBases] = useState(true);
  const [loadingDocuments, setLoadingDocuments] = useState(false);

  async function api(path: string, init: RequestInit = {}) {
    const response = await authFetch(path, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message ?? "Request failed");
    return data;
  }

  async function loadKnowledgeBases() {
    setLoadingBases(true);
    try {
      const data = await api("/api/knowledge");
      setKnowledgeBases(data.knowledgeBases ?? []);
      setSelectedId((current) => current || data.knowledgeBases?.[0]?.id || "");
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
      const data = await api(`/api/knowledge/${knowledgeBaseId}/documents`);
      setDocuments(data.documents ?? []);
    } finally {
      setLoadingDocuments(false);
    }
  }

  useEffect(() => {
    loadKnowledgeBases().catch((error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    loadDocuments(selectedId).catch((error) => setMessage(error.message));
  }, [selectedId]);

  async function createKnowledgeBase(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      const data = await api("/api/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description })
      });
      setName("");
      setDescription("");
      setSelectedId(data.knowledgeBaseId);
      await loadKnowledgeBases();
      setMessage("Knowledge base created.");
      toast({ message: "Knowledge base created.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to create knowledge base", message: nextError, variant: "error" });
    }
  }

  async function uploadFile(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !selectedId) return;
    setMessage("");
    try {
      const form = new FormData();
      form.set("knowledgeBaseId", selectedId);
      form.set("file", file);
      await api("/api/files/upload", { method: "POST", body: form });
      setFile(null);
      await loadDocuments(selectedId);
      await loadKnowledgeBases();
      setMessage("File uploaded and queued for ingestion.");
      toast({ message: "File uploaded and queued for ingestion.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to upload file", message: nextError, variant: "error" });
    }
  }

  async function searchKnowledge(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId || !query.trim()) return;
    setMessage("");
    try {
      const data = await api(`/api/knowledge/${selectedId}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query })
      });
      setSearchResults(data.results ?? []);
      setMessage((data.results ?? []).length ? "Search complete." : "No matching chunks found.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function updateKnowledgeBase(kb: KnowledgeBase) {
    const nextName = window.prompt("Knowledge base name", kb.name);
    if (nextName == null) return;
    const nextDescription = window.prompt("Knowledge base description", kb.description ?? "");
    if (nextDescription == null) return;
    setMessage("");
    try {
      await api(`/api/knowledge/${kb.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nextName, description: nextDescription })
      });
      await loadKnowledgeBases();
      setMessage("Knowledge base updated.");
      toast({ message: "Knowledge base updated.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to update knowledge base", message: nextError, variant: "error" });
    }
  }

  async function archiveKnowledgeBase(kb: KnowledgeBase) {
    setMessage("");
    try {
      await api(`/api/knowledge/${kb.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true })
      });
      await loadKnowledgeBases();
      setMessage("Knowledge base archived.");
      toast({ message: "Knowledge base archived.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to archive knowledge base", message: nextError, variant: "error" });
    }
  }

  async function deleteKnowledgeBase(kb: KnowledgeBase) {
    setMessage("");
    try {
      await api(`/api/knowledge/${kb.id}`, { method: "DELETE" });
      setKnowledgeBases((current) => current.filter((item) => item.id !== kb.id));
      if (selectedId === kb.id) {
        setSelectedId("");
        setDocuments([]);
        setSearchResults([]);
      }
      setMessage("Knowledge base deleted.");
      toast({ message: "Knowledge base deleted.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to delete knowledge base", message: nextError, variant: "error" });
    }
  }

  async function renameDocument(document: KnowledgeDocument) {
    if (!selectedId) return;
    const title = window.prompt("Document title", document.title);
    if (title == null) return;
    setMessage("");
    try {
      await api(`/api/knowledge/${selectedId}/documents/${document.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title })
      });
      await loadDocuments(selectedId);
      setMessage("Document renamed.");
      toast({ message: "Document renamed.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to rename document", message: nextError, variant: "error" });
    }
  }

  async function deleteDocument(document: KnowledgeDocument) {
    if (!selectedId) return;
    setMessage("");
    try {
      await api(`/api/knowledge/${selectedId}/documents/${document.id}`, { method: "DELETE" });
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      await loadKnowledgeBases();
      setMessage("Document deleted.");
      toast({ message: "Document deleted.", variant: "success" });
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      setMessage(nextError);
      toast({ title: "Unable to delete document", message: nextError, variant: "error" });
    }
  }

  return (
    <div className="grid knowledge-page">
      <section className="card">
        <div className="eyebrow">Knowledge</div>
        <h1>Private knowledge bases</h1>
        <p className="muted">Create user-owned knowledge bases, ingest documents, and search ready chunks with hybrid local retrieval.</p>
        {message ? <p className={message.toLowerCase().includes("failed") || message.toLowerCase().includes("missing") ? "error-state" : "notice"} role="status">{message}</p> : null}

        <form onSubmit={createKnowledgeBase}>
          <label>
            Name
              <input className="input" aria-label="Knowledge base name" value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Description
              <textarea aria-label="Knowledge base description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
          </label>
          <button className="button" type="submit">Create knowledge base</button>
        </form>
      </section>

      <section className="card">
        <h2>Upload file</h2>
        <form onSubmit={uploadFile}>
          <label>
            Knowledge base
              <select aria-label="Knowledge base" value={selectedId} onChange={(event) => setSelectedId(event.target.value)} required>
              <option value="">Select a knowledge base</option>
              {knowledgeBases.map((kb) => (
                <option value={kb.id} key={kb.id}>{kb.name}</option>
              ))}
            </select>
          </label>
          <label>
            File
              <input className="input" aria-label="File to upload" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
          </label>
          <button className="button" type="submit" disabled={!selectedId || !file}>Upload and queue</button>
        </form>
      </section>

      <section className="card">
        <h2>Your knowledge bases</h2>
        <button className="button secondary" type="button" onClick={() => loadKnowledgeBases().catch((error) => setMessage(error.message))}>
          Refresh list
        </button>
        {loadingBases ? <LoadingBlock title="Loading knowledge bases" /> : null}
        {!loadingBases && knowledgeBases.length === 0 ? <EmptyState title="No knowledge bases" description="Create one before uploading documents." /> : null}
        {knowledgeBases.map((kb) => (
          <div className="card" key={kb.id} style={{ boxShadow: "none" }}>
            <button className="input" type="button" onClick={() => setSelectedId(kb.id)}>
              {kb.name} ({kb.document_count} docs) <StatusBadge>{kb.status}</StatusBadge>
            </button>
            {kb.description ? <p className="muted">{kb.description}</p> : null}
            <div className="actions-row">
              <button className="button secondary" type="button" onClick={() => updateKnowledgeBase(kb)}>Edit</button>
              <ConfirmButton message={`Archive ${kb.name}?`} disabled={kb.status === "archived"} onConfirm={() => archiveKnowledgeBase(kb)}>Archive</ConfirmButton>
              <ConfirmButton message={`Delete ${kb.name} and its documents?`} confirmLabel="Delete" onConfirm={() => deleteKnowledgeBase(kb)}>Delete</ConfirmButton>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Documents</h2>
        <button className="button secondary" type="button" disabled={!selectedId} onClick={() => loadDocuments(selectedId).catch((error) => setMessage(error.message))}>
          Refresh documents
        </button>
        {loadingDocuments ? <LoadingBlock title="Loading documents" /> : null}
        {!loadingDocuments && documents.length === 0 ? <EmptyState title="No documents" description="No documents are queued for this knowledge base." /> : null}
        {documents.map((document) => (
          <article className="card" key={document.id} style={{ boxShadow: "none" }}>
            <strong>{document.title}</strong><br />
            <span className="muted"><StatusBadge>{document.ingest_status}</StatusBadge> {document.mime_type ?? "unknown type"}</span>
            {document.source_metadata?.error ? <><br /><span className="muted">{document.source_metadata.error}</span></> : null}
            <div className="actions-row knowledge-document-actions">
              <button className="button secondary" type="button" onClick={() => renameDocument(document)}>Rename</button>
              <ConfirmButton message={`Delete ${document.title}?`} confirmLabel="Delete" onConfirm={() => deleteDocument(document)}>Delete</ConfirmButton>
            </div>
          </article>
        ))}
      </section>

      <section className="card">
        <h2>Search</h2>
        <form onSubmit={searchKnowledge}>
          <label>
            Query
             <input className="input" aria-label="Search query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ready documents" required />
          </label>
          <button className="button" type="submit" disabled={!selectedId || !query.trim()}>Search knowledge</button>
        </form>
        {!query && searchResults.length === 0 ? <EmptyState title="No search yet" description="Search results will appear here after documents finish ingestion." /> : null}
        {searchResults.map((result) => (
          <article key={result.chunkId} className="card">
            <strong>{result.title}</strong>
            <p className="muted">{result.citation} - score {result.score} - lexical {result.lexicalScore ?? 0} - semantic {result.semanticScore ?? 0}</p>
            <p>{result.snippet}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
