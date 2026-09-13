'use client';

import React, { useMemo } from 'react';
import { analyzePassword, MIN_LENGTH } from '@/lib/passwordStrength';

const BAR_COLORS = ['bg-signal-red', 'bg-signal-red', 'bg-signal-amber', 'bg-signal-green', 'bg-signal-green'];
const LABEL_COLORS = ['text-signal-red', 'text-signal-red', 'text-signal-amber', 'text-signal-green', 'text-signal-green'];

interface PasswordStrengthMeterProps {
  password: string;
  /** Badge number, name, email -- fed to zxcvbn so a password built from
   * the officer's own identifying details scores lower, same as the
   * backend's own check. */
  userInputs?: string[];
}

/** Live client-side feedback only -- POST /auth/register (and every other
 * password-setting endpoint) enforces the real floor server-side via
 * password_policy_service.validate_password_or_raise, so a bypassed or
 * stale client can never submit a password this meter would have allowed
 * through but the server rejects. */
export function PasswordStrengthMeter({ password, userInputs = [] }: PasswordStrengthMeterProps) {
  const analysis = useMemo(() => analyzePassword(password, userInputs), [password, userInputs]);

  if (!password) return null;

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <div className="flex-1 grid grid-cols-5 gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={`h-1 rounded-full transition-colors ${
                i <= analysis.score ? BAR_COLORS[analysis.score] : 'bg-line'
              }`}
            />
          ))}
        </div>
        <span className={`text-[10px] font-semibold shrink-0 ${LABEL_COLORS[analysis.score]}`}>
          {analysis.strength}
        </span>
      </div>
      {!analysis.meetsRequirements && (
        <p className="text-[10px] text-slate-500 mt-1">
          {password.length < MIN_LENGTH
            ? `At least ${MIN_LENGTH} characters required.`
            : analysis.weaknesses[0] ?? 'This password is too easy to guess.'}
        </p>
      )}
    </div>
  );
}

export default PasswordStrengthMeter;
