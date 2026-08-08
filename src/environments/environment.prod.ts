/**
 * Production environment configuration.
 *
 * In CI/CD (GitHub Actions), the placeholder __AZURE_CLIENT_ID__ is replaced
 * with the actual value from the AZURE_CLIENT_ID secret before the build runs.
 * For local builds, leave the placeholder or set your own value.
 *
 * Users can still override these in the setup wizard.
 */
export const environment = {
  production: true,

  /**
   * Default Azure App Registration (Client) ID.
   * Replaced at build time in CI via GitHub Secrets.
   * Leave as-is for local builds (users will enter it manually in setup).
   */
  azure: {
    defaultClientId: '__AZURE_CLIENT_ID__',
    defaultTenantId: '__AZURE_TENANT_ID__',
  },
};
