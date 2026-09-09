'use client';

import React, { createContext, useCallback, useContext, useState } from 'react';

interface ImmersiveModeContextType {
  isImmersive: boolean;
  /** A page (currently only the Dashboard's drag-composed watch grid) calls
   * this to tell AppShell to hide the persistent top nav/header entirely --
   * "entire screen should be only of custom viewer" means the app chrome
   * has to go too, not just the page's own header/sidebar, and AppShell is
   * a different component tree (the layout shell wrapping every page) than
   * the page requesting it, hence a shared context rather than a prop. */
  setImmersive: (value: boolean) => void;
}

const ImmersiveModeContext = createContext<ImmersiveModeContextType | undefined>(undefined);

export function ImmersiveModeProvider({ children }: { children: React.ReactNode }) {
  const [isImmersive, setIsImmersive] = useState(false);
  const setImmersive = useCallback((value: boolean) => setIsImmersive(value), []);
  return (
    <ImmersiveModeContext.Provider value={{ isImmersive, setImmersive }}>{children}</ImmersiveModeContext.Provider>
  );
}

export function useImmersiveMode() {
  const ctx = useContext(ImmersiveModeContext);
  if (!ctx) throw new Error('useImmersiveMode must be used within ImmersiveModeProvider');
  return ctx;
}
