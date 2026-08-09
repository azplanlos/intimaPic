import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { SortControlComponent } from './sort-control.component';
import { SortCriterion } from '../../core/metadata/metadata.models';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { OverlayContainer } from '@angular/cdk/overlay';

/**
 * Host component to provide signal-based inputs to the SortControlComponent.
 */
@Component({
  standalone: true,
  imports: [SortControlComponent],
  template: `
    <app-sort-control
      [activeCriterion]="activeCriterion()"
      (criterionChanged)="onCriterionChanged($event)"
    />
  `,
})
class TestHostComponent {
  activeCriterion = signal<SortCriterion>('filename');
  lastCriterionEvent: SortCriterion | undefined;

  onCriterionChanged(criterion: SortCriterion): void {
    this.lastCriterionEvent = criterion;
  }
}

describe('SortControlComponent', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let host: TestHostComponent;
  let overlayContainer: OverlayContainer;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    host = fixture.componentInstance;
    overlayContainer = TestBed.inject(OverlayContainer);
    fixture.detectChanges();
  });

  afterEach(() => {
    overlayContainer.ngOnDestroy();
  });

  describe('button label', () => {
    it('should display "Dateiname" when activeCriterion is filename', () => {
      host.activeCriterion.set('filename');
      fixture.detectChanges();

      const button = fixture.debugElement.query(By.css('button[mat-button]'));
      expect(button.nativeElement.textContent).toContain('Dateiname');
    });

    it('should display "Aufnahmedatum" when activeCriterion is captureDate', () => {
      host.activeCriterion.set('captureDate');
      fixture.detectChanges();

      const button = fixture.debugElement.query(By.css('button[mat-button]'));
      expect(button.nativeElement.textContent).toContain('Aufnahmedatum');
    });

    it('should display "Bewertung" when activeCriterion is rating', () => {
      host.activeCriterion.set('rating');
      fixture.detectChanges();

      const button = fixture.debugElement.query(By.css('button[mat-button]'));
      expect(button.nativeElement.textContent).toContain('Bewertung');
    });
  });

  describe('menu selection', () => {
    function openMenu(): void {
      const triggerButton = fixture.debugElement.query(By.css('button[mat-button]'));
      triggerButton.nativeElement.click();
      fixture.detectChanges();
    }

    function getMenuItems(): HTMLElement[] {
      const overlayEl = overlayContainer.getContainerElement();
      return Array.from(overlayEl.querySelectorAll('button[mat-menu-item]'));
    }

    it('should emit criterionChanged with "filename" when Dateiname is selected', () => {
      openMenu();
      const menuItems = getMenuItems();
      const filenameItem = menuItems.find(el => el.textContent?.includes('Dateiname'));
      filenameItem!.click();
      fixture.detectChanges();

      expect(host.lastCriterionEvent).toBe('filename');
    });

    it('should emit criterionChanged with "captureDate" when Aufnahmedatum is selected', () => {
      openMenu();
      const menuItems = getMenuItems();
      const captureDateItem = menuItems.find(el => el.textContent?.includes('Aufnahmedatum'));
      captureDateItem!.click();
      fixture.detectChanges();

      expect(host.lastCriterionEvent).toBe('captureDate');
    });

    it('should emit criterionChanged with "rating" when Bewertung is selected', () => {
      openMenu();
      const menuItems = getMenuItems();
      const ratingItem = menuItems.find(el => el.textContent?.includes('Bewertung'));
      ratingItem!.click();
      fixture.detectChanges();

      expect(host.lastCriterionEvent).toBe('rating');
    });
  });
});
