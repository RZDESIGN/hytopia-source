import * as fs from 'fs';
import * as path from 'path';
import {
  Audio,
  AssetsLibrary,
  Collider,
  ColliderShape,
  CollisionGroup,
  BlockType,
  Entity,
  ErrorHandler,
  Player,
  PlayerEvent,
  World,
  WorldManager,
  WorldOptions,
  Vector3Like,
  Quaternion,
  RgbColor,
} from 'hytopia';

import GamePlayer from './GamePlayer';
import GamePlayerEntity from './GamePlayerEntity';

const DEFAULT_MAX_AMBIENT_LIGHT_INTENSITY = 1.5;
const DEFAULT_MAX_DIRECTIONAL_LIGHT_INTENSITY = 3.25;
const DEFAULT_MIN_AMBIENT_LIGHT_INTENSITY = 0.5;
const DEFAULT_MIN_DIRECTIONAL_LIGHT_INTENSITY = 0.4;
const PROCEDURAL_SKY_PREFIX = 'skyboxes/procedural';
const STORM_LIGHTNING_BUCKET_S = 4;
const STORM_PRESET_STORMINESS = 0.88;
const STORM_SOUND_SPEED_METERS_PER_SECOND = 343;
const STORM_THUNDER_DISTANCE_MAX_METERS = 1500;
const STORM_THUNDER_DISTANCE_MIN_METERS = 240;
const WEATHER_RAIN_AUDIO_URI = 'audio/sfx/ambient/weather/rain/rain.mp3';
const WEATHER_RAIN_AUDIO_VOLUME = 0.16;
const WEATHER_THUNDER_AUDIO_URIS = [
  'audio/sfx/ambient/weather/thunder/thunder-strike-1.mp3',
  'audio/sfx/ambient/weather/thunder/thunder-strike-2.mp3',
  'audio/sfx/ambient/weather/thunder/thunder-strike-3.mp3',
  'audio/sfx/ambient/weather/thunder/thunder-strike-4.mp3',
  'audio/sfx/ambient/weather/thunder/thunder-strike-5.mp3',
] as const;

export type WeatherPreset = 'clear' | 'cloudy' | 'overcast' | 'storm';

let cachedAvailableWeatherAudioUris: Set<string> | null = null;

function hashNumber(value: number): number {
  const result = Math.sin(value * 12.9898 + 78.233) * 43758.5453123;
  return result - Math.floor(result);
}

function getAvailableWeatherAudioUris(): ReadonlySet<string> {
  if (cachedAvailableWeatherAudioUris) {
    return cachedAvailableWeatherAudioUris;
  }

  const availableUris = new Set<string>();
  const assetLibraryPath = AssetsLibrary.assetsLibraryPath;
  const candidateUris = [WEATHER_RAIN_AUDIO_URI, ...WEATHER_THUNDER_AUDIO_URIS];

  for (const uri of candidateUris) {
    const localPath = path.join('assets', uri);
    if (fs.existsSync(localPath)) {
      availableUris.add(uri);
      continue;
    }

    if (!assetLibraryPath) {
      continue;
    }

    const libraryPath = path.join(assetLibraryPath, uri);
    if (!fs.existsSync(libraryPath)) {
      continue;
    }

    AssetsLibrary.instance.syncAsset(libraryPath);
    availableUris.add(uri);
  }

  cachedAvailableWeatherAudioUris = availableUris;
  return availableUris;
}

function buildProceduralSkyUri(weatherPreset: WeatherPreset): string {
  return `${PROCEDURAL_SKY_PREFIX}?weather=${weatherPreset}`;
}

function buildProceduralSkyUriWithWeather(baseSkyboxUri: string, weatherPreset: WeatherPreset): string {
  const queryIndex = baseSkyboxUri.indexOf('?');
  const baseUri = queryIndex >= 0 ? baseSkyboxUri.slice(0, queryIndex) : baseSkyboxUri;
  const params = new URLSearchParams(queryIndex >= 0 ? baseSkyboxUri.slice(queryIndex + 1) : '');

  params.set('weather', weatherPreset);

  const query = params.toString();
  return query ? `${baseUri}?${query}` : buildProceduralSkyUri(weatherPreset);
}

function hasStormLightningStrike(bucketIndex: number, weatherSeed: number): boolean {
  const bucketSeed = weatherSeed * 17.131 + bucketIndex * 23.417;
  const strikeChance = Math.max(0, Math.min(1, (STORM_PRESET_STORMINESS - 0.58) * 1.15));
  return hashNumber(bucketSeed + 0.19) <= strikeChance;
}

