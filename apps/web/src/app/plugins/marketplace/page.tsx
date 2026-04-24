import Link from "next/link";

type MarketplaceAgent = {
  id: string;
  name: string;
  summary: string;
  author: string;
  version: string;
  installs: string;
  tags: string[];
};

const featured: MarketplaceAgent[] = [
  {
    id: "runbook-author",
    name: "Runbook Author",
    summary: "Turns an incident summary into a numbered runbook with environment preconditions and a verification block.",
    author: "packetchat",
    version: "v7",
    installs: "412",
    tags: ["ops", "runbook"]
  },
  {
    id: "provider-healthcheck",
    name: "Provider Healthcheck",
    summary: "Pings every enabled provider account, reports p50 latency, and flags failing routes for rotation.",
    author: "packetchat",
    version: "v3",
    installs: "298",
    tags: ["providers", "diagnostics"]
  },
  {
    id: "incident-summarizer",
    name: "Incident Summarizer",
    summary: "Reads an incident Slack thread and produces a five-whys + action items postmortem draft.",
    author: "packetchat",
    version: "v12",
    installs: "184",
    tags: ["incidents", "writing"]
  },
  {
    id: "kb-chunker",
    name: "Knowledge Chunk Review",
    summary: "Audits knowledge-base chunk boundaries against source markdown headings and suggests re-embeds.",
    author: "packetchat",
    version: "v4",
    installs: "91",
    tags: ["knowledge", "kb"]
  }
];

export default function MarketplacePage() {
  return (
    <div className="sheet">
      <div className="sheet__inner">
        <h1>Agent Marketplace</h1>
        <p className="sub">
          Browse installable agents built by the community and the PacketChat core team. Install an agent to add it to your
          <Link className="link-button" href="/agents"> agent library</Link>
          where you can tune instructions, bind providers, and publish a private version.
        </p>

        <div className="alist">
          {featured.map((agent, index) => (
            <div className="arow" key={agent.id}>
              <div className="av">{agent.name.split(" ").map((word) => word[0]).slice(0, 2).join("")}</div>
              <div className="nm">
                {agent.name}
                <div className="d">{agent.summary}</div>
              </div>
              <div className="st pub">
                <span className="d" />
                {agent.version} · {agent.installs} installs
              </div>
              <div className="ac">
                {index === 0 ? "featured" : `by ${agent.author}`}
              </div>
            </div>
          ))}
        </div>

        <p className="muted" style={{ marginTop: 24, fontSize: 12 }}>
          Install is disabled while the marketplace backend is wired up. In the meantime, create an equivalent draft in the
          {" "}<Link className="link-button" href="/agents">Agents</Link>{" "}
          builder using the description as instructions.
        </p>
      </div>
    </div>
  );
}
