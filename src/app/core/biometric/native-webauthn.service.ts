import { Injectable } from '@angular/core';

/**
 * Provides access to the native WebAuthn API, bypassing password manager
 * extensions (like 1Password) that monkey-patch navigator.credentials.
 *
 * Strategy:
 * - On desktop browsers (where 1Password injects content scripts):
 *   Uses a hidden same-origin iframe with a fresh, unpatched WebAuthn API.
 * - On mobile/Safari (where iframes can't use WebAuthn, and password managers
 *   use the native Credential Provider API instead of monkey-patching):
 *   Calls the top-level navigator.credentials directly.
 */
@Injectable({ providedIn: 'root' })
export class NativeWebAuthnService {

  /**
   * Detect if we should use the iframe bypass.
   * Only needed on desktop browsers where extension monkey-patching is an issue.
   * Safari (including macOS Safari) doesn't allow WebAuthn in iframes well,
   * and on iOS the 1Password app uses the native Credential Provider API
   * rather than injecting scripts.
   */
  private get useIframeBypass(): boolean {
    const ua = navigator.userAgent;
    // Don't use iframe on Safari (iOS or macOS) – it blocks WebAuthn in iframes
    if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return false;
    // Don't use iframe on mobile browsers
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return false;
    // Don't use iframe if running as standalone PWA (no extensions present)
    if (window.matchMedia('(display-mode: standalone)').matches) return false;
    // Desktop Chrome/Edge/Firefox – use iframe to bypass 1Password
    return true;
  }

  /**
   * Call navigator.credentials.create() using the native (unpatched) API.
   */
  async create(options: CredentialCreationOptions): Promise<PublicKeyCredential | null> {
    if (!this.useIframeBypass) {
      const credential = await navigator.credentials.create(options);
      return credential as PublicKeyCredential | null;
    }

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
    if (!this.useIframeBypass) {
      const credential = await navigator.credentials.get(options);
      return credential as PublicKeyCredential | null;
    }

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
   * Check if the native platform authenticator is available.
   */
  async isPlatformAuthenticatorAvailable(): Promise<boolean> {
    if (!this.useIframeBypass) {
      if (!window.PublicKeyCredential) return false;
      try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch {
        return false;
      }
    }

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
    iframe.style.display = 'none';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = 'none';
    iframe.style.position = 'absolute';
    iframe.style.top = '-9999px';
    iframe.src = 'about:blank';
    document.body.appendChild(iframe);
    return iframe;
  }

  private removeIframe(iframe: HTMLIFrameElement): void {
    iframe.remove();
  }
}
