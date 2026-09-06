import { LoadingScreen } from '@/components/common/LoadingScreen';

/** Next's automatic Suspense boundary for this route segment and everything
 * under it -- shown while a page's own chunk/data is still being fetched
 * (e.g. the first `next dev` request for a route, before it's compiled).
 * Same visual as ShellGate's auth-check gap so the two blank-screen causes
 * read as one consistent "still loading" state, not two different bugs. */
export default function Loading() {
  return <LoadingScreen />;
}
