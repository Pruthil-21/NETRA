import React from 'react';

interface BadgeProps {
  status: 'online' | 'offline' | 'operational' | 'degraded' | 'fault';
  text: string;
}

export default function Badge({ status, text }: BadgeProps) {
  const styles: Record<string, string> = {
    online: 'bg-emerald-950/80 text-emerald-400 border-emerald-800',
    operational: 'bg-emerald-950/80 text-emerald-400 border-emerald-800',
    degraded: 'bg-amber-950/80 text-amber-400 border-amber-800',
    offline: 'bg-rose-950/80 text-rose-400 border-rose-800',
    fault: 'bg-rose-950/80 text-rose-400 border-rose-800',
  };

  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase ${styles[status] || styles.offline}`}>
      {text}
    </span>
  );
}