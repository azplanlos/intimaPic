import { TestBed } from '@angular/core/testing';
import { OneDriveAdapter } from './onedrive-adapter.service';

// Mock fetch globally
const mockFetch = jasmine.createSpy('fetch');
(global as any).fetch = mockFetch;

describe('OneDriveAdapter - Token Validation', () => {
  let service: OneDriveAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(OneDriveAdapter);
    mockFetch.calls.reset();
  });

  describe('validateAndRefreshToken', () => {
    it('should return true when token is valid', async () => {
      // Arrange: Set up a valid token
      service.configure({ clientId: 'test-client' });
      (service as any).accessToken = 'valid-token';
      
      // Mock successful API response
      mockFetch.and.returnValue(Promise.resolve({
        ok: true,
        json: async () => ({}),
        text: async () => '',
      }));

      // Act
      const result = await service.validateAndRefreshToken();

      // Assert
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        jasmine.stringMatching(/me\/drive/),
        jasmine.objectContaining({
          headers: { Authorization: 'Bearer valid-token' }
        })
      );
    });

    it('should attempt refresh when token is invalid', async () => {
      // Arrange: Set up an invalid token
      service.configure({ clientId: 'test-client' });
      (service as any).accessToken = 'expired-token';
      
      // Mock failed validation followed by successful auth
      mockFetch.and.returnValues(
        Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({}),
          text: async () => '',
        }),
        Promise.resolve({
          ok: true,
          json: async () => ({}),
          text: async () => '',
        })
      );

      // Mock the authenticate method to return a new token
      const authenticateSpy = spyOn(service as any, 'authenticate');
      authenticateSpy.and.returnValue(Promise.resolve('new-valid-token'));

      // Act
      const result = await service.validateAndRefreshToken();

      // Assert
      expect(result).toBe(true);
      expect(authenticateSpy).toHaveBeenCalled();
      expect(service.getAccessToken()).toBe('new-valid-token');
    });

    it('should return false when refresh fails', async () => {
      // Arrange: Set up an invalid token
      service.configure({ clientId: 'test-client' });
      (service as any).accessToken = 'expired-token';
      
      // Mock failed validation
      mockFetch.and.returnValue(Promise.resolve({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => '',
      }));

      // Mock the authenticate method to throw an error
      const authenticateSpy = spyOn(service as any, 'authenticate');
      authenticateSpy.and.returnValue(Promise.reject(new Error('Auth failed')));

      // Act
      const result = await service.validateAndRefreshToken();

      // Assert
      expect(result).toBe(false);
      expect(authenticateSpy).toHaveBeenCalled();
    });

    it('should authenticate when no token exists', async () => {
      // Arrange: No token set
      service.configure({ clientId: 'test-client' });
      (service as any).accessToken = null;
      
      // Mock the authenticate method
      const authenticateSpy = spyOn(service as any, 'authenticate');
      authenticateSpy.and.returnValue(Promise.resolve('new-token'));

      // Act
      const result = await service.validateAndRefreshToken();

      // Assert
      expect(result).toBe(true);
      expect(authenticateSpy).toHaveBeenCalled();
      expect(service.getAccessToken()).toBe('new-token');
    });
  });
});