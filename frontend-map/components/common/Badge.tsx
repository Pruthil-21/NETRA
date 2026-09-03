import React from 'react';
import { Radio, CheckCircle2, AlertTriangle, VideoOff, XCircle, LucideIcon } from 'lucide-react';

interface BadgeProps {
  status: 'online' | 'offline' | 'operational' | 'degraded' | 'fault';
  text: string;
}

// One icon per status, not just color -- color alone isn't enough at a glance
// across a wall of tiles (and fails for anyone color-blind). Mirrors the
// dashboard's own STATUS_BADGE icon-per-status pattern (FeedCard.tsx) so a
// "live" signal reads the same shape everywhere in the app: Radio for an
// actively-streaming camera, VideoOff for nothing coming through, AlertTriangle
// for a stream that's up but degraded, XCircle for a hardware/health fault
// distinct from plain connectivity loss.
const STATUS_STYLE: Record<BadgeProps['status'], { className: string; icon: LucideIcon }> = {
  online: { className: 'bg-signal-green/10 text-signal-green border-signal-green/40', icon: Radio },
  operational: { className: 'bg-signal-green/10 text-signal-green border-signal-green/40', icon: CheckCircle2 },
  degraded: { className: 'bg-signal-amber/10 text-signal-amber border-signal-amber/40', icon: AlertTriangle },
  offline: { className: 'bg-signal-red/10 text-signal-red border-signal-red/40', icon: VideoOff },
  fault: { className: 'bg-signal-red/10 text-signal-red border-signal-red/40', icon: XCircle },
};

export default function Badge({ status, text }: BadgeProps) {
  const { className, icon: Icon } = STATUS_STYLE[status] || STATUS_STYLE.offline;

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-sm border uppercase tracking-wide ${className}`}
    >
      <Icon size={10} />
      {text}
    </span>
  );
}