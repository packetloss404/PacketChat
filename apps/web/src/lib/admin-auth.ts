import { isAuthError, requireAdmin, type AuthenticatedUser } from "@packetchat/auth";
import { jsonError } from "./http";

export async function requireAdminOrJson(headers: Headers): Promise<AuthenticatedUser | Response> {
  try {
    return await requireAdmin(headers);
  } catch (error) {
    if (isAuthError(error)) return jsonError(error.message, error.status);
    throw error;
  }
}