function getStormLightningStrikeStartS(bucketIndex: number, weatherSeed: number): number | null {
  if (!hasStormLightningStrike(bucketIndex, weatherSeed)) {
    return null;
  }

  const bucketSeed = weatherSeed * 17.131 + bucketIndex * 23.417;
  return 0.08 + hashNumber(bucketSeed + 1.13) * 0.2;
}

function getStormThunderDistanceMeters(bucketIndex: number, weatherSeed: number): number {
  return STORM_THUNDER_DISTANCE_MIN_METERS
    + hashNumber(weatherSeed * 9.17 + bucketIndex * 3.71)
      * (STORM_THUNDER_DISTANCE_MAX_METERS - STORM_THUNDER_DISTANCE_MIN_METERS);
}

export enum GameRegionPlayerEvent {
  REACHED = 'GameRegion.REACHED',
}

export type GameRegionPlayerEventPayloads = {
  [GameRegionPlayerEvent.REACHED]: { regionId: string };
}

export type GameRegionRespawnOverride = {
  regionId: string,
  facingAngle: number,
  spawnPoint: Vector3Like,
}

export type GameRegionOptions = {
  id: string,
  ambientAudioUri?: string,
  ambientAudioVolume?: number,
  maxAmbientLightIntensity?: number,
  maxDirectionalLightIntensity?: number,
  minAmbientLightIntensity?: number,
  minDirectionalLightIntensity?: number,
  respawnOverride?: GameRegionRespawnOverride,
  spawnFacingAngle?: number,
  spawnPoint?: Vector3Like,
} & Omit<WorldOptions, 'id'>;

export type SetWeatherPresetOptions = {
  syncSkybox?: boolean;
};

export default class GameRegion {
  private _id: string;
  private _ambientAudio: Audio | undefined;
  private _baseFogColor: RgbColor | undefined;
  private _isSetup: boolean = false;
  private _lastThunderBucket: number | null = null;
  private _maxAmbientLightIntensity: number;
  private _maxDirectionalLightIntensity: number;
  private _minAmbientLightIntensity: number;
  private _minDirectionalLightIntensity: number;
  private _pendingThunderTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();
  private _playerCount: number = 0;
  private _rainAudio: Audio | undefined;
  private _respawnOverride: GameRegionRespawnOverride | undefined;
  private _spawnFacingAngle: number;
  private _spawnPoint: Vector3Like;
  private _thunderAudioUris: readonly string[];
  private _weatherPreset: WeatherPreset = 'clear';
  private _weatherSeed: number;

  private readonly _world: World;

  public constructor(options: GameRegionOptions) {
    const { id, ...regionOptions } = options;

    this._id = id;
    this._ambientAudio = regionOptions.ambientAudioUri ? new Audio({
      uri: regionOptions.ambientAudioUri,
      volume: regionOptions.ambientAudioVolume ?? 0.05,
      loop: true,
    }) : undefined;
    this._weatherSeed = Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0);

    const availableWeatherAudioUris = getAvailableWeatherAudioUris();
    this._rainAudio = availableWeatherAudioUris.has(WEATHER_RAIN_AUDIO_URI) ? new Audio({
      uri: WEATHER_RAIN_AUDIO_URI,
      volume: WEATHER_RAIN_AUDIO_VOLUME,
      loop: true,
    }) : undefined;
    this._thunderAudioUris = WEATHER_THUNDER_AUDIO_URIS.filter(uri => availableWeatherAudioUris.has(uri));

    this._baseFogColor = regionOptions.fogColor;
    this._maxAmbientLightIntensity = regionOptions.maxAmbientLightIntensity ?? DEFAULT_MAX_AMBIENT_LIGHT_INTENSITY;
    this._maxDirectionalLightIntensity = regionOptions.maxDirectionalLightIntensity ?? DEFAULT_MAX_DIRECTIONAL_LIGHT_INTENSITY;
    this._minAmbientLightIntensity = regionOptions.minAmbientLightIntensity ?? DEFAULT_MIN_AMBIENT_LIGHT_INTENSITY;
    this._minDirectionalLightIntensity = regionOptions.minDirectionalLightIntensity ?? DEFAULT_MIN_DIRECTIONAL_LIGHT_INTENSITY;
    this._respawnOverride = regionOptions.respawnOverride;
    this._spawnFacingAngle = regionOptions.spawnFacingAngle ?? 0;
    this._spawnPoint = regionOptions.spawnPoint ?? { x: 0, y: 10, z: 0 };
    const supportsDynamicWeather = regionOptions.skyboxUri.startsWith(PROCEDURAL_SKY_PREFIX);
    const environmentOption = regionOptions.environment;
    const environmentOptions = typeof environmentOption === 'object' ? environmentOption : undefined;
    const worldOptions = supportsDynamicWeather && environmentOption !== false
      ? {
        ...regionOptions,
        environment: {
          ...environmentOptions,
          weatherSeed: environmentOptions?.weatherSeed ?? this._weatherSeed,
          onWeatherPresetChange: (world: World, weatherPreset: WeatherPreset) => {
            environmentOptions?.onWeatherPresetChange?.(world, weatherPreset);
            this.setWeatherPreset(weatherPreset, { syncSkybox: false });
          },
        },
      }
      : regionOptions;

