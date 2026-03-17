import {
  Color,
  MeshStandardMaterial,
  MeshStandardMaterialParameters,
  Texture,
  WebGLProgramParametersWithUniforms,
  WebGLRenderer,
} from 'three';
import { applyDirectionalShadowEdgeFade } from '../three/directionalShadowFade';

export type ShaderProcessor = (params: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void;

// The legacy name is kept to avoid a wide rename across the client. The implementation
// is now a lit PBR material so imported assets can participate in modern lighting/shadows.
export default class EmissiveMeshBasicMaterial extends MeshStandardMaterial {
  private _shaderProcessors: ShaderProcessor[] = [];

  constructor(parameters?: MeshStandardMaterialParameters & {
    emissive?: Color | string | number;
    emissiveIntensity?: number;
    emissiveMap?: Texture | null;
  }) {
    super(parameters);
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
      // Add new processors at the start so the emissive processor (added via push in the constructor) remains last in execution order
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
    return new (this.constructor as typeof EmissiveMeshBasicMaterial)().copy(this) as this; // type-check hack
  }

  copy(source: MeshStandardMaterial | EmissiveMeshBasicMaterial): this {
    super.copy(source);
    this.emissive.copy(source.emissive);
    this.emissiveIntensity = source.emissiveIntensity;
    this.customEmissiveMap = source.emissiveMap;
    // Note: Shader processors are not copied - they should be added manually if needed
    return this;
  }
}
