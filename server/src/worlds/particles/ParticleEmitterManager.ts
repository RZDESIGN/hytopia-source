import ParticleEmitter from '@/worlds/particles/ParticleEmitter';
import type Entity from '@/worlds/entities/Entity';
import type World from '@/worlds/World';

/**
 * Manages ParticleEmitter instances in a world.
 *
 * When to use: querying or bulk-cleaning particle emitters for a world.
 * Do NOT use for: configuring emitters; use `ParticleEmitter` instances directly.
 *
 * @remarks
 * The ParticleEmitterManager is created internally per `World` instance.
 * Pattern: spawn emitters during gameplay and use this manager for cleanup on entity despawn.
 *
 * **Category:** Particles
 * @public
 */
export default class ParticleEmitterManager {
  /** @internal */
  private _particleEmitters: Map<number, ParticleEmitter> = new Map();

  /** @internal */
  private _nextParticleEmitterId: number = 1;

  /** @internal */
  private _world: World;

  /** @internal */
  public constructor(world: World) {
    this._world = world;
  }

  /**
   * The world the ParticleEmitterManager is for.
   *
   * **Category:** Particles
   */
  public get world(): World { return this._world; }

  /** @internal */
  public despawnEntityAttachedParticleEmitters(entity: Entity): void {
    this.getAllEntityAttachedParticleEmitters(entity).forEach(particleEmitter => {
      particleEmitter.despawn();
    });
  }

  /**
   * Retrieves all spawned ParticleEmitter instances for the world.
   *
   * @returns An array of ParticleEmitter instances.
   *
   * **Category:** Particles
   */
  public getAllParticleEmitters(): ParticleEmitter[] {
    return Array.from(this._particleEmitters.values());
  }

  /**
   * Retrieves a spawned ParticleEmitter instance by its unique identifier (id).
   *
   * @param id - The unique identifier (id) of the ParticleEmitter to retrieve.
   * @returns The ParticleEmitter instance if found, otherwise undefined.
   *
   * **Category:** Particles
   */
  public getParticleEmitterById(id: number): ParticleEmitter | undefined {
    return this._particleEmitters.get(id);
  }

  /**
   * Retrieves all spawned ParticleEmitter instances attached to a specific entity.
   *
   * Use for: cleanup or inspection of entity-bound emitters.
   *
   * @param entity - The entity to get attached ParticleEmitter instances for.
   * @returns An array of ParticleEmitter instances.
   *
   * **Requires:** Entity should belong to this world for meaningful results.
   *
   * @see `despawnEntityAttachedParticleEmitters()`
   *
   * **Category:** Particles
   */
  public getAllEntityAttachedParticleEmitters(entity: Entity): ParticleEmitter[] {
    return this.getAllParticleEmitters().filter(particleEmitter => particleEmitter.attachedToEntity === entity);
  }

  /** @internal */
  public registerParticleEmitter(particleEmitter: ParticleEmitter): number {
    if (particleEmitter.id !== undefined) {
      return particleEmitter.id;
    }

    const id = this._nextParticleEmitterId;
    this._particleEmitters.set(id, particleEmitter);
    this._nextParticleEmitterId++;

    return id;
  }

  /** @internal */
  public unregisterParticleEmitter(particleEmitter: ParticleEmitter): void {
    if (particleEmitter.id === undefined) {
      return;
    }

    this._particleEmitters.delete(particleEmitter.id);
  }
}