    this._world = WorldManager.instance.createWorld(worldOptions);
    this._world.stop(); // Keep it in stopped state, when a player joins the world, we'll start it.
    this._world.on(PlayerEvent.JOINED_WORLD, ({ player }) => this.onPlayerJoin(player));
    this._world.on(PlayerEvent.LEFT_WORLD, ({ player }) => this.onPlayerLeave(player));
    this._world.on(PlayerEvent.RECONNECTED_WORLD, ({ player }) => this.onPlayerReconnected(player));
    
    // temp
    // this._world.simulation.enableDebugRendering(true);
    // this._world.simulation.enableDebugRaycasting(true);

    this.setup();
  }

  public get id(): string { return this._id; }
  public get baseFogColor(): RgbColor | undefined { return this._baseFogColor; }
  public get maxAmbientLightIntensity(): number { return this._maxAmbientLightIntensity; }
  public get maxDirectionalLightIntensity(): number { return this._maxDirectionalLightIntensity; }
  public get minAmbientLightIntensity(): number { return this._minAmbientLightIntensity; }
  public get minDirectionalLightIntensity(): number { return this._minDirectionalLightIntensity; }
  public get name(): string { return this._world.name; }
  public get respawnOverride(): GameRegionRespawnOverride | undefined { return this._respawnOverride; }
  public get spawnFacingAngle(): number { return this._spawnFacingAngle; }
  public get spawnPoint(): Vector3Like { return this._spawnPoint; }
  public get weatherSeed(): number { return this._weatherSeed; }
  public get world(): World { return this._world; }

  public setWeatherPreset(weatherPreset: WeatherPreset, options: SetWeatherPresetOptions = {}): void {
    const supportsDynamicWeather = options.syncSkybox !== false
      && this._world.skyboxUri.startsWith(PROCEDURAL_SKY_PREFIX);
    const weatherChanged = this._weatherPreset !== weatherPreset;

    this._weatherPreset = weatherPreset;

    if (supportsDynamicWeather && weatherChanged) {
      this._world.setSkyboxUri(buildProceduralSkyUriWithWeather(this._world.skyboxUri, weatherPreset));
    }

    if (weatherChanged && weatherPreset !== 'storm') {
      this._clearPendingThunder();
    }

    this._syncWeatherAudio();
    this._updateStormThunder();
  }

  protected setup(): void { // intended to be overridden by subclasses
    if (this._isSetup) {
      return ErrorHandler.warning(`GameRegion.setup(): ${this.name} already setup.`);
    }

    if (this._ambientAudio) {
      this._ambientAudio.play(this._world);
    }

    this._syncWeatherAudio();

    new Collider({ // Out of world collider
      shape: ColliderShape.BLOCK,
      collisionGroups: {
        belongsTo: [ CollisionGroup.ALL ],
        collidesWith: [ CollisionGroup.ENTITY, CollisionGroup.PLAYER ],
      },
      halfExtents: { x: 500, y : 32, z: 500 },
      isSensor: true,
      relativePosition: { x: 0, y: -64, z: 0 },
      onCollision: this.onEntityOutOfWorld,
      simulation: this._world.simulation, // setting this auto adds collider to simulation upon instantiation.
    });

    this._isSetup = true;
  }

  protected onEntityOutOfWorld(other: BlockType | Entity, started: boolean) {
    if (!started) return;

    if (other instanceof GamePlayerEntity) {
      other.setPosition(other.gamePlayer.respawnPoint); // move them to respawn point
      return other.takeDamage(other.maxHealth); // kill player
    }

    if (other instanceof Entity) {
      return other.despawn();
    }
  }

  protected onPlayerJoin(player: Player) {
    const gamePlayer = GamePlayer.getOrCreate(player);
    
    // Set the current region for the player
    gamePlayer.setCurrentRegion(this);
    
    // Get the region spawn point if set by a portal or something else, otherwise use the default region spawn point.
    const spawnPoint = gamePlayer.currentRegionSpawnPoint ?? this._spawnPoint;
    const spawnFacingAngle = gamePlayer.currentRegionSpawnFacingAngle ?? this._spawnFacingAngle;
    const gamePlayerEntity = new GamePlayerEntity(gamePlayer);

    gamePlayerEntity.spawn(this._world, spawnPoint, Quaternion.fromEuler(0, spawnFacingAngle, 0));
    
    // Make the camera look at the correct spawn facing angle.
    // Calculate look direction based on facing angle (identity direction is -z, consistent with threejs)
    const facingAngleRad = spawnFacingAngle * Math.PI / 180;  
    player.camera.facePosition({
      x: spawnPoint.x - Math.sin(facingAngleRad),
      y: spawnPoint.y,
      z: spawnPoint.z - Math.cos(facingAngleRad),
    });

    // Emit the reached event to the player's event router.
    gamePlayer.eventRouter.emit(GameRegionPlayerEvent.REACHED, { regionId: this._id });

    this._playerCount++;

    // Only run the region physics & ticking if a player is in the region.
    if (this._playerCount === 1) {
      this._world.start();
    }

    this._syncWeatherAudio();
    this._updateStormThunder();
  }

  protected onPlayerLeave(player: Player) {
    // We assume the player left the game on region leave, we do all cleanup here.
    // If they didn't, there's no downside and their player object will be reinitialized 
    // when they rejoin this or another rejoin before their connection times out.
    // If this causes issues in the future, we should move .remove to the actualy
    // Player closed connection event.
    GamePlayer.remove(player);

    this._playerCount--;

    // Stop the region physics & ticking if no players are in the region.
    if (this._playerCount <= 0) {
      this._rainAudio?.pause();
      this._clearPendingThunder();
      this._world.stop();
    }
  }

  // The RECONNECTED_WORLD even is only emitted by the engine when the player disconnects and
  // reconnects to the game with a known connectionId before the close connection timeout finishes
  // which gives them 5 second window to reconnect after disconnecting. This event will fire such
  // as if a player unintentionally refreshes the page, if their browser crashes but restarts quickly
  // with the same connectionId in the URL, etc.
  // The HYTOPIA SDK handles resynchronization of all persisted state back to the player client such as
  // their entity, scene ui states, etc, but anything that uses ephemeral state (Such as UI) we need
  // to handle reloading for them manually here.
  protected onPlayerReconnected(player: Player) { 
    const gamePlayer = GamePlayer.getOrCreate(player);
    gamePlayer.onPlayerReconnected();
  }

  private _syncWeatherAudio(): void {
    if (this._weatherPreset === 'storm' && this._playerCount > 0) {
      this._rainAudio?.play(this._world);
      return;
    }

    this._rainAudio?.pause();
  }

  private _clearPendingThunder(): void {
    this._pendingThunderTimeouts.forEach((timeout) => {
      clearTimeout(timeout);
    });

    this._pendingThunderTimeouts.clear();
    this._lastThunderBucket = null;
  }

  private _updateStormThunder(): void {
    if (this._weatherPreset !== 'storm' || this._playerCount <= 0) {
      this._clearPendingThunder();
      return;
    }

    if (this._thunderAudioUris.length === 0) {
      return;
    }

    const worldTimeS = this._world.loop.currentTick * this._world.loop.timestepS;
    const lightningBucket = Math.floor(worldTimeS / STORM_LIGHTNING_BUCKET_S);
    if (this._lastThunderBucket === lightningBucket) {
      return;
    }

    const lightningStrikeStartS = getStormLightningStrikeStartS(lightningBucket, this._weatherSeed);
    this._lastThunderBucket = lightningBucket;
    if (lightningStrikeStartS === null) {
      return;
    }

    const thunderDistanceMeters = getStormThunderDistanceMeters(lightningBucket, this._weatherSeed);
    const distanceT = (thunderDistanceMeters - STORM_THUNDER_DISTANCE_MIN_METERS)
      / (STORM_THUNDER_DISTANCE_MAX_METERS - STORM_THUNDER_DISTANCE_MIN_METERS);
    const thunderUri = this._thunderAudioUris[
      Math.floor(hashNumber(this._weatherSeed * 5.13 + lightningBucket * 7.71) * this._thunderAudioUris.length)
    ];
    const thunderDelayS = thunderDistanceMeters / STORM_SOUND_SPEED_METERS_PER_SECOND;
    const thunderVolume = 0.18
      + (1 - distanceT) * 0.16
      + hashNumber(this._weatherSeed * 2.41 + lightningBucket * 4.87) * 0.06;
    const thunderAtWorldTimeS = lightningBucket * STORM_LIGHTNING_BUCKET_S + lightningStrikeStartS + thunderDelayS;
    const thunderDelayMs = Math.max(0, (thunderAtWorldTimeS - worldTimeS) * 1000);

    const timeout = setTimeout(() => {
      this._pendingThunderTimeouts.delete(timeout);

      if (this._weatherPreset !== 'storm' || this._playerCount <= 0) {
        return;
      }

      (new Audio({
        uri: thunderUri,
        volume: thunderVolume,
      })).play(this._world);
    }, thunderDelayMs);

    this._pendingThunderTimeouts.add(timeout);
  }
}
