'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Play, Film, LocateFixed, Info, Copy, Check, Settings2, Pencil, Trash2, Loader2, AlertTriangle, ShieldAlert } from 'lucide-react';
import { Camera } from '@/types/camera';
import { cameraService } from '@/services/cameraService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { getCameraStreamUrl } from '@/lib/stream';

type MenuMode = 'root' | 'rename' | 'delete-confirm';

interface CameraContextMenuProps {
  camera: Camera;
  /** Viewport coordinates of the click/tap that opened this menu -- clamped
   * to stay fully on-screen once the panel's real size is known (see the
   * measure effect below). */
  anchor: { x: number; y: number };
  onClose: () => void;
  /** Gates every registry-mutating action (Configure/Rename/Delete).
   * Rendered disabled-with-tooltip rather than hidden when false -- an
   * officer without the permission can still see what exists, matching the
   * enterprise VMS convention (Genetec/Milestone) of not hiding controls
   * a role simply can't use today. */
  canManage: boolean;
  /** True when canManage is false specifically because this camera's own
   * district falls outside the officer's district-scoped posting (as
   * opposed to lacking the Manage Cameras permission outright) -- lets the
   * disabled tooltip name the actual wall the officer hit, mirroring the
   * backend's own 403 (rbac_scope.py's guard_dept_in_scope). */
  outOfScope?: boolean;
  /** Only Dashboard supplies this (it owns the watch-set grid) -- Map and
   * Archive omit it, so "Play" simply doesn't render there. */
  onPlay?: () => void;
  onViewDetails: () => void;
  onConfigure: () => void;
}

const itemClass =
  'w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-slate-200 hover:bg-panel-raised disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed';

function Separator() {
  return <div className="my-1 border-t border-line" role="separator" />;
}

/** Windows/VMS-style right-click device menu for one camera row in the
 * registry tree -- a deliberate, discoverable alternative to remembering
 * which of several actions live where. Portal-rendered to document.body
 * (same reason as CameraInfoOverlay: never clipped by the tree's own
 * `overflow-y-auto`, never affected by an ancestor's stacking context). */
export function CameraContextMenu({
  camera, anchor, onClose, canManage, outOfScope, onPlay, onViewDetails, onConfigure,
}: CameraContextMenuProps) {
  const router = useRouter();
  const { applyCameraUpdate, removeCamera } = useCameraRegistry();
  const menuRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<MenuMode>('root');
  const [position, setPosition] = useState(anchor);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const [renameValue, setRenameValue] = useState(camera.name);
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Clamp to the viewport once the panel's real size is known -- a right
  // click near the window's right/bottom edge would otherwise render the
  // menu partly (or entirely) off-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    setPosition({ x: Math.max(margin, Math.min(anchor.x, maxX)), y: Math.max(margin, Math.min(anchor.y, maxY)) });
    // Re-measure whenever the mode changes (rename/move/delete panels are a
    // different size than the root menu) -- anchor itself never changes
    // after the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // mousedown (not click) so this doesn't immediately close the menu the
    // context menu's own opening right-click/tap already fired inside.
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('contextmenu', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('contextmenu', handlePointerDown);
    };
  }, [onClose]);

  const streamUrl = useMemo(() => getCameraStreamUrl(camera).url, [camera]);

  const copy = (field: string, value: string) => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField((f) => (f === field ? null : f)), 1400);
    });
  };

  const handleRenameSave = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === camera.name) return onClose();
    setRenamePending(true);
    setRenameError(null);
    try {
      await cameraService.updateCamera(camera.id, { name: trimmed });
      applyCameraUpdate(camera.id, { name: trimmed });
      onClose();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Failed to rename camera');
    } finally {
      setRenamePending(false);
    }
  };

  const handleDeleteConfirm = async () => {
    setDeletePending(true);
    setDeleteError(null);
    try {
      await cameraService.deleteCamera(camera.id);
      removeCamera(camera.id);
      onClose();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete camera');
    } finally {
      setDeletePending(false);
    }
  };

  const manageTitle = canManage
    ? undefined
    : outOfScope
      ? 'This camera is outside your district'
      : 'Requires the Manage Cameras permission';

  let body: React.ReactNode;

  if (mode === 'rename') {
    body = (
      <div className="p-2.5 w-64">
        <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1.5">Rename Camera</p>
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleRenameSave()}
          className="w-full bg-ink border border-line rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-command focus:border-command"
        />
        {renameError && <p className="text-[10px] text-signal-red mt-1.5">{renameError}</p>}
        <div className="flex items-center justify-end gap-1.5 mt-2.5">
          <button
            type="button"
            onClick={() => setMode('root')}
            className="px-2.5 py-1 text-[11px] rounded text-slate-400 hover:text-white hover:bg-panel-raised"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRenameSave}
            disabled={renamePending || !renameValue.trim()}
            className="px-2.5 py-1 text-[11px] rounded bg-command text-white hover:bg-command/90 disabled:opacity-50 flex items-center gap-1.5"
          >
            {renamePending && <Loader2 size={11} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    );
  } else if (mode === 'delete-confirm') {
    body = (
      <div className="p-3 w-64">
        <div className="flex items-start gap-2 text-signal-red">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <p className="text-[11px] leading-relaxed text-slate-300">
            Delete <span className="font-semibold text-white">{camera.name}</span>? This removes it from the
            registry permanently and can&apos;t be undone.
          </p>
        </div>
        {deleteError && <p className="text-[10px] text-signal-red mt-1.5">{deleteError}</p>}
        <div className="flex items-center justify-end gap-1.5 mt-2.5">
          <button
            type="button"
            onClick={() => setMode('root')}
            className="px-2.5 py-1 text-[11px] rounded text-slate-400 hover:text-white hover:bg-panel-raised"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDeleteConfirm}
            disabled={deletePending}
            className="px-2.5 py-1 text-[11px] rounded bg-signal-red text-white hover:bg-signal-red/90 disabled:opacity-50 flex items-center gap-1.5"
          >
            {deletePending && <Loader2 size={11} className="animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="w-56 py-1">
        {onPlay && (
          <button type="button" role="menuitem" className={itemClass} onClick={() => { onPlay(); onClose(); }}>
            <Play size={13} className="text-slate-400" />
            Play
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => { router.push(`/archive?camera=${camera.id}`); onClose(); }}
        >
          <Film size={13} className="text-slate-400" />
          View Recorded Footage
        </button>
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => { router.push(`/map?camera=${camera.id}`); onClose(); }}
        >
          <LocateFixed size={13} className="text-slate-400" />
          Locate on Map
        </button>

        <Separator />

        <button type="button" role="menuitem" className={itemClass} onClick={() => { onViewDetails(); onClose(); }}>
          <Info size={13} className="text-slate-400" />
          Properties
        </button>
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => { router.push(`/alerts?camera=${camera.id}`); onClose(); }}
        >
          <ShieldAlert size={13} className="text-slate-400" />
          View Alerts for this Camera
        </button>
        <button type="button" role="menuitem" className={itemClass} onClick={() => copy('id', String(camera.id))}>
          {copiedField === 'id' ? <Check size={13} className="text-signal-green" /> : <Copy size={13} className="text-slate-400" />}
          {copiedField === 'id' ? 'Copied' : 'Copy Camera ID'}
        </button>
        {streamUrl && (
          <button type="button" role="menuitem" className={itemClass} onClick={() => copy('stream', streamUrl)}>
            {copiedField === 'stream' ? <Check size={13} className="text-signal-green" /> : <Copy size={13} className="text-slate-400" />}
            {copiedField === 'stream' ? 'Copied' : 'Copy Stream URL'}
          </button>
        )}
        {camera.rtsp_url && (
          <button type="button" role="menuitem" className={itemClass} onClick={() => copy('rtsp', camera.rtsp_url)}>
            {copiedField === 'rtsp' ? <Check size={13} className="text-signal-green" /> : <Copy size={13} className="text-slate-400" />}
            {copiedField === 'rtsp' ? 'Copied' : 'Copy RTSP URL'}
          </button>
        )}

        <Separator />

        <button
          type="button"
          role="menuitem"
          disabled={!canManage}
          title={manageTitle}
          className={itemClass}
          onClick={() => { onConfigure(); onClose(); }}
        >
          <Settings2 size={13} className="text-slate-400" />
          Configure…
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!canManage}
          title={manageTitle}
          className={itemClass}
          onClick={() => setMode('rename')}
        >
          <Pencil size={13} className="text-slate-400" />
          Rename
        </button>

        <Separator />

        <button
          type="button"
          role="menuitem"
          disabled={!canManage}
          title={manageTitle}
          className={`${itemClass} text-signal-red hover:bg-signal-red/10`}
          onClick={() => setMode('delete-confirm')}
        >
          <Trash2 size={13} />
          Delete Camera
        </button>
      </div>
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`${camera.name} actions`}
      style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 2000 }}
      className="bg-panel border border-line rounded-lg shadow-2xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {body}
    </div>,
    document.body
  );
}

export default CameraContextMenu;
