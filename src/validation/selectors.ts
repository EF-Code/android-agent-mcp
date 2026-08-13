import { ErrorCode } from '../errors/codes.js';
import { AppError } from '../errors/app-error.js';
import type { SelectorMatchMode, UiSelector } from '../ui/types.js';

const MAX_SELECTOR_DEPTH = 4;
const MAX_SELECTOR_TEXT = 512;

function validateMatchMode(mode: SelectorMatchMode | undefined, field: string): SelectorMatchMode {
  const normalized = mode ?? 'exact';
  if (normalized !== 'exact' && normalized !== 'contains' && normalized !== 'regex') {
    throw new AppError(ErrorCode.InvalidSelector, `${field} match mode is unsupported.`, {
      details: { field, mode },
    });
  }

  return normalized;
}

function isPotentiallyUnsafeRegex(pattern: string): boolean {
  return (
    /\\[1-9]/.test(pattern) ||
    /\([^)]*[+*][^)]*\)[+*{]/.test(pattern) ||
    /[+*?}]\s*[+*?{]/.test(pattern)
  );
}

export function compileBoundedRegex(pattern: string): RegExp {
  if (
    pattern.length === 0 ||
    pattern.length > MAX_SELECTOR_TEXT ||
    isPotentiallyUnsafeRegex(pattern)
  ) {
    throw new AppError(
      ErrorCode.InvalidSelector,
      'Regex selector is empty, too long, or potentially unsafe.',
      {
        details: { length: pattern.length },
      },
    );
  }

  try {
    return new RegExp(pattern, 'u');
  } catch (error) {
    throw new AppError(ErrorCode.InvalidSelector, 'Regex selector is not valid.', { cause: error });
  }
}

function validateString(
  value: string | undefined,
  field: string,
  mode: SelectorMatchMode | undefined,
): void {
  if (value === undefined) {
    if (mode !== undefined) {
      throw new AppError(
        ErrorCode.InvalidSelector,
        `${field} match mode requires a selector value.`,
        {
          details: { field },
        },
      );
    }
    return;
  }

  if (value.length === 0 || value.length > MAX_SELECTOR_TEXT) {
    throw new AppError(
      ErrorCode.InvalidSelector,
      `${field} must contain between 1 and 512 characters.`,
      {
        details: { field, length: value.length },
      },
    );
  }

  const normalizedMode = validateMatchMode(mode, field);
  if (normalizedMode === 'regex') {
    compileBoundedRegex(value);
  }
}

export function validateSelector(selector: UiSelector, depth = 0): UiSelector {
  if (depth > MAX_SELECTOR_DEPTH) {
    throw new AppError(ErrorCode.InvalidSelector, 'Selector relationship nesting is too deep.', {
      details: { maximumDepth: MAX_SELECTOR_DEPTH },
    });
  }

  if (
    selector.nodeId !== undefined &&
    (selector.nodeId.length === 0 || selector.nodeId.length > 128)
  ) {
    throw new AppError(ErrorCode.InvalidSelector, 'Snapshot-local node ID is invalid.');
  }

  validateString(selector.text, 'text', selector.textMode);
  validateString(
    selector.contentDescription,
    'contentDescription',
    selector.contentDescriptionMode,
  );

  if (
    selector.resourceId !== undefined &&
    (selector.resourceId.length === 0 || selector.resourceId.length > 512)
  ) {
    throw new AppError(ErrorCode.InvalidSelector, 'resourceId selector is invalid.');
  }

  if (
    selector.className !== undefined &&
    (selector.className.length === 0 || selector.className.length > 512)
  ) {
    throw new AppError(ErrorCode.InvalidSelector, 'className selector is invalid.');
  }

  if (
    selector.packageName !== undefined &&
    (selector.packageName.length === 0 || selector.packageName.length > 255)
  ) {
    throw new AppError(ErrorCode.InvalidSelector, 'packageName selector is invalid.');
  }

  if (selector.ancestor !== undefined) validateSelector(selector.ancestor, depth + 1);
  if (selector.descendant !== undefined) validateSelector(selector.descendant, depth + 1);

  return selector;
}
