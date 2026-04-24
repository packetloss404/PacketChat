import type { ReactNode } from "react";

export function PageShell({ children }: { children: ReactNode }) {
  return <section className="page-shell">{children}</section>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {description ? <p className="muted page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </div>
  );
}

export function PageSection({ children }: { children: ReactNode }) {
  return <section className="card page-section">{children}</section>;
}
