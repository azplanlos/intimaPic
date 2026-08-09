import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { SortCriterion } from '../../core/metadata/metadata.models';

@Component({
  selector: 'app-sort-control',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatMenuModule],
  template: `
    <button mat-button [matMenuTriggerFor]="sortMenu">
      <mat-icon>sort</mat-icon>
      {{ sortLabel() }}
    </button>
    <mat-menu #sortMenu="matMenu">
      <button mat-menu-item (click)="select('filename')">
        <mat-icon>{{ activeCriterion() === 'filename' ? 'check' : '' }}</mat-icon>
        Dateiname
      </button>
      <button mat-menu-item (click)="select('captureDate')">
        <mat-icon>{{ activeCriterion() === 'captureDate' ? 'check' : '' }}</mat-icon>
        Aufnahmedatum
      </button>
      <button mat-menu-item (click)="select('rating')">
        <mat-icon>{{ activeCriterion() === 'rating' ? 'check' : '' }}</mat-icon>
        Bewertung
      </button>
    </mat-menu>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SortControlComponent {
  readonly activeCriterion = input<SortCriterion>('filename');
  readonly criterionChanged = output<SortCriterion>();

  readonly sortLabel = computed(() => {
    switch (this.activeCriterion()) {
      case 'captureDate': return 'Aufnahmedatum';
      case 'rating': return 'Bewertung';
      default: return 'Dateiname';
    }
  });

  select(criterion: SortCriterion): void {
    this.criterionChanged.emit(criterion);
  }
}
