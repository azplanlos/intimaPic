import { Injectable } from '@angular/core';

/**
 * Provides access to the native WebAuthn API by creating a temporary
 * same-origin iframe. This bypasses password manager extensions (like 1Password)
 * that monkey-patch navigator.credentials on the main window.
 *
 * Password managers inject content scripts into the top-level document and
 * replace navigator.credentials.create/get with their own wrappers.
 * A dynamically created same-origin iframe gets a fresh browsing context
 * with the original, unpatched WebAuthn API.
 *
 * Requirements:
 * - The app must be served over HTTPS (required for WebAuthn anyway)
 * - Same-origin iframes can use WebAuthn without additional permissions
 */
@Injectable({ providedIn: 'root' })
export class NativeWebAuthnService {

  /**
   * Call navigator.credentials.create() using the native (unpatched) API.
   */
  async create(options: CredentialCreationOptions): Promise<PublicKeyCredential | null> {
    const iframe = this.createHiddenIframe();
    try {
      const iframeCredentials = iframe.contentWindow!.navigator.credentials;
      const credential = await iframeCredentials.create(options);
      return credential as PublicKeyCredential | null;
    } finally {
      this.removeIframe(iframe);
    }
  }

  /**
   * Call navigator.credentials.get() using the native (unpatched) API.
   */
  async get(options: CredentialRequestOptions): Promise<PublicKeyCredential | null> {
    const iframe = this.createHiddenIframe();
    try {
      const iframeCredentials = iframe.contentWindow!.navigator.credentials;
      const credential = await iframeCredentials.get(options);
      return credential as PublicKeyCredential | null;
    } finally {
      this.removeIframe(iframe);
    }
  }

  /**
   * Check if the native platform authenticator is available (bypassing 1Password's
   * patched version of PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable).
   */
  async isPlatformAuthenticatorAvailable(): Promise<boolean> {
    const iframe = this.createHiddenIframe();
    try {
      const iframeWindow = iframe.contentWindow as Window & typeof globalThis;
      const iframePKC = iframeWindow.PublicKeyCredential;
      if (!iframePKC) return false;
      return await iframePKC.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    } finally {
      this.removeIframe(iframe);
    }
  }

  private createHiddenIframe(): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    // Same-origin about:blank iframe inherits the parent origin
    // and has access to WebAuthn without needing allow= attributes.
    iframe.style.display = 'none';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = 'none';
    iframe.style.position = 'absolute';
    iframe.style.top = '-9999px';
    // Ensure the iframe is same-origin (about:blank inherits parent origin)
    iframe.src = 'about:blank';
    document.body.appendChild(iframe);
    return iframe;
  }

  private removeIframe(iframe: HTMLIFrameElement): void {
    iframe.remove();
  }
}
