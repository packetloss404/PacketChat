type Plugin = {
  id: string;
  name: string;
  author: string;
  summary: string;
  tint: string;
  initials: string;
};

const catalog: Plugin[] = [
  {
    id: "perplexity-search",
    name: "Perplexity Search",
    author: "Perplexity",
    summary: "Live web search with cited sources. Drops fresh results into chat context without leaving the conversation.",
    tint: "#1fb8cd",
    initials: "PS"
  },
  {
    id: "deep-research",
    name: "Deep Research",
    author: "packetchat",
    summary: "Plans a multi-step research task, runs iterative searches, and returns a sourced brief with confidence notes.",
    tint: "#7c3aed",
    initials: "DR"
  },
  {
    id: "gpt-image-editor",
    name: "GPT Image Editor",
    author: "OpenAI",
    summary: "Generate, edit, and mask images inline. Supports inpainting, variations, and style references.",
    tint: "#10a37f",
    initials: "IE"
  }
];

export default function PluginsPage() {
  return (
    <div className="sheet">
      <div className="sheet__inner">
        <h1>Plugins</h1>
        <p className="sub">Extend chat and agents with optional capabilities. Each plugin is scoped per agent; nothing is enabled globally.</p>

        <div className="plugin-grid">
          {catalog.map((plugin) => (
            <article className="plugin-card" key={plugin.id}>
              <div className="plugin-card__head">
                <div className="plugin-card__logo" style={{ background: plugin.tint }} aria-hidden="true">
                  {plugin.initials}
                </div>
                <div className="plugin-card__meta">
                  <div className="plugin-card__name">{plugin.name}</div>
                  <div className="plugin-card__author">by {plugin.author}</div>
                </div>
              </div>
              <p className="plugin-card__summary">{plugin.summary}</p>
              <div className="plugin-card__foot">
                <span className="plugin-card__pending" aria-label={`${plugin.name} is pending`}>Pending</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
