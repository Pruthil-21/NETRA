import React from 'react';

interface BadgeProps {
  status: 'online' | 'offline' | 'operational' | 'degraded' | 'fault';
  text: string;
}

export default function Badge({ status, text }: BadgeProps) {
  const styles: Record<string, string> = {
    online: 'bg-signal-green/10 text-signal-green border-signal-green/40',
    operational: 'bg-signal-green/10 text-signal-green border-signal-green/40',
    degraded: 'bg-signal-amber/10 text-signal-amber border-signal-amber/40',
    offline: 'bg-signal-red/10 text-signal-red border-signal-red/40',
    fault: 'bg-signal-red/10 text-signal-red border-signal-red/40',
  };

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-sm border uppercase tracking-wide ${styles[status] || styles.offline}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          status === 'online' || status === 'operational'
            ? 'bg-signal-green'
            : status === 'degraded'
              ? 'bg-signal-amber'
              : 'bg-signal-red'
        }`}
      />
      {text}
    </span>
  );
}