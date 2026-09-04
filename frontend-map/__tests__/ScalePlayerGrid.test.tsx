// frontend-map/__tests__/ScalePlayerGrid.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ScalePlayerGrid } from '@/components/scale/ScalePlayerGrid';
import { ScaleCamera } from '@/types/scaleCamera';

const SYNTHETIC_CAMERA: ScaleCamera = {
  id: 1, name: 'SYN-CAM-000001', dept: 'Test District', lat: 22, long: 72,
  camera_type: 'ip', ownership: 'synthetic-scale-demo', connectivity_status: 'online',
  storage_type: 'nvr', retention_days: 15, health_status: 'operational',
  rtsp_url: null, hls_url: 'https://example.test/stream.m3u8', is_synthetic: true, edge_node_id: 1,
};

describe('ScalePlayerGrid', () => {
  it('labels a panel as synthetic even when it has a real stream URL', () => {
    render(<ScalePlayerGrid cameras={[SYNTHETIC_CAMERA]} onClose={() => {}} />);
    expect(screen.getByText('Synthetic')).toBeInTheDocument();
  });

  it('labels a panel with no stream URL as synthetic too, alongside the no-stream message', () => {
    render(<ScalePlayerGrid cameras={[{ ...SYNTHETIC_CAMERA, hls_url: null }]} onClose={() => {}} />);
    expect(screen.getByText('Synthetic')).toBeInTheDocument();
    expect(screen.getByText(/no live stream provisioned/i)).toBeInTheDocument();
  });

  it('renders nothing when there are no active cameras', () => {
    const { container } = render(<ScalePlayerGrid cameras={[]} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
