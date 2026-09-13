// Client-side mirror of backend-registry/app/services/password_policy_service.py
// -- same zxcvbn scoring, same entropy formula, same structural-weakness
// checks, same MIN_LENGTH/MIN_ZXCVBN_SCORE floor -- so the live strength
// meter an officer sees while typing agrees with what the server will
// actually accept, instead of a client-only estimate that could pass here
// and still get rejected on submit. The server call is still the real
// gate (this is UX, not the security boundary); adapted from
// github.com/Pruthil-21/password-strength-analyzer's analyzer/strength.py.
import zxcvbn from 'zxcvbn';

export const MIN_LENGTH = 8;
export const MIN_ZXCVBN_SCORE = 2;

const LEVELS = ['Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong'] as const;

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789'];
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

function characterPool(password: string): number {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 32;
  return pool;
}

function entropyBits(password: string): number {
  if (!password) return 0;
  const pool = characterPool(password);
  if (pool === 0) return 0;
  return Math.round(password.length * Math.log2(pool) * 100) / 100;
}

function hasSequential(password: string): boolean {
  const lowered = password.toLowerCase();
  for (const seq of SEQUENCES) {
    const rev = seq.split('').reverse().join('');
    for (let i = 0; i <= seq.length - 3; i++) {
      if (lowered.includes(seq.slice(i, i + 3)) || lowered.includes(rev.slice(i, i + 3))) return true;
    }
  }
  return false;
}

function hasRepeated(password: string): boolean {
  return /(.)\1{2,}/.test(password);
}

function hasKeyboardPattern(password: string, minRun = 4): boolean {
  const lowered = password.toLowerCase();
  for (const row of KEYBOARD_ROWS) {
    const rev = row.split('').reverse().join('');
    for (let i = 0; i <= row.length - minRun; i++) {
      if (lowered.includes(row.slice(i, i + minRun)) || lowered.includes(rev.slice(i, i + minRun))) return true;
    }
  }
  return false;
}

function weaknesses(password: string): string[] {
  const out: string[] = [];
  if (password.length < MIN_LENGTH) out.push(`Shorter than the required minimum of ${MIN_LENGTH} characters.`);
  if (!/[A-Z]/.test(password)) out.push('No uppercase letters.');
  if (!/[a-z]/.test(password)) out.push('No lowercase letters.');
  if (!/[0-9]/.test(password)) out.push('No numeric digits.');
  if (!/[^A-Za-z0-9]/.test(password)) out.push('No special characters.');
  if (hasSequential(password)) out.push("Contains a sequential run (e.g. 'abc', '321').");
  if (hasRepeated(password)) out.push('Contains a character repeated three or more times in a row.');
  if (hasKeyboardPattern(password)) out.push("Contains a keyboard-walk pattern (e.g. 'qwerty', '1qaz').");
  return out;
}

export interface PasswordAnalysis {
  score: 0 | 1 | 2 | 3 | 4;
  strength: (typeof LEVELS)[number];
  entropy: number;
  crackTime: string;
  weaknesses: string[];
  meetsRequirements: boolean;
}

/** userInputs: badge number, name, email -- fed to zxcvbn so it penalizes
 * a password built from the officer's own identifying details, same as
 * the backend does. */
export function analyzePassword(password: string, userInputs: string[] = []): PasswordAnalysis {
  const result = zxcvbn(password, userInputs);
  const score = result.score as 0 | 1 | 2 | 3 | 4;
  return {
    score,
    strength: LEVELS[score],
    entropy: entropyBits(password),
    crackTime: String(result.crack_times_display.offline_slow_hashing_1e4_per_second),
    weaknesses: weaknesses(password),
    meetsRequirements: password.length >= MIN_LENGTH && score >= MIN_ZXCVBN_SCORE,
  };
}
