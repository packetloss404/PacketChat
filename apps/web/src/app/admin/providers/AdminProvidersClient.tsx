"use client";

import { ProvidersManager } from "../../../components/providers/providers-manager";
import { useAuth } from "../../../components/auth-provider";
import { EmptyState, LoadingBlock } from "../../../components/ui";

export function AdminProvidersClient() {
  const { status, user } = useAuth();

  if (status === "loading") return <LoadingBlock title="Loading providers" />;
  if (user?.role !== "admin") {
    return (
      <EmptyState
        title="Admin access required"
        description="Provider accounts and API keys are managed by administrators. Ask an admin if you need a provider added or changed."
      />
    );
  }

  return <ProvidersManager />;
}
