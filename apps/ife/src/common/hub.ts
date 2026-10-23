import { fetchHubStatus, type HubStatus } from '@hearme/shared';
import { useEffect, useState } from 'react';

/**
 * The cabin hub serves this app, so it lives at the same origin. In `vite dev`
 * the dev server proxies /api and /ws to a hub on localhost:8080.
 */
export function hubBaseUrl(): string {
  return (import.meta.env.VITE_HUB_URL as string | undefined) ?? window.location.origin;
}

let first: Promise<HubStatus | null> | null = null;

/** One-time check used at startup to decide between the real hub and the in-browser simulation. */
export function detectHub(): Promise<HubStatus | null> {
  first ??= fetchHubStatus(hubBaseUrl());
  return first;
}

/**
 * Live hub status (models loading → ready, connected devices). Once the hub has
 * answered, it counts as gone only after `patience` missed polls in a row: a hub
 * busy transcribing or translating can miss one, and the stage must not tear
 * down (and reload) its apps for that.
 */
export function useHubStatus(pollMs = 3000, patience = 3): HubStatus | null | undefined {
  const [status, setStatus] = useState<HubStatus | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let misses = 0;
    const check = () =>
      fetchHubStatus(hubBaseUrl()).then((s) => {
        if (!alive) return;
        misses = s ? 0 : misses + 1;
        setStatus((prev) => s ?? (prev && misses < patience ? prev : null));
      });
    void check();
    const t = setInterval(check, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs, patience]);
  return status;
}
