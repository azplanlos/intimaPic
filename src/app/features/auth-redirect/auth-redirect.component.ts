import { Component, OnInit } from '@angular/core';
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

/**
 * Redirect bridge page for MSAL v5 popup authentication.
 *
 * After the user logs in at Microsoft, the popup is redirected to this route.
 * This component calls broadcastResponseToMainFrame() which communicates the
 * auth response back to the parent window via BroadcastChannel and closes the popup.
 */
@Component({
  selector: 'app-auth-redirect',
  standalone: true,
  template: '<p>Authentifizierung wird verarbeitet...</p>',
})
export class AuthRedirectComponent implements OnInit {
  ngOnInit(): void {
    broadcastResponseToMainFrame().catch((error: Error) => {
      console.error('Error broadcasting auth response to main frame:', error);
    });
  }
}
