import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentAccessCapabilities, type AgentAccessRole } from "./agent-access";

test("agent access capabilities keep viewer read-only and runner runnable", () => {
  const expectations: Record<AgentAccessRole, ReturnType<typeof getAgentAccessCapabilities>> = {
    viewer: {
      canView: true,
      canRun: false,
      canEdit: false,
      canShare: false,
      canDelete: false
    },
    runner: {
      canView: true,
      canRun: true,
      canEdit: false,
      canShare: false,
      canDelete: false
    },
    editor: {
      canView: true,
      canRun: true,
      canEdit: true,
      canShare: false,
      canDelete: false
    },
    owner: {
      canView: true,
      canRun: true,
      canEdit: true,
      canShare: true,
      canDelete: true
    }
  };

  for (const [role, capabilities] of Object.entries(expectations) as Array<[AgentAccessRole, ReturnType<typeof getAgentAccessCapabilities>]>) {
    assert.deepEqual(getAgentAccessCapabilities(role), capabilities);
  }
});
