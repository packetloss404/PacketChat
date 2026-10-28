// Provider account and model-binding resolution moved into
// @packetchat/agent-runtime so the queue worker can reach it (the worker cannot
// import from apps/web). This shim keeps the chat and provider routes on their
// existing import path; it goes away once they import the package directly.
import {
  getEnabledModelBindingForRuntime,
  getProviderAccountForRuntime,
  ProviderCredentialError
} from "@packetchat/agent-runtime";
import { jsonError } from "./http";

export { getEnabledModelBindingForRuntime, getProviderAccountForRuntime, ProviderCredentialError };

type RuntimeProviderAccount = NonNullable<Awaited<ReturnType<typeof getProviderAccountForRuntime>>>;

/**
 * Resolves a provider account for a request, turning the two expected failures
 * into JSON responses: a missing account (404) and a stored credential that
 * cannot be decrypted (502). Any other error is a bug and is rethrown.
 */
export async function resolveProviderAccountOrJson(
  accountId: string,
  options: { includeDisabled?: boolean } = {}
): Promise<{ account: RuntimeProviderAccount } | { error: Response }> {
  try {
    const account = await getProviderAccountForRuntime(accountId, options);
    if (!account) return { error: jsonError("Provider account not found", 404) };
    return { account };
  } catch (error) {
    if (error instanceof ProviderCredentialError) return { error: jsonError(error.message, 502) };
    throw error;
  }
}
