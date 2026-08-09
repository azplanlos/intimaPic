import { Injectable, signal } from '@angular/core';

export interface ToolbarAction {
  icon: string;
  label: string;
  callback: () => void;
}

/**
 * Service to let child routes customize the shared toolbar.
 * When a child sets context, the toolbar shows a back button + custom title
 * instead of the logo. On navigation away, the child should call reset().
 */
@Injectable({ providedIn: 'root' })
export class ToolbarService {
  /** If set, toolbar shows back button + this title instead of logo */
  readonly title = signal<string | null>(null);
  /** Callback for the back button */
  readonly backAction = signal<(() => void) | null>(null);
  /** Extra action buttons shown on the right side */
  readonly actions = signal<ToolbarAction[]>([]);

  /** Set a custom toolbar context (e.g. album view with back button) */
  set(options: { title: string; backAction: () => void; actions?: ToolbarAction[] }): void {
    this.title.set(options.title);
    this.backAction.set(options.backAction);
    this.actions.set(options.actions ?? []);
  }

  /** Reset to default toolbar (logo + app name) */
  reset(): void {
    this.title.set(null);
    this.backAction.set(null);
    this.actions.set([]);
  }
}
