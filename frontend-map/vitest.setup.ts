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

// jsdom doesn't implement IntersectionObserver -- components that gate rendering on
// visibility (e.g. useInView, used by FeedCard to defer mounting HlsPlayer until
// scrolled into view) need a stub to mount in tests at all. Reports every observed
// target as immediately intersecting so tests don't need to simulate a real scroll.
class IntersectionObserverMock implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

global.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver;