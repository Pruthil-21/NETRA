import type { DragEvent } from 'react';

/** Custom dataTransfer type carrying camera ids dragged out of
 * DistrictAreaTree -- distinct from FeedCard's own reorder drag (which
 * uses plain "text/plain") so a grid's drop target can tell "an officer is
 * dragging in cameras to watch" apart from "a tile is being reordered
 * within the grid" just by checking which type is present. */
export const CAMERA_DRAG_MIME = 'application/x-netra-camera-ids';

/** A district/area/camera row in DistrictAreaTree calls this to make
 * itself draggable -- one camera row drags just its own id, a area/district
 * row drags every camera under it (resolved by the caller before this is
 * invoked, since only the tree knows its own camerasByArea/district maps). */
export function startCameraDrag(cameraIds: number[]) {
  return (e: DragEvent<Element>) => {
    e.dataTransfer.setData(CAMERA_DRAG_MIME, JSON.stringify(cameraIds));
    e.dataTransfer.effectAllowed = 'copy';
  };
}
