import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

/**
 * A folder entry from OneDrive as returned by the folder picker.
 */
export interface OneDriveFolderEntry {
  /** Folder name */
  name: string;
  /** Full path from drive root (e.g. /Apps/IntimaPic) */
  path: string;
  /** Whether this folder contains a Cryptomator vault (masterkey.cryptomator exists) */
  hasVault: boolean;
  /** Whether the folder is completely empty (no children at all) */
  isEmpty: boolean;
  /** Whether this folder was just created in this session */
  justCreated: boolean;
}

/**
 * Service to browse OneDrive folders during vault setup.
 * Authenticates via MSAL popup and uses the Graph API to list folders.
 *
 * This is intentionally separate from OneDriveAdapter to keep the
 * setup flow decoupled from the runtime storage adapter.
 */
@Injectable({ providedIn: 'root' })
export class OneDriveFolderPickerService {
  private readonly GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
  private readonly SCOPES = ['Files.ReadWrite.AppFolder', 'Files.ReadWrite'];

  private msalInstance: import('@azure/msal-browser').IPublicClientApplication | null = null;
  private msalInitPromise: Promise<import('@azure/msal-browser').IPublicClientApplication> | null = null;
  private accessToken: string | null = null;

  /**
   * Authenticate with OneDrive and return an access token.
   * Uses MSAL popup flow (PKCE).
   */
  async authenticate(clientId: string, tenantId?: string): Promise<void> {
    const msalInstance = await this.getMsalInstance(clientId, tenantId);

    // Try silent first
    try {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        const silentResult = await msalInstance.acquireTokenSilent({
          scopes: this.SCOPES,
          account: accounts[0],
        });
        this.accessToken = silentResult.accessToken;
        return;
      }
    } catch {
      // Fall through to popup
    }

    // Interactive popup
    try {
      const result = await msalInstance.acquireTokenPopup({
        scopes: this.SCOPES,
      });
      this.accessToken = result.accessToken;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('interaction_in_progress')) {
        this.clearStaleInteractionStatus();
        this.msalInstance = null;
        this.msalInitPromise = null;
        const freshInstance = await this.getMsalInstance(clientId, tenantId);
        const result = await freshInstance.acquireTokenPopup({
          scopes: this.SCOPES,
        });
        this.accessToken = result.accessToken;
      } else {
        throw err;
      }
    }
  }

  /**
   * Whether we have a valid access token (authenticated).
   */
  isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  /**
   * List child folders at the given path.
   * @param parentPath - Absolute path (e.g. "/" for root, "/Apps" etc.)
   * @returns Array of folder entries
   */
  async listFolders(parentPath: string): Promise<OneDriveFolderEntry[]> {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    const url = parentPath === '/' || parentPath === ''
      ? `${this.GRAPH_BASE}/me/drive/root/children?$filter=folder ne null&$select=id,name,parentReference,folder`
      : `${this.GRAPH_BASE}/me/drive/root:${parentPath}:/children?$filter=folder ne null&$select=id,name,parentReference,folder`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to list folders: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      value: Array<{ id: string; name: string; folder?: { childCount: number } }>;
    };

    return data.value
      .filter(item => item.folder)
      .map(item => ({
        name: item.name,
        path: parentPath === '/' ? `/${item.name}` : `${parentPath}/${item.name}`,
        hasVault: false,
        isEmpty: item.folder!.childCount === 0,
        justCreated: false,
      }));
  }

  /**
   * Check if a folder has any children (files or folders).
   * Used to determine if a folder is truly empty.
   */
  async isFolderEmpty(folderPath: string): Promise<boolean> {
    if (!this.accessToken) return false;

    const url = `${this.GRAPH_BASE}/me/drive/root:${folderPath}:/children?$top=1&$select=id`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) return false;

    const data = await response.json() as { value: Array<{ id: string }> };
    return data.value.length === 0;
  }

  /**
   * Check if a vault exists at the given path (masterkey.cryptomator present).
   */
  async checkVaultExists(folderPath: string): Promise<boolean> {
    if (!this.accessToken) return false;

    const url = `${this.GRAPH_BASE}/me/drive/root:${folderPath}/masterkey.cryptomator`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    return response.ok;
  }

  /**
   * Create a new folder at the given path.
   * @param parentPath - Parent path (e.g. "/Apps")
   * @param folderName - Name of the new folder
   * @returns The full path of the created folder
   */
  async createFolder(parentPath: string, folderName: string): Promise<string> {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    const url = parentPath === '/' || parentPath === ''
      ? `${this.GRAPH_BASE}/me/drive/root/children`
      : `${this.GRAPH_BASE}/me/drive/root:${parentPath}:/children`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    });

    if (!response.ok) {
      if (response.status === 409) {
        throw new Error(`Ordner "${folderName}" existiert bereits.`);
      }
      throw new Error(`Ordner konnte nicht erstellt werden: ${response.status}`);
    }

    return parentPath === '/' ? `/${folderName}` : `${parentPath}/${folderName}`;
  }

  /**
   * Clean up tokens and MSAL state.
   */
  reset(): void {
    this.accessToken = null;
    this.msalInstance = null;
    this.msalInitPromise = null;
  }

  // ─── Private ──────────────────────────────────────────────────────

  private async getMsalInstance(clientId: string, tenantId?: string): Promise<import('@azure/msal-browser').IPublicClientApplication> {
    if (this.msalInstance) return this.msalInstance;
    if (this.msalInitPromise) return this.msalInitPromise;

    this.msalInitPromise = (async () => {
      const { PublicClientApplication, BrowserCacheLocation } = await import('@azure/msal-browser');

      const resolvedClientId = clientId || environment.azure.defaultClientId;
      const resolvedTenantId = tenantId || environment.azure.defaultTenantId || 'common';

      if (!resolvedClientId) {
        throw new Error('Keine Azure Client ID konfiguriert.');
      }

      const msalConfig = {
        auth: {
          clientId: resolvedClientId,
          authority: `https://login.microsoftonline.com/${resolvedTenantId}`,
          redirectUri: new URL('auth-redirect', document.baseURI).href,
        },
        cache: {
          cacheLocation: BrowserCacheLocation.LocalStorage,
        },
      };

      this.clearStaleInteractionStatus();

      const instance = new PublicClientApplication(msalConfig);
      await instance.initialize();
      await instance.handleRedirectPromise();

      this.msalInstance = instance;
      return instance;
    })();

    return this.msalInitPromise;
  }

  private clearStaleInteractionStatus(): void {
    const sessionKeysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && (key.includes('interaction.status') || key.includes('interaction_in_progress'))) {
        sessionKeysToRemove.push(key);
      }
    }
    sessionKeysToRemove.forEach(key => sessionStorage.removeItem(key));

    const localKeysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.includes('interaction.status') || key.includes('interaction_in_progress'))) {
        localKeysToRemove.push(key);
      }
    }
    localKeysToRemove.forEach(key => localStorage.removeItem(key));
  }
}
