/**
 * Fixed credentials used by the E2E suite. The setup project creates this
 * admin via first-run signup against a fresh database; the login spec reuses
 * the same credentials. Change here only — every test imports from here.
 */
export const ADMIN_EMAIL = "admin@e2e.local";
export const ADMIN_USERNAME = "e2eadmin";
export const ADMIN_PASSWORD = "E2E-Admin-Passw0rd!";
