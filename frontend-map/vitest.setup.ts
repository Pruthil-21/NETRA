import '@testing-library/jest-dom';

// Mock Leaflet methods to run tests in headless Node/JSDOM environment
vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn(() => ({})),
    latLngBounds: vi.fn(() => ({
      isValid: () => true,
    })),
  },
  divIcon: vi.fn(() => ({})),
  latLngBounds: vi.fn(() => ({
    isValid: () => true,
  })),
}));

// Mock Next.js Navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));