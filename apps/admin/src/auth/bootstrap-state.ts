import type { User } from "./AuthContext.tsx";

/**
 * State applied when a stored token is validated by /admin/auth/me (200).
 * Extracted from AuthProvider's bootstrap() so the invariant — needsSetup MUST
 * become false (not null) on token-success — is unit-testable without a DOM.
 *
 * Regression (fixed): previously the token-success path set user + loading=false
 * but never set needsSetup, leaving it null. RequireAuth (needsSetup === null)
 * and RootRedirect then rendered the full-screen Loading… forever on page
 * refresh (it worked only on first signup because signup() explicitly called
 * setNeedsSetup(false)).
 *
 * Pure module: no React / no api-client imports, so it loads cleanly under
 * `bun test` with the minimal dom-preload stub (no jsdom / testing-library dep).
 */
export type AuthBootstrapState = {
  user: User;
  loading: boolean;
  needsSetup: boolean;
};

export function tokenValidatedState(user: User): AuthBootstrapState {
  return { user, loading: false, needsSetup: false };
}
