import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { RatingComponent } from './rating.component';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

/**
 * Host component to provide signal-based inputs to the RatingComponent.
 */
@Component({
  standalone: true,
  imports: [RatingComponent],
  template: `
    <app-rating
      [photoId]="photoId()"
      [isFavorite]="isFavorite()"
      [rating]="rating()"
      (favoriteToggled)="onFavoriteToggled($event)"
      (ratingChanged)="onRatingChanged($event)"
    />
  `,
})
class TestHostComponent {
  photoId = signal('photo-123');
  isFavorite = signal(false);
  rating = signal<number | null>(null);

  lastFavoriteEvent: string | undefined;
  lastRatingEvent: { photoId: string; value: number } | undefined;

  onFavoriteToggled(photoId: string): void {
    this.lastFavoriteEvent = photoId;
  }

  onRatingChanged(event: { photoId: string; value: number }): void {
    this.lastRatingEvent = event;
  }
}

describe('RatingComponent', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let host: TestHostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  describe('heart toggle', () => {
    it('should emit favoriteToggled with photoId when heart button is clicked', () => {
      const heartButton = fixture.debugElement.query(
        By.css('button[mat-icon-button]')
      );
      heartButton.triggerEventHandler('click', new MouseEvent('click'));

      expect(host.lastFavoriteEvent).toBe('photo-123');
    });

    it('should emit the correct photoId when photoId changes', () => {
      host.photoId.set('photo-456');
      fixture.detectChanges();

      const heartButton = fixture.debugElement.query(
        By.css('button[mat-icon-button]')
      );
      heartButton.triggerEventHandler('click', new MouseEvent('click'));

      expect(host.lastFavoriteEvent).toBe('photo-456');
    });

    it('should show "favorite" icon when isFavorite is true', () => {
      host.isFavorite.set(true);
      fixture.detectChanges();

      const heartIcon = fixture.debugElement.query(
        By.css('button[mat-icon-button] mat-icon')
      );
      expect(heartIcon.nativeElement.textContent.trim()).toBe('favorite');
    });

    it('should show "favorite_border" icon when isFavorite is false', () => {
      host.isFavorite.set(false);
      fixture.detectChanges();

      const heartIcon = fixture.debugElement.query(
        By.css('button[mat-icon-button] mat-icon')
      );
      expect(heartIcon.nativeElement.textContent.trim()).toBe('favorite_border');
    });
  });

  describe('star rating', () => {
    it('should emit ratingChanged with correct photoId and star value when a star is clicked', () => {
      const starButtons = fixture.debugElement.queryAll(
        By.css('.stars button[mat-icon-button]')
      );
      // Click the 3rd star
      starButtons[2].triggerEventHandler('click', new MouseEvent('click'));

      expect(host.lastRatingEvent).toEqual({ photoId: 'photo-123', value: 3 });
    });

    it('should emit ratingChanged with value 1 when first star is clicked', () => {
      const starButtons = fixture.debugElement.queryAll(
        By.css('.stars button[mat-icon-button]')
      );
      starButtons[0].triggerEventHandler('click', new MouseEvent('click'));

      expect(host.lastRatingEvent).toEqual({ photoId: 'photo-123', value: 1 });
    });

    it('should emit ratingChanged with value 5 when fifth star is clicked', () => {
      const starButtons = fixture.debugElement.queryAll(
        By.css('.stars button[mat-icon-button]')
      );
      starButtons[4].triggerEventHandler('click', new MouseEvent('click'));

      expect(host.lastRatingEvent).toEqual({ photoId: 'photo-123', value: 5 });
    });

    it('should show filled stars up to the rating value', () => {
      host.rating.set(3);
      fixture.detectChanges();

      const starIcons = fixture.debugElement.queryAll(
        By.css('.stars button[mat-icon-button] mat-icon')
      );
      expect(starIcons[0].nativeElement.textContent.trim()).toBe('star');
      expect(starIcons[1].nativeElement.textContent.trim()).toBe('star');
      expect(starIcons[2].nativeElement.textContent.trim()).toBe('star');
      expect(starIcons[3].nativeElement.textContent.trim()).toBe('star_border');
      expect(starIcons[4].nativeElement.textContent.trim()).toBe('star_border');
    });

    it('should show all stars as unfilled when rating is null', () => {
      host.rating.set(null);
      fixture.detectChanges();

      const starIcons = fixture.debugElement.queryAll(
        By.css('.stars button[mat-icon-button] mat-icon')
      );
      for (const icon of starIcons) {
        expect(icon.nativeElement.textContent.trim()).toBe('star_border');
      }
    });

    it('should show all stars as filled when rating is 5', () => {
      host.rating.set(5);
      fixture.detectChanges();

      const starIcons = fixture.debugElement.queryAll(
        By.css('.stars button[mat-icon-button] mat-icon')
      );
      for (const icon of starIcons) {
        expect(icon.nativeElement.textContent.trim()).toBe('star');
      }
    });
  });
});
