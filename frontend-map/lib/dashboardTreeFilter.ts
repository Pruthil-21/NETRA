import type { CameraFeed } from '@/types/stream';
import type { TreeSelection } from '@/components/tree/DistrictAreaTree';

/** Pulled out as a pure function (not inlined in a useMemo on the page) so
 * its "district selects everything under it, area narrows to just its
 * own cameras, nothing selected shows every registered feed" contract is
 * directly unit-testable without rendering the whole dashboard. Showing
 * everything by default (rather than an empty state) matters operationally:
 * an officer's live wall shouldn't require a tree click just to see any
 * camera at all -- the tree narrows down, it doesn't gate. */
export function filterFeedsByTreeSelection(
  feeds: CameraFeed[],
  selection: TreeSelection,
  areaIdByCameraId: Record<string, number | null>
): CameraFeed[] {
  if (selection === null) return feeds;
  if (selection.type === 'district') {
    return feeds.filter((f) => f.department === selection.value);
  }
  if (selection.type === 'camera') {
    return feeds.filter((f) => f.id === String(selection.value));
  }
  return feeds.filter((f) => areaIdByCameraId[f.id] === selection.value);
}
