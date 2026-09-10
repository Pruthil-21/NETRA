import { describe, it, expect } from 'vitest';
import { flowWidthForRatio, FLOW_MIN_WIDTH_PX, FLOW_MAX_WIDTH_PX } from '@/lib/flowMath';

describe('flowWidthForRatio', () => {
  it('is the minimum width at ratio 0', () => {
    expect(flowWidthForRatio(0)).toBe(FLOW_MIN_WIDTH_PX);
  });

  it('is the maximum width at ratio 1', () => {
    expect(flowWidthForRatio(1)).toBe(FLOW_MAX_WIDTH_PX);
  });

  it('interpolates linearly between the two', () => {
    expect(flowWidthForRatio(0.5)).toBe((FLOW_MIN_WIDTH_PX + FLOW_MAX_WIDTH_PX) / 2);
  });

  it('clamps values outside [0, 1]', () => {
    expect(flowWidthForRatio(-1)).toBe(FLOW_MIN_WIDTH_PX);
    expect(flowWidthForRatio(2)).toBe(FLOW_MAX_WIDTH_PX);
  });
});
