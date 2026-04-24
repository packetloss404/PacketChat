type LoadingBlockProps = {
  title?: string;
  description?: string;
};

export function LoadingBlock({ title = "Loading", description }: LoadingBlockProps) {
  return (
    <div className="loading-state ui-state" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
      </div>
    </div>
  );
}
