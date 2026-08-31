'use client';

import { useEffect, useState } from 'react';

export interface GeoPosition {
  lat: number;
  long: number;
}

export type GeolocationState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; position: GeoPosition }
  | { status: 'error'; message: string };

/** Watches the officer's own device location (not the vehicle's) --
 * used for the "route from my current location to the last-seen camera"
 * feature and for scoping the header alert bell to nearby cities. Requires
 * the browser's geolocation permission; never falls back to a fabricated
 * position, since a wrong "current location" would draw a misleading route. */
export function useGeolocation(watch: boolean = true): GeolocationState {
  const [state, setState] = useState<GeolocationState>({ status: 'idle' });

  // Synchronizing with an external system (the Geolocation API) -- same
  // justification as CameraRegistryContext's initial-fetch effect.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ status: 'error', message: 'Geolocation is not available in this browser' });
      return;
    }

    setState({ status: 'loading' });

    const onSuccess = (pos: GeolocationPosition) => {
      setState({
        status: 'ready',
        position: { lat: pos.coords.latitude, long: pos.coords.longitude },
      });
    };
    const onError = (err: GeolocationPositionError) => {
      setState({ status: 'error', message: err.message || 'Failed to get current location' });
    };

    if (!watch) {
      navigator.geolocation.getCurrentPosition(onSuccess, onError, { enableHighAccuracy: true });
      return;
    }

    const watchId = navigator.geolocation.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
    });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [watch]);

  return state;
}
