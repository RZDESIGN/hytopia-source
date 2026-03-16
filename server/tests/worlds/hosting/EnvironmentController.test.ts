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
