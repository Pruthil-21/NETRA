'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, KeyRound, UserCheck } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('officer@gujarat.gov.in');
  const [password, setPassword] = useState('admin123');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('netra_authenticated', 'true');
    router.push('/');
  };

  return (
    <main className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
        <div className="text-center mb-8">
          <div className="inline-flex p-3 bg-blue-600/10 border border-blue-500/20 text-blue-500 rounded-2xl mb-3">
            <Shield size={36} />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-wider">NETRA</h1>
          <p className="text-xs text-slate-400 mt-1">Gujarat Unified Video Integration System</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">Official ID</label>
            <div className="relative">
              <UserCheck size={16} className="absolute left-3 top-3 text-slate-500" />
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-10 pr-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500"
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase mb-1">Passcode</label>
            <div className="relative">
              <KeyRound size={16} className="absolute left-3 top-3 text-slate-500" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-10 pr-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500"
                required
              />
            </div>
          </div>
          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 rounded-lg text-xs uppercase tracking-wider transition"
          >
            Authenticate Portal
          </button>
        </form>
      </div>
    </main>
  );
}