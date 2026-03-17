import {
  Color,
  MeshPhysicalMaterial,
  MeshPhysicalMaterialParameters,
  MeshStandardMaterial,
  Texture,
  WebGLProgramParametersWithUniforms,
  WebGLRenderer,
} from 'three';
import { applyDirectionalShadowEdgeFade } from '../three/directionalShadowFade';
import type { ShaderProcessor } from './EmissiveMeshBasicMaterial';

export const HERO_PHYSICAL_USER_DATA_KEY = 'hytopiaHeroPhysical';

export default class EmissiveMeshHeroMaterial extends MeshPhysicalMaterial {
  private _shaderProcessors: ShaderProcessor[] = [];

  constructor(parameters?: MeshPhysicalMaterialParameters & {
    emissive?: Color | string | number;
    emissiveIntensity?: number;
    emissiveMap?: Texture | null;
  }) {
    super(parameters);
    this.userData[HERO_PHYSICAL_USER_DATA_KEY] = true;
  }

  public get customEmissive(): Color {
    return this.emissive;
  }

  public get customEmissiveIntensity(): number {
    return this.emissiveIntensity;
  }

  public set customEmissiveIntensity(intensity: number) {
    this.emissiveIntensity = intensity;
  }

  public get customEmissiveMap(): Texture | null {
    return this.emissiveMap;
  }

  public set customEmissiveMap(map: Texture | null) {
    this.emissiveMap = map;
    this.needsUpdate = true;
  }

  addShaderProcessor(processor: ShaderProcessor, atEnd: boolean = false): void {
    if (atEnd) {
      this._shaderProcessors.push(processor);
    } else {
      this._shaderProcessors.unshift(processor);
    }
  }

  removeShaderProcessor(processor: ShaderProcessor): boolean {
    const index = this._shaderProcessors.indexOf(processor);
    if (index !== -1) {
      this._shaderProcessors.splice(index, 1);
      return true;
    }
    return false;
  }

  onBeforeCompile(params: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer): void {
    super.onBeforeCompile(params, renderer);

    for (const processor of this._shaderProcessors) {
      processor(params, renderer);
    }

    params.fragmentShader = applyDirectionalShadowEdgeFade(params.fragmentShader, params.uniforms as Record<string, { value: number }>);
  }

  clone(): this {
    return new (this.constructor as typeof EmissiveMeshHeroMaterial)().copy(this) as this;
  }

  copy(source: MeshPhysicalMaterial | MeshStandardMaterial | EmissiveMeshHeroMaterial): this {
    super.copy(source as MeshPhysicalMaterial);
    this.emissive.copy(source.emissive);
    this.emissiveIntensity = source.emissiveIntensity;
    this.customEmissiveMap = source.emissiveMap;
    this.userData[HERO_PHYSICAL_USER_DATA_KEY] = true;
    return this;
  }
}
