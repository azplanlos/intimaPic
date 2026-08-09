import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { VaultService } from './core/vault/vault.service';

describe('App', () => {
  let vaultServiceSpy: jasmine.SpyObj<VaultService>;

  beforeEach(async () => {
    vaultServiceSpy = jasmine.createSpyObj<VaultService>('VaultService', ['initialize']);
    vaultServiceSpy.initialize.and.resolveTo();

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        { provide: VaultService, useValue: vaultServiceSpy },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should call vaultService.initialize on init', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.componentInstance.ngOnInit();
    expect(vaultServiceSpy.initialize).toHaveBeenCalled();
  });

  it('should render a router-outlet', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('router-outlet')).toBeTruthy();
  });
});
