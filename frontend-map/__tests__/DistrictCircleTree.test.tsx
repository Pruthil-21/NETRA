import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DistrictCircleTree } from '@/components/tree/DistrictCircleTree';

const CIRCLES = [
  { id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'Petlad Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
];

describe('DistrictCircleTree', () => {
  it('renders districts collapsed by default, with no circle nodes visible', () => {
    render(<DistrictCircleTree districts={['Anand']} circles={CIRCLES} selected={null} onSelect={() => {}} />);
    expect(screen.getByText('Anand')).toBeInTheDocument();
    expect(screen.queryByText('APC Circle')).not.toBeInTheDocument();
  });

  it('expands to show circles on click, and selecting one calls onSelect', () => {
    const onSelect = vi.fn();
    render(<DistrictCircleTree districts={['Anand']} circles={CIRCLES} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText('Expand Anand'));
    expect(screen.getByText('APC Circle')).toBeInTheDocument();

    fireEvent.click(screen.getByText('APC Circle'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'circle', value: 1 });
  });

  it('clicking the district itself selects the whole district', () => {
    const onSelect = vi.fn();
    render(<DistrictCircleTree districts={['Anand']} circles={[]} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Anand'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'district', value: 'Anand' });
  });

  it('shows an empty state for a district with no circles once expanded', () => {
    render(<DistrictCircleTree districts={['Anand']} circles={[]} selected={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByLabelText('Expand Anand'));
    expect(screen.getByText('No circles yet')).toBeInTheDocument();
  });
});
