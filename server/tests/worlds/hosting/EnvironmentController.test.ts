import { expect, test } from 'bun:test';
import EnvironmentController from '@/worlds/EnvironmentController';

function createWorldStub(initialSkyboxUri: string = 'skyboxes/procedural?weather=cloudy') {
  return {
    directionalLightPositionCallCount: 0,
    id: 101,
    skyboxUri: initialSkyboxUri,
    skyboxUriCalls: [] as string[],
    setAmbientLightColor() {},
    setAmbientLightIntensity() {},
    setDirectionalLightColor() {},
    setDirectionalLightIntensity() {},
    setDirectionalLightPosition() {
      this.directionalLightPositionCallCount++;
    },
    setFogColor() {},
    setSkySunDirection() {},
    setSkyboxIntensity() {},
    setSkyboxUri(uri: string) {
      this.skyboxUri = uri;
      this.skyboxUriCalls.push(uri);
    },
  };
}

test('preset mode applies snowing once and remains static', async () => {
  const world = createWorldStub();
  const controller = new EnvironmentController(world as any, {
    autoStart: false,
    clockIntervalMs: 20,
    preset: 'snowing',
  });

  try {
    controller.start();

    expect(controller.preset).toBe('snowing');
    expect(controller.weatherPreset).toBe('overcast');
    expect(world.skyboxUri).toContain('weather=overcast');
    expect(world.skyboxUri).toContain('precip=snow');

    const initialDirectionalUpdates = world.directionalLightPositionCallCount;
    await Bun.sleep(70);

    expect(world.directionalLightPositionCallCount).toBe(initialDirectionalUpdates);
  } finally {
    controller.dispose();
  }
});

test('preset mode preserves explicit procedural weather when no preset was requested', () => {
  const world = createWorldStub('skyboxes/procedural?weather=cloudy');
  const controller = new EnvironmentController(world as any, {
    autoStart: false,
  });

  try {
    controller.start();

    expect(controller.preset).toBe('daytime');
    expect(controller.weatherPreset).toBe('cloudy');
    expect(world.skyboxUri).toContain('skyboxes/procedural');
    expect(world.skyboxUri).toContain('weather=cloudy');
  } finally {
    controller.dispose();
  }
});

test('preset mode preserves explicit procedural weather when preset and procedural URI are both provided', () => {
  const world = createWorldStub('skyboxes/procedural?weather=cloudy');
  const controller = new EnvironmentController(world as any, {
    autoStart: false,
    preset: 'daytime',
    proceduralSkyUri: 'skyboxes/procedural?weather=cloudy',
  });

  try {
    controller.start();

    expect(controller.preset).toBe('daytime');
    expect(controller.weatherPreset).toBe('cloudy');
    expect(world.skyboxUri).toContain('skyboxes/procedural');
    expect(world.skyboxUri).toContain('weather=cloudy');
  } finally {
    controller.dispose();
  }
});

test('custom non-procedural skyboxes stay unchanged unless procedural sky is explicitly requested', () => {
  const world = createWorldStub('skyboxes/custom-evening');
  const controller = new EnvironmentController(world as any, {
    autoStart: false,
  });

  try {
    controller.start();

    expect(world.skyboxUri).toBe('skyboxes/custom-evening');
    expect(world.skyboxUriCalls).toHaveLength(0);
  } finally {
    controller.dispose();
  }
});

test('setPreset can preserve cloudy daytime when upgrading legacy partly-cloudy skyboxes', () => {
  const world = createWorldStub('skyboxes/procedural?weather=clear');
  const controller = new EnvironmentController(world as any, {
    autoStart: false,
  });

  try {
    controller.setPreset('daytime', 'cloudy', 'skyboxes/procedural?weather=cloudy');

    expect(controller.preset).toBe('daytime');
    expect(controller.weatherPreset).toBe('cloudy');
    expect(world.skyboxUri).toContain('skyboxes/procedural');
    expect(world.skyboxUri).toContain('weather=cloudy');
  } finally {
    controller.dispose();
  }
});

test('legacy skybox aliases upgrade to matching procedural sky presets', () => {
  const world = createWorldStub('skyboxes/partly-cloudy');
  const controller = new EnvironmentController(world as any, {
    autoStart: false,
  });

  try {
    controller.start();

    expect(controller.preset).toBe('daytime');
    expect(controller.weatherPreset).toBe('cloudy');
    expect(world.skyboxUri).toContain('skyboxes/procedural');
    expect(world.skyboxUri).toContain('weather=cloudy');
  } finally {
    controller.dispose();
  }
});

test('sunset and night aliases keep their matching time-of-day presets', () => {
  const sunsetWorld = createWorldStub('skyboxes/sunset');
  const sunsetController = new EnvironmentController(sunsetWorld as any, {
    autoStart: false,
  });
  const nightWorld = createWorldStub('skyboxes/night');
  const nightController = new EnvironmentController(nightWorld as any, {
    autoStart: false,
  });

  try {
    sunsetController.start();
    nightController.start();

    expect(sunsetController.preset).toBe('sunset');
    expect(sunsetWorld.skyboxUri).toContain('skyboxes/procedural');
    expect(sunsetWorld.skyboxUri).toContain('weather=clear');

    expect(nightController.preset).toBe('nighttime');
    expect(nightWorld.skyboxUri).toContain('skyboxes/procedural');
    expect(nightWorld.skyboxUri).toContain('weather=clear');
  } finally {
    sunsetController.dispose();
    nightController.dispose();
  }
});

test('cycle mode still performs repeated environment updates when requested', async () => {
  const world = createWorldStub();
  const controller = new EnvironmentController(world as any, {
    autoStart: false,
    clockIntervalMs: 20,
    cycleDurationMs: 240,
    mode: 'cycle',
  });

  try {
    controller.start();

    const initialDirectionalUpdates = world.directionalLightPositionCallCount;
    await Bun.sleep(70);

    expect(world.directionalLightPositionCallCount).toBeGreaterThan(initialDirectionalUpdates);
  } finally {
    controller.dispose();
  }
});
