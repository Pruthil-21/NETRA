'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, PlusCircle, ShieldAlert, Trash2 } from 'lucide-react';
import { adminService, RolePermissionsOut, SodRuleOut } from '@/services/adminService';

/** Generalized Separation-of-Duty rule engine (v2 spec Section 3.8) --
 * an admin-configurable table of role pairs that must never both be
 * actively held by the same officer at once, checked at posting-
 * assignment time. */
export function SodRulesSection() {
  const [rules, setRules] = useState<SodRuleOut[]>([]);
  const [roles, setRoles] = useState<RolePermissionsOut[]>([]);
  const [roleAId, setRoleAId] = useState<number | null>(null);
  const [roleBId, setRoleBId] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([adminService.listSodRules(), adminService.getRoles()])
      .then(([r, roleList]) => {
        setRules(r);
        setRoles(roleList);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load SoD rules'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const submit = async () => {
    if (roleAId == null || roleBId == null) return;
    setError(null);
    try {
      await adminService.createSodRule(roleAId, roleBId, description || undefined);
      setRoleAId(null);
      setRoleBId(null);
      setDescription('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create rule');
    }
  };

  const remove = async (ruleId: number) => {
    setError(null);
    try {
      await adminService.deleteSodRule(ruleId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete rule');
    }
  };

  if (loading) return <div className="animate-pulse text-xs text-slate-500">Loading SoD rules…</div>;

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <span className="inline-flex p-2 bg-signal-amber/10 border border-signal-amber/30 text-signal-amber rounded-lg">
          <ShieldAlert size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Separation of Duty Rules</h2>
          <p className="text-[11px] text-slate-500">Role pairs that can never both be held by the same officer</p>
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-signal-red mb-3 flex items-center gap-1.5">
          <AlertTriangle size={12} />
          {error}
        </p>
      )}

      <div className="border border-line rounded-lg bg-panel p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <select
            value={roleAId ?? ''}
            onChange={(e) => setRoleAId(e.target.value ? Number(e.target.value) : null)}
            className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          >
            <option value="">Role A…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.display_name}</option>
            ))}
          </select>
          <select
            value={roleBId ?? ''}
            onChange={(e) => setRoleBId(e.target.value ? Number(e.target.value) : null)}
            className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          >
            <option value="">Role B…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.display_name}</option>
            ))}
          </select>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          />
        </div>
        <button
          type="button"
          disabled={roleAId == null || roleBId == null || roleAId === roleBId}
          onClick={submit}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50"
        >
          <PlusCircle size={12} />
          Add Rule
        </button>
      </div>

      {rules.length === 0 ? (
        <p className="text-xs text-slate-500 text-center py-8">No SoD rules configured.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center justify-between gap-3 border border-line rounded-lg bg-panel p-3">
              <div className="min-w-0">
                <p className="text-xs text-white">
                  <span className="font-mono">{rule.role_a_name}</span> &harr; <span className="font-mono">{rule.role_b_name}</span>
                </p>
                {rule.description && <p className="text-[10px] text-slate-500 mt-0.5">{rule.description}</p>}
              </div>
              <button
                type="button"
                onClick={() => remove(rule.id)}
                title="Delete rule"
                className="shrink-0 p-1.5 rounded border border-line bg-panel-raised text-slate-400 hover:text-signal-red"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default SodRulesSection;
