import Link from "next/link";

const quickActions = [
  { href: "/chat", title: "Open chat", description: "Start or resume a conversation with your configured model routes." },
  { href: "/knowledge", title: "Manage knowledge", description: "Upload documents, check ingestion, and test retrieval snippets." },
  { href: "/agents", title: "Build agents", description: "Configure instructions, tools, knowledge, and published test runs." },
  { href: "/providers", title: "Provider settings", description: "Manage global keys, BYOK accounts, model sync, and diagnostics." }
];

const systemAreas = [
  ["Workspace", "Chat, projects, and agents are private to each signed-in user."],
  ["Routing", "Provider accounts choose the model route; PacketChat keeps account/provider mismatches out of chat."],
  ["Knowledge", "Local extraction and deterministic embeddings support retrieval without external vector services."],
  ["Operations", "Docker Compose runs web, worker, Postgres, Redis, and MinIO behind your external proxy."]
];

export default function HomePage() {
  return (
    <section className="home-dashboard">
      <div className="card card--hero home-dashboard__hero">
        <div>
          <div className="eyebrow">Self-hosted AI workspace</div>
          <h1>Private chat, knowledge, providers, and agents routed through PacketChat.</h1>
          <p className="muted">A small-instance workspace for local users, admin-managed provider keys, optional BYOK, persistent conversations, and operational visibility.</p>
        </div>
        <div className="home-dashboard__actions">
          <Link className="button" href="/chat">Start chatting</Link>
          <Link className="button button--ghost" href="/providers">Configure routes</Link>
        </div>
      </div>

      <div className="home-dashboard__quick-grid">
        {quickActions.map((action) => (
          <Link className="card home-dashboard__quick-card" href={action.href} key={action.href}>
            <h2>{action.title}</h2>
            <p className="muted">{action.description}</p>
          </Link>
        ))}
      </div>

      <section className="card home-dashboard__system">
        <div>
          <div className="eyebrow">Instance map</div>
          <h2>How the pieces fit</h2>
        </div>
        <div className="grid">
          {systemAreas.map(([title, description]) => (
            <article className="card card--flat" key={title}>
              <h3>{title}</h3>
              <p className="muted">{description}</p>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
