/**
 * Application environment configuration.
 *
 * Default Azure App Registration values can be set here.
 * Users can override these in the setup wizard.
 *
 * For self-hosted deployments, replace the values below with your own
 * Azure App Registration details, or leave them empty to require manual entry.
 */
export const environment = {
  production: false,

  /**
   * Default Azure App Registration (Client) ID.
   * Leave empty to require the user to enter their own.
   */
  azure: {
    defaultClientId: '',
    defaultTenantId: 'common',
  },
};
