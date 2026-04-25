import Link from "next/link";

export default function NotFound() {
  return (
    <div className="sheet">
      <div className="sheet__inner">
        <section className="card">
          <div className="eyebrow">404</div>
          <h1>Not found</h1>
          <p className="muted">
            The page you were looking for doesn&apos;t exist, has moved, or you don&apos;t have access to it on this workspace.
          </p>
          <p>
            <Link className="button" href="/">Back to home</Link>
          </p>
        </section>
      </div>
    </div>
  );
}
