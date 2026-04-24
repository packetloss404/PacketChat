import Link from "next/link";

const quickActions = [
  { href: "/chat", title: "Open chat", description: "Start or resume a conversation with your configured model routes." },
  { href: "/knowledge", title: "Manage knowledge", description: "Upload documents, check ingestion, and test retrieval snippets." },
  { href: "/agents", title: "Build agents", description: "Configure instructions, tools, knowledge, and published test runs." },
  { href: "/providers", title: "Provider settings", description: "Manage global keys, BYOK accounts, model sync, and diagnostics." }
];

const systemAreas: Array<[string, string]> = [
  ["Workspace", "Chat, projects, and agents are private to each signed-in user."],
  ["Routing", "Provider accounts choose the model route; PacketChat keeps account/provider mismatches out of chat."],
  ["Knowledge", "Local extraction and deterministic embeddings support retrieval without external vector services."],
  ["Operations", "Docker Compose runs web, worker, Postgres, Redis, and MinIO behind your external proxy."]
];

export default function HomePage() {
  return (
    <div className="sheet">
      <div className="sheet__inner">
        <h1>PacketChat · self-hosted workspace</h1>
        <p className="sub">Private chat, knowledge, providers, and agents routed through a small-instance workspace for local users, admin-managed provider keys, optional BYOK, and operational visibility.</p>

        <div className="home-dashboard">
          <div className="home-dashboard__quick-grid">
            {quickActions.map((action) => (
              <Link className="card home-dashboard__quick-card" href={action.href} key={action.href}>
                <h2>{action.title}</h2>
                <p className="muted">{action.description}</p>
              </Link>
            ))}
          </div>

          <h2>How the pieces fit</h2>
          <div className="grid">
            {systemAreas.map(([title, description]) => (
              <article className="card card--flat" key={title}>
                <h3>{title}</h3>
                <p className="muted">{description}</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
