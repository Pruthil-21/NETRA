import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { MapPopupCard } from '@/components/map/MapPopupCard';
import { Camera } from '@/types/camera';

const CAMERA: Camera = {
  id: 1, name: 'Test Cam', dept: 'Traffic Police', lat: 23, long: 72,
  camera_type: 'ANPR', ownership: 'Test', connectivity_status: 'online',
  storage_type: 'Cloud', retention_days: 30, health_status: 'operational',
  rtsp_url: '',
};

describe('MapPopupCard rendering containment', () => {
  it('scopes the width transition to a layout-contained box', () => {
    const { container } = render(
      <MapPopupCard camera={CAMERA} onInspect={vi.fn()} isPreviewing={false} previewSrc={null} />
    );
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain('[contain:layout]');
    expect(outer.className).toContain('[will-change:width]');
  });

  it('scopes the grid-template-rows transition to a layout-contained box', () => {
    const { container } = render(
      <MapPopupCard camera={CAMERA} onInspect={vi.fn()} isPreviewing={false} previewSrc={null} />
    );
    const growWrapper = container.querySelector('.grid') as HTMLElement;
    expect(growWrapper.className).toContain('[contain:layout]');
    expect(growWrapper.className).toContain('[will-change:grid-template-rows]');
  });
});
