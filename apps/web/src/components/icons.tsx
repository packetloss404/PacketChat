import type { SVGProps } from "react";

type I = SVGProps<SVGSVGElement>;

const base: I = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};

export const Icon = {
  sidebar: (p: I = {}) => (
    <svg {...base} {...p}><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
  ),
  bookmark: (p: I = {}) => (
    <svg {...base} {...p}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
  ),
  edit: (p: I = {}) => (
    <svg {...base} {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
  ),
  copy: (p: I = {}) => (
    <svg {...base} {...p}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
  ),
  plus: (p: I = {}) => (
    <svg {...base} {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  ),
  search: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
  ),
  grid: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
  ),
  layers: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
  ),
  users: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
  key: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
  ),
  folder: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
  ),
  chat: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  ),
  text: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
  ),
  mic: (p: I = {}) => (
    <svg {...base} {...p}><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
  ),
  attach: (p: I = {}) => (
    <svg {...base} {...p}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
  ),
  mixer: (p: I = {}) => (
    <svg {...base} {...p}><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
  ),
  up: (p: I = {}) => (
    <svg {...base} width={14} height={14} strokeWidth={2.2} {...p}><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
  ),
  chev: (p: I = {}) => (
    <svg {...base} width={12} height={12} {...p}><polyline points="6 9 12 15 18 9"/></svg>
  ),
  caret: (p: I = {}) => (
    <svg {...base} width={10} height={10} strokeWidth={2} {...p}><polyline points="9 18 15 12 9 6"/></svg>
  ),
  dots: (p: I = {}) => (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" {...p}><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
  ),
  memories: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/></svg>
  ),
  params: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><line x1="3" y1="7" x2="13" y2="7"/><line x1="17" y1="7" x2="21" y2="7"/><circle cx="15" cy="7" r="2"/><line x1="3" y1="17" x2="7" y2="17"/><line x1="11" y1="17" x2="21" y2="17"/><circle cx="9" cy="17" r="2"/></svg>
  ),
  mcp: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
  ),
  hidePanel: (p: I = {}) => (
    <svg {...base} width={15} height={15} {...p}><line x1="21" y1="5" x2="21" y2="19"/><polyline points="4 12 14 12"/><polyline points="10 8 14 12 10 16"/></svg>
  ),
  logout: (p: I = {}) => (
    <svg {...base} {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
  )
};
