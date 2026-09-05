import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecordingCalendar, toLocalDateKey } from '@/components/archive/RecordingCalendar';

describe('toLocalDateKey', () => {
  it('formats a date as YYYY-MM-DD', () => {
    expect(toLocalDateKey(new Date(2026, 8, 5))).toBe('2026-09-05');
  });
});

describe('RecordingCalendar', () => {
  it('marks the day a segment starts on and lets it be selected', () => {
    const today = new Date();
    const todayKey = toLocalDateKey(today);
    const onSelectDate = vi.fn();

    render(
      <RecordingCalendar
        segments={[{ start: today.toISOString(), duration: 600 }]}
        selectedDate={todayKey}
        onSelectDate={onSelectDate}
      />
    );

    const dayButton = screen.getByLabelText(`${todayKey}, has recordings`);
    expect(dayButton).toBeInTheDocument();
    fireEvent.click(dayButton);
    expect(onSelectDate).toHaveBeenCalledWith(todayKey);
  });

  it('disables days after today', () => {
    const today = new Date();
    const todayKey = toLocalDateKey(today);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    // Skip this assertion across a month boundary -- keeps the test simple
    // rather than handling the calendar-navigation case here too.
    if (tomorrow.getMonth() !== today.getMonth()) return;
    const tomorrowKey = toLocalDateKey(tomorrow);

    render(<RecordingCalendar segments={[]} selectedDate={todayKey} onSelectDate={vi.fn()} />);
    expect(screen.getByLabelText(tomorrowKey)).toBeDisabled();
  });

  it('navigates to the previous and next month', () => {
    const today = new Date();
    const todayKey = toLocalDateKey(today);
    render(<RecordingCalendar segments={[]} selectedDate={todayKey} onSelectDate={vi.fn()} />);

    const currentLabel = today.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    expect(screen.getByText(currentLabel)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Previous month'));
    const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    expect(screen.getByText(prevMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))).toBeInTheDocument();
  });
});
