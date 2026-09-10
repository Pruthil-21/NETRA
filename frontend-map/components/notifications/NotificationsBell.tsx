'use client';

import React, { useEffect, useRef, useState } from 'react';
import { BellRing } from 'lucide-react';
import { adminService, NotificationOut } from '@/services/adminService';

const POLL_INTERVAL_MS = 15000;

/** Header widget for the minimal in-app notification log (v2 spec, Phase
 * D): role granted/revoked, registration approved/rejected, an SoD
 * conflict blocked an assignment. Every officer has one -- distinct from
 * AlertsBell, which is watchlist-match alerts, not account/RBAC events. */
export function NotificationsBell() {
  const [notifications, setNotifications] = useState<NotificationOut[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      adminService
        .listNotifications()
        .then((data) => {
          if (!cancelled) setNotifications(data);
        })
        .catch(() => {
          // Non-fatal: the bell just shows nothing until the next poll succeeds.
        });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const handleMarkRead = async (id: number) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    try {
      await adminService.markNotificationRead(id);
    } catch {
      // Non-fatal: the next poll will correct any drift.
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 text-slate-400 hover:text-white bg-panel-raised rounded border border-line"
      >
        <BellRing size={14} />
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-command text-white text-[10px] font-bold flex items-center justify-center">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-panel border border-line rounded shadow-xl z-[2000] text-xs">
          <div className="px-3 py-2 border-b border-line text-slate-400">Notifications</div>
          {notifications.length === 0 && (
            <div className="px-3 py-3 text-slate-500">Nothing yet.</div>
          )}
          {notifications.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => handleMarkRead(n.id)}
              className={`w-full text-left px-3 py-2 border-b border-line last:border-0 hover:bg-panel-raised ${
                n.read ? 'opacity-60' : ''
              }`}
            >
              <p className="text-white">{n.message}</p>
              <p className="text-slate-600 mt-0.5">{new Date(n.created_at).toLocaleString()}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default NotificationsBell;
