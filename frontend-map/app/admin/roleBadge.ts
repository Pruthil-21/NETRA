// Subtle per-role accent so an officer's role reads at a glance in a long
// roster -- same pill shape for every role (a full theming system would be
// overkill for five roles), just a different accent color. Shared between
// every /admin section that displays a role name (Officers & Postings, Role
// Permissions, Password Reset Requests) so they never drift out of sync.
const ROLE_BADGE_CLASS: Record<string, string> = {
  super_admin: 'bg-signal-red/10 text-signal-red border-signal-red/30',
  district_command: 'bg-command/10 text-command border-command/30',
  station_officer: 'bg-signal-amber/10 text-signal-amber border-signal-amber/30',
  control_room_operator: 'bg-signal-green/10 text-signal-green border-signal-green/30',
  auditor: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
};

export function roleBadgeClass(role: string): string {
  return ROLE_BADGE_CLASS[role] ?? 'bg-panel-raised text-slate-300 border-line';
}
