import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection, isDevMode, APP_INITIALIZER, inject } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';

import { routes } from './app.routes';
import { SwClientService } from './core/sw-client/sw-client.service';

/**
 * Register the custom ServiceWorker during app initialization.
 * Replaces Angular's NGSW – our custom SW handles both app shell caching
 * and encrypted data caching/storage provider proxying.
 */
function initializeServiceWorker(): () => Promise<void> {
  const swClient = inject(SwClientService);
  return async () => {
    if (!isDevMode()) {
      await swClient.register();
    }
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimationsAsync(),
    {
      provide: APP_INITIALIZER,
      useFactory: initializeServiceWorker,
      multi: true,
    },
  ]
};
