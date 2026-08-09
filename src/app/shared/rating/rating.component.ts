import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-rating',
  standalone: true,
  imports: [MatIconModule, MatButtonModule],
  template: `
    <button mat-icon-button
            [disabled]="readonly()"
            (click)="onHeartClick($event)"
            [attr.aria-label]="isFavorite() ? 'Remove from favorites' : 'Add to favorites'">
      <mat-icon>{{ isFavorite() ? 'favorite' : 'favorite_border' }}</mat-icon>
    </button>
    <span class="stars" role="group" aria-label="Rating">
      @for (star of stars; track star) {
        <button mat-icon-button
                [disabled]="readonly()"
                (click)="onStarClick($event, star)"
                [attr.aria-label]="'Rate ' + star + ' stars'">
          <mat-icon>{{ (rating() ?? 0) >= star ? 'star' : 'star_border' }}</mat-icon>
        </button>
      }
    </span>
  `,
  styles: [`
    :host {
      display: inline-flex;
      align-items: center;
    }

    :host button:first-child {
      color: #E91E63;
    }

    .stars {
      display: inline-flex;
      align-items: center;
      color: #FFD700;
    }

    .stars button {
      color: #FFD700;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RatingComponent {
  readonly photoId = input.required<string>();
  readonly isFavorite = input<boolean>(false);
  readonly rating = input<number | null>(null);
  readonly readonly = input<boolean>(false);

  readonly favoriteToggled = output<string>();
  readonly ratingChanged = output<{ photoId: string; value: number }>();

  protected readonly stars = [1, 2, 3, 4, 5];

  onHeartClick(event: Event): void {
    event.stopPropagation();
    this.favoriteToggled.emit(this.photoId());
  }

  onStarClick(event: Event, star: number): void {
    event.stopPropagation();
    this.ratingChanged.emit({ photoId: this.photoId(), value: star });
  }
}
