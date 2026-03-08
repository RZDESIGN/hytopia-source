export type HytopiaDebugFlagName =
  | 'disableCachedChunkVisibility'
  | 'forceChunkVisibilityFullRefresh';

export type HytopiaDebugFlags = Record<HytopiaDebugFlagName, boolean>;

const STORAGE_KEY_PREFIX = 'hytopia.debug.';

const DEFAULT_DEBUG_FLAGS: HytopiaDebugFlags = {
  disableCachedChunkVisibility: false,
  forceChunkVisibilityFullRefresh: false,
};

type RuntimeDebugSurface = {
  flags: HytopiaDebugFlags;
  getFlags: () => HytopiaDebugFlags;
  resetFlags: () => HytopiaDebugFlags;
  setFlag: (name: HytopiaDebugFlagName, value: boolean) => HytopiaDebugFlags;
};

declare global {
  interface Window {
    __HYTOPIA_DEBUG__?: RuntimeDebugSurface;
  }
}

const cloneFlags = (flags: HytopiaDebugFlags): HytopiaDebugFlags => ({
  disableCachedChunkVisibility: flags.disableCachedChunkVisibility,
  forceChunkVisibilityFullRefresh: flags.forceChunkVisibilityFullRefresh,
});

const getStoredFlag = (name: HytopiaDebugFlagName): boolean | undefined => {
  try {
    const value = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${name}`);
    if (value === null) {
      return undefined;
    }

    return value === '1' || value === 'true';
  } catch {
    return undefined;
  }
};

const setStoredFlag = (name: HytopiaDebugFlagName, value: boolean): void => {
  try {
    window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${name}`, value ? '1' : '0');
  } catch {
    // Storage access is optional for these hidden debug flags.
  }
};

const removeStoredFlags = (): void => {
  try {
    (Object.keys(DEFAULT_DEBUG_FLAGS) as HytopiaDebugFlagName[]).forEach((name) => {
      window.localStorage.removeItem(`${STORAGE_KEY_PREFIX}${name}`);
    });
  } catch {
    // Storage access is optional for these hidden debug flags.
  }
};

const loadInitialFlags = (): HytopiaDebugFlags => {
  const flags = cloneFlags(DEFAULT_DEBUG_FLAGS);

  (Object.keys(flags) as HytopiaDebugFlagName[]).forEach((name) => {
    const storedValue = getStoredFlag(name);
    if (storedValue !== undefined) {
      flags[name] = storedValue;
    }
  });

  return flags;
};

export const ensureRuntimeDebugSurface = (): RuntimeDebugSurface | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  if (window.__HYTOPIA_DEBUG__) {
    return window.__HYTOPIA_DEBUG__;
  }

  const flags = loadInitialFlags();

  window.__HYTOPIA_DEBUG__ = {
    flags,
    getFlags: () => cloneFlags(flags),
    resetFlags: () => {
      removeStoredFlags();
      Object.assign(flags, DEFAULT_DEBUG_FLAGS);
      return cloneFlags(flags);
    },
    setFlag: (name: HytopiaDebugFlagName, value: boolean) => {
      flags[name] = !!value;
      setStoredFlag(name, flags[name]);
      return cloneFlags(flags);
    },
  };

  return window.__HYTOPIA_DEBUG__;
};

export const getDebugFlags = (): HytopiaDebugFlags => {
  const surface = ensureRuntimeDebugSurface();
  return surface ? cloneFlags(surface.flags) : cloneFlags(DEFAULT_DEBUG_FLAGS);
};
