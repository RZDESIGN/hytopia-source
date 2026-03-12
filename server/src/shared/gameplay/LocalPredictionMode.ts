export const LOCAL_PREDICTION_MODE_DEFAULT = 1;
export const LOCAL_PREDICTION_MODE_CUSTOM = 2;

export type LocalPredictionMode = 'default' | 'custom';

export const encodeLocalPredictionMode = (
  mode: LocalPredictionMode | undefined,
): number | undefined => {
  if (mode === 'default') {
    return LOCAL_PREDICTION_MODE_DEFAULT;
  }

  if (mode === 'custom') {
    return LOCAL_PREDICTION_MODE_CUSTOM;
  }

  return undefined;
};

export const decodeLocalPredictionMode = (
  mode: number | undefined,
): LocalPredictionMode | undefined => {
  if (mode === LOCAL_PREDICTION_MODE_DEFAULT) {
    return 'default';
  }

  if (mode === LOCAL_PREDICTION_MODE_CUSTOM) {
    return 'custom';
  }

  return undefined;
};
