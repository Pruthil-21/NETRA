/** Mirrors the backend's own district-scope check (rbac_scope.py's
 * effective_district_scopes/guard_dept_in_scope, cameras.py's
 * _require_camera_in_scope) -- a UI-gating convenience, not the actual
 * security boundary; the backend rejects a cross-district write
 * regardless of what this returns. Platform-scoped (scopeType is anything
 * other than "district", including null for a legacy/unscoped token) is
 * always in scope; a district-scoped officer is only in scope for a
 * resource whose own district exactly matches theirs. */
export function isInScope(
  scopeType: string | null,
  scopeValue: string | null,
  resourceDistrict: string | null | undefined
): boolean {
  if (scopeType !== 'district') return true;
  return resourceDistrict === scopeValue;
}
