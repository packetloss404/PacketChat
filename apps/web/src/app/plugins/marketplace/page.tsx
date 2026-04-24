export default function MarketplacePage() {
  return (
    <div className="coming-soon" role="region" aria-label="Agent Marketplace — feature coming soon">
      <svg className="coming-soon__art" viewBox="0 0 320 240" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="cs-brand" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#d97757" />
            <stop offset="1" stopColor="#a94f2f" />
          </linearGradient>
          <linearGradient id="cs-sat" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#33333a" />
            <stop offset="1" stopColor="#1d1d1f" />
          </linearGradient>
          <radialGradient id="cs-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#d97757" stopOpacity="0.25" />
            <stop offset="1" stopColor="#d97757" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx="160" cy="120" r="110" fill="url(#cs-glow)" />

        <g stroke="#33333a" strokeWidth="1" fill="none" strokeDasharray="3 5" opacity="0.6">
          <circle cx="160" cy="120" r="62" />
          <circle cx="160" cy="120" r="92" />
        </g>

        <g>
          <circle cx="160" cy="120" r="34" fill="url(#cs-brand)" />
          <circle cx="160" cy="120" r="18" fill="#0f0f10" />
        </g>

        <g>
          <circle cx="98" cy="120" r="12" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
          <circle cx="98" cy="120" r="5" fill="#d97757" opacity="0.9" />
        </g>
        <g>
          <circle cx="222" cy="120" r="14" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
          <circle cx="222" cy="120" r="6" fill="#7c3aed" opacity="0.85" />
        </g>
        <g>
          <circle cx="160" cy="58" r="10" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
          <circle cx="160" cy="58" r="4" fill="#1fb8cd" opacity="0.9" />
        </g>
        <g>
          <circle cx="116" cy="178" r="11" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
          <circle cx="116" cy="178" r="4.5" fill="#10a37f" opacity="0.9" />
        </g>
        <g>
          <circle cx="214" cy="176" r="12" fill="url(#cs-sat)" stroke="#3b3b3f" strokeWidth="1" />
          <circle cx="214" cy="176" r="5" fill="#c49a3a" opacity="0.9" />
        </g>

        <g fill="#ececec" opacity="0.9">
          <path d="M78 46 L80 51 L85 53 L80 55 L78 60 L76 55 L71 53 L76 51 Z" />
          <path d="M258 50 L259 53 L262 54 L259 55 L258 58 L257 55 L254 54 L257 53 Z" opacity="0.7" />
          <path d="M50 200 L51.5 203.5 L55 205 L51.5 206.5 L50 210 L48.5 206.5 L45 205 L48.5 203.5 Z" opacity="0.6" />
        </g>
      </svg>

      <div className="coming-soon__caption">feature coming soon</div>
    </div>
  );
}
