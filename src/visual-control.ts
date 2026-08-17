import { AppError } from './errors/app-error.js';
import { ErrorCode } from './errors/codes.js';
import type { InputSequenceAction } from './adb/input.js';
import { validateCoordinate, validateDuration } from './validation/common.js';

export type VisualCoordinateSpace = 'device_pixels' | 'normalized_1000';

const NORMALIZED_MAX = 999;

function mapCoordinate(
  value: number,
  name: string,
  coordinateSpace: VisualCoordinateSpace,
  extent: number,
): number {
  if (coordinateSpace === 'device_pixels') return validateCoordinate(value, name);
  if (!Number.isInteger(value) || value < 0 || value > NORMALIZED_MAX) {
    throw new AppError(
      ErrorCode.InvalidCoordinates,
      `${name} must be an integer between 0 and ${NORMALIZED_MAX} in normalized coordinate space.`,
      { details: { name, value, coordinateSpace } },
    );
  }
  if (!Number.isInteger(extent) || extent <= 0) {
    throw new AppError(
      ErrorCode.InvalidInput,
      'Normalized coordinates require a known native display size.',
      { details: { name, extent, coordinateSpace } },
    );
  }
  return Math.round((value * (extent - 1)) / NORMALIZED_MAX);
}

export function mapVisualInputActions(
  actions: readonly InputSequenceAction[],
  coordinateSpace: VisualCoordinateSpace,
  width: number,
  height: number,
): InputSequenceAction[] {
  return actions.map((action) => {
    if (action.type === 'key') return { ...action };
    if (action.type === 'tap') {
      return {
        type: 'tap',
        x: mapCoordinate(action.x, 'x', coordinateSpace, width),
        y: mapCoordinate(action.y, 'y', coordinateSpace, height),
      };
    }
    return {
      type: 'swipe',
      startX: mapCoordinate(action.startX, 'startX', coordinateSpace, width),
      startY: mapCoordinate(action.startY, 'startY', coordinateSpace, height),
      endX: mapCoordinate(action.endX, 'endX', coordinateSpace, width),
      endY: mapCoordinate(action.endY, 'endY', coordinateSpace, height),
      durationMs: validateDuration(action.durationMs, 'durationMs', 30_000),
    };
  });
}
