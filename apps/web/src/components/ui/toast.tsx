"use client";

import { createContext, ReactNode, useContext, useMemo, useState } from "react";

type ToastVariant = "info" | "success" | "error" | "warning";

type Toast = {
  id: number;
  title?: string;
  message: string;
  variant: ToastVariant;
};

type ToastInput = string | {
  title?: string;
  message: string;
  variant?: ToastVariant;
};

type ToastContextValue = {
  toast: (input: ToastInput) => void;
  dismissToast: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const value = useMemo<ToastContextValue>(() => ({
    toast(input) {
      const nextToast = typeof input === "string"
        ? { id: Date.now(), message: input, variant: "info" as const }
        : { id: Date.now(), variant: "info" as const, ...input };

      setToasts((current) => [...current, nextToast]);
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== nextToast.id));
      }, 5000);
    },
    dismissToast(id) {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }
  }), []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div className={`toast toast--${toast.variant}`} role={toast.variant === "error" ? "alert" : "status"} key={toast.id}>
            <div>
              {toast.title ? <strong>{toast.title}</strong> : null}
              <p>{toast.message}</p>
            </div>
            <button className="toast__close" type="button" aria-label="Dismiss notification" onClick={() => value.dismissToast(toast.id)}>
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context.toast;
}
