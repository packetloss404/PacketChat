"use client";

import { ReactNode, useState } from "react";

type ConfirmButtonProps = {
  children: ReactNode;
  confirmLabel?: string;
  message: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  disabled?: boolean;
};

export function ConfirmButton({ children, confirmLabel = "Confirm", message, onConfirm, className = "button secondary", disabled }: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);

  async function handleConfirm() {
    setRunning(true);
    try {
      await onConfirm();
      setConfirming(false);
    } finally {
      setRunning(false);
    }
  }

  if (confirming) {
    return (
      <span className="confirm-inline" role="group" aria-label={message}>
        <span>{message}</span>
        <button className="button" type="button" disabled={running} onClick={() => void handleConfirm()}>
          {running ? "Working..." : confirmLabel}
        </button>
        <button className="button button--ghost" type="button" disabled={running} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button className={className} type="button" disabled={disabled} onClick={() => setConfirming(true)}>
      {children}
    </button>
  );
}
