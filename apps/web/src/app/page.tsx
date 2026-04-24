export default function HomePage() {
  return (
    <section className="card">
      <div className="eyebrow">Self-hosted AI workspace</div>
      <h1>PacketChat foundation is ready for implementation.</h1>
      <p className="muted">
        V1 is scoped for local users, admin-managed provider keys, optional per-user BYOK, private chats, knowledge, and a full agent builder.
      </p>
      <div className="grid">
        <div className="card">
          <h3>Providers</h3>
          <p className="muted">OpenAI-compatible, Azure OpenAI, Anthropic, Perplexity, and Minimax adapters are scaffolded.</p>
        </div>
        <div className="card">
          <h3>BYOK</h3>
          <p className="muted">Admin can toggle per-user BYOK while beta users can use global provider keys.</p>
        </div>
        <div className="card">
          <h3>Deploy</h3>
          <p className="muted">Docker Compose runs web, worker, Postgres, Redis, and MinIO behind your external proxy.</p>
        </div>
      </div>
    </section>
  );
}
