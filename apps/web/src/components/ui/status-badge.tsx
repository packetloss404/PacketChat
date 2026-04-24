type StatusBadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

type StatusBadgeProps = {
  children: string;
  tone?: StatusBadgeTone;
};

const statusTone: Record<string, StatusBadgeTone> = {
  active: "success",
  enabled: "success",
  ready: "success",
  completed: "success",
  published: "success",
  running: "info",
  pending: "warning",
  queued: "warning",
  draft: "warning",
  archived: "neutral",
  disabled: "neutral",
  failed: "danger",
  error: "danger"
};

export function StatusBadge({ children, tone }: StatusBadgeProps) {
  const normalized = children.toLowerCase();
  const nextTone = tone ?? statusTone[normalized] ?? "neutral";
  return <span className={`status-badge status-badge--${nextTone}`}>{children}</span>;
}
