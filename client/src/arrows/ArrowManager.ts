import { Vector3Like } from 'three';
import { Arrow } from './Arrow';
import ArrowStats from './ArrowStats';
import { ArrowId } from './ArrowConstants';
import { EntityId } from '../entities/EntityConstants';
import type Game from '../Game';

export interface ArrowCreateData {
  sourceEntityId?: EntityId;
  sourcePosition?: Vector3Like;
  targetEntityId?: EntityId;
  targetPosition?: Vector3Like;
  waypoints?: Vector3Like[];
  color?: { r: number, g: number, b: number };
  textureUri?: string;
}

export default class ArrowManager {
  private _game: Game;
  private _arrows: Map<number, Arrow> = new Map();
  private _nextId: ArrowId = 1;

  constructor(game: Game) {
    this._game = game;
  }

  public connectArrow(data: ArrowCreateData): ArrowId {
    const id = this._nextId++;
    this._arrows.set(id, new Arrow(this._game, Object.assign(data, { id })));
    ArrowStats.count = this._arrows.size;
    return id;
  }

  public disconnectArrow(id: ArrowId): void {
    if (!this._arrows.has(id)) {
      throw new Error(`ArrowManager: Unknown Arrow ID ${id}.`);
    }
    const arrow = this._arrows.get(id)!;
    arrow.dispose();
    this._arrows.delete(id);
    ArrowStats.count = this._arrows.size;
  }

  public update(deltaTimeS: number): void {
    ArrowStats.reset();
    this._arrows.forEach((arrow) => {
      arrow.update(deltaTimeS);
    });
  }
}
