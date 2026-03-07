import {
  Color,
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  ShaderMaterial,
  WebGLProgramParametersWithUniforms,
} from 'three';
import { ALPHA_TEST_THRESHOLD, BlockTextureAtlasEventType, LIGHT_LEVEL_STRENGTH_MULTIPLIER, WATER_SURFACE_Y_OFFSET } from './BlockConstants';
import Game from '../Game';
import EventRouter from '../events/EventRouter';

const UNIFORM_RAW_AMBIENT_LIGHT_COLOR = 'rawAmbientLightColor';
const UNIFORM_AMBIENT_LIGHT_INTENSITY = 'ambientLightIntensity';
const DEFINE_HAS_LIGHT_LEVEL = 'HAS_LIGHT_LEVEL';

// Using MeshBasicMaterial instead of MeshPhongMaterial for better GPU performance.
// MeshBasicMaterial doesn't calculate lighting, making it the cheapest option.
// Ambient lighting and block light levels are applied by multiplying the output color directly.
class MeshBlockMaterial extends MeshBasicMaterial {
  private _game: Game;

  constructor(game: Game, transparent: boolean, hasLightLevel: boolean = true) {
    super({
      map: null, // set later,
      side: FrontSide,
      vertexColors: true,
      transparent,
      alphaTest: ALPHA_TEST_THRESHOLD,
    });

    this._game = game;

    // For program cache key in WebGLRenderer to prevent unintended cases where programs are
    // treated as identical between the presence or absence of lightLevel.
    this.defines = this.defines || {};
    this.defines[DEFINE_HAS_LIGHT_LEVEL] = hasLightLevel;
  }

  public onBeforeCompile(params: WebGLProgramParametersWithUniforms): void {
    const ambientLight = this._game.renderer.ambientLight;
    const hasLightLevel = this.defines![DEFINE_HAS_LIGHT_LEVEL];

    // Use getter pattern so ambient light changes are immediately reflected
    params.uniforms[UNIFORM_RAW_AMBIENT_LIGHT_COLOR] = { value: ambientLight.color };
    params.uniforms[UNIFORM_AMBIENT_LIGHT_INTENSITY] = {
      get value() { return ambientLight.intensity; }
    };

    // Add lightLevel attribute/varying to vertex shader if needed
    if (hasLightLevel) {
      params.vertexShader = params.vertexShader.replace(
        'void main() {',
        `
          attribute float lightLevel;
          varying float vLightLevel;
          void main() {
            vLightLevel = lightLevel;
        `,
      );
    }

    // Build fragment shader: add uniforms and apply ambient/block lighting
    // MeshBasicMaterial has no lighting system, so we manually multiply outgoingLight
    const varyingDecl = hasLightLevel ? 'varying float vLightLevel;' : '';
    const lightingCalc = hasLightLevel
      ? `
          vec3 ambientLight = ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR} * ${UNIFORM_AMBIENT_LIGHT_INTENSITY};
          // Force multiplier to float for strict mobile GLSL compilers (avoid vec3/float * int-literal issues).
          vec3 blockLight = ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR} * vLightLevel * float(${LIGHT_LEVEL_STRENGTH_MULTIPLIER});
          outgoingLight *= max(ambientLight, blockLight);
        `
      : `outgoingLight *= ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR} * ${UNIFORM_AMBIENT_LIGHT_INTENSITY};`;

    params.fragmentShader = params.fragmentShader
      .replace(
        'void main() {',
        `
          ${varyingDecl}
          uniform vec3 ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR};
          uniform float ${UNIFORM_AMBIENT_LIGHT_INTENSITY};
          void main() {
        `,
      )
      .replace(
        '#include <opaque_fragment>',
        `
          ${lightingCalc}
          #include <opaque_fragment>
        `,
      );
  }

  public override clone(): this {
    return new (this.constructor as typeof MeshBlockMaterial)(
      this._game,
      this.transparent,
      Boolean(this.defines?.[DEFINE_HAS_LIGHT_LEVEL]),
    ).copy(this) as this;
  }

  public override copy(source: MeshBlockMaterial): this {
    super.copy(source);
    this._game = source._game;
    this.defines = { ...(source.defines ?? {}) };
    return this;
  }
}

const UNIFORM_TIME = 'time';
const UNIFORM_TEXTURE_ATLAS = 'textureAtlas';
const UNIFORM_AMBIENT_LIGHT_COLOR = 'ambientLightColor';
const ATTRIBUTE_FOAM_LEVEL = 'foamLevel';
const ATTRIBUTE_FOAM_LEVEL_DIAG = 'foamLevelDiag';

class MeshLiquidMaterial extends ShaderMaterial {
  constructor() {
    // TODO: Support Light Level
    super({
      uniforms: {
        [UNIFORM_TIME]: { value: 0 },
        [UNIFORM_TEXTURE_ATLAS]: { value: null }, // set later
        [UNIFORM_AMBIENT_LIGHT_COLOR]: { value: new Color() },
      },
      vertexShader: `
        uniform float ${UNIFORM_TIME};

        attribute vec4 ${ATTRIBUTE_FOAM_LEVEL};
        attribute vec4 ${ATTRIBUTE_FOAM_LEVEL_DIAG};

        varying vec3 vNormal;
        varying vec3 vViewVector;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec4 vFoamLevel;
        varying vec4 vFoamLevelDiag;

        void main() {
          vFoamLevel = ${ATTRIBUTE_FOAM_LEVEL};
          vFoamLevelDiag = ${ATTRIBUTE_FOAM_LEVEL_DIAG};
          vNormal = normalize(normal);
          vUv = uv;

          // Calculate world position and view vector
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xyz;
          vViewVector = normalize(cameraPosition - worldPos.xyz);

          // Wave animation calculations
          vec3 pos = position;
          float slowTime = ${UNIFORM_TIME} * 0.5;

          // Optimize face checks by combining conditions
          float yOffset = ${WATER_SURFACE_Y_OFFSET};
          float normalY = normal.y;
          float absNormalX = abs(normal.x);
          float absNormalZ = abs(normal.z);

          // Apply vertical offset to all faces that need it
          if (normalY > 0.5 || absNormalX > 0.5 || absNormalZ > 0.5) {
            pos.y += yOffset;
          }

          // Minimal outward push for side faces
          if (absNormalX > 0.5) pos.x += sign(normal.x) * 0.001;
          if (absNormalZ > 0.5) pos.z += sign(normal.z) * 0.001;

          // Simplified wave calculation
          vec2 corner = floor(worldPos.xz + 0.5);
          float wave = sin(dot(corner, vec2(0.5)) + slowTime) * cos(dot(corner, vec2(0.5)) + slowTime) * 0.04 +
                       sin(dot(corner, vec2(0.8)) + slowTime * 1.2) * cos(dot(corner, vec2(0.8)) + slowTime * 0.8) * 0.02;

          // Only apply negative waves
          wave = min(0.0, wave);
          pos.y += wave;

          // Apply inward depression
          float depression = abs(wave) * 0.05;
          if (absNormalX > 0.5) pos.x -= sign(normal.x) * depression;
          if (absNormalZ > 0.5) pos.z -= sign(normal.z) * depression;

          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform float ${UNIFORM_TIME};
        uniform sampler2D ${UNIFORM_TEXTURE_ATLAS};
        uniform vec3 ${UNIFORM_AMBIENT_LIGHT_COLOR};

        varying vec3 vNormal;
        varying vec3 vViewVector;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec4 vFoamLevel;
        varying vec4 vFoamLevelDiag;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = smoothstep(vec2(0.0), vec2(1.0), f);

          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));

          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        void main() {
          vec4 texColor = texture2D(${UNIFORM_TEXTURE_ATLAS}, vUv);

          // Early alpha test
          if (texColor.a < 0.2) {
            discard;
          }

          vec3 color = texColor.rgb;

          // Apply ambient light
          color *= ${UNIFORM_AMBIENT_LIGHT_COLOR};

          // Apply Fresnel and wave effects for top faces (no directional light needed)
          if (vNormal.y > 0.5) {
              float fresnel = pow(1.0 - dot(vNormal, vViewVector), 4.0);
              float waveLighting = sin(dot(vWorldPos.xz, vec2(2.0)) + ${UNIFORM_TIME} * 0.5) * 0.1;

              // Combine lighting effects
              color = color * 0.85 +
                      vec3(0.08, 0.12, 0.15) * fresnel +
                      vec3(0.03, 0.05, 0.08) * waveLighting;

              vec2 blockPos = fract(vWorldPos.xz);
              float foamWidth = 0.10;
              float maxFoamDist = foamWidth * 4.6;
              float minDist = 1000.0;

              float distFromPosX = 1.0 - blockPos.x;
              float distFromNegX = blockPos.x;
              float distFromPosZ = 1.0 - blockPos.y;
              float distFromNegZ = blockPos.y;

              if (vFoamLevel.x > 0.5) minDist = min(minDist, distFromPosX);
              if (vFoamLevel.y > 0.5) minDist = min(minDist, distFromNegX);
              if (vFoamLevel.z > 0.5) minDist = min(minDist, distFromPosZ);
              if (vFoamLevel.w > 0.5) minDist = min(minDist, distFromNegZ);

              if (vFoamLevelDiag.x > 0.5) minDist = min(minDist, length(vec2(distFromPosX, distFromPosZ)));
              if (vFoamLevelDiag.y > 0.5) minDist = min(minDist, length(vec2(distFromPosX, distFromNegZ)));
              if (vFoamLevelDiag.z > 0.5) minDist = min(minDist, length(vec2(distFromNegX, distFromPosZ)));
              if (vFoamLevelDiag.w > 0.5) minDist = min(minDist, length(vec2(distFromNegX, distFromNegZ)));

              if (minDist < maxFoamDist) {
                float foamIntensity = exp(-minDist / foamWidth);
                float foamTime = ${UNIFORM_TIME} * 0.3;
                vec2 foamUV = vWorldPos.xz * 6.0;

                float foamNoise = noise(foamUV + vec2(foamTime, 0.0)) * 0.5 +
                                  noise(foamUV * 2.0 + vec2(0.0, foamTime * 0.5)) * 0.3 +
                                  noise(foamUV * 4.0 + vec2(foamTime * 0.3, foamTime * 0.2)) * 0.2;
                float foamPattern = smoothstep(0.3, 0.5, foamNoise);

                // Solid foam at edge, patchy further away
                float finalFoam = mix(foamIntensity, foamPattern * foamIntensity, smoothstep(0.0, 0.05, minDist));

                vec3 foamColor = vec3(1.0, 1.0, 1.0) * ${UNIFORM_AMBIENT_LIGHT_COLOR};
                color = mix(color, foamColor, finalFoam * 0.95);
              }
          }

          gl_FragColor = vec4(color, 0.8);
        }
      `,
      // Set material to DoubleSide to render the water surface from underwater as well.
      // However, set forceSinglePass to true to avoid performance concerns.
      forceSinglePass: true,
      side: DoubleSide,
      transparent: true,
    });
  }

  public update(ambientLightColor: Color, ambientLightIntensity: number): void {
    this.uniforms[UNIFORM_TIME].value += 0.0075;
    this.uniforms[UNIFORM_AMBIENT_LIGHT_COLOR].value.copy(ambientLightColor).multiplyScalar(ambientLightIntensity);
  }
}

export default class BlockMaterialManager {
  private _game: Game;

  private _opaqueMaterial: MeshBlockMaterial;
  private _transparentMaterial: MeshBlockMaterial;
  private _opaqueNonLitMaterial: MeshBlockMaterial;
  private _transparentNonLitMaterial: MeshBlockMaterial;
  private _liquidMaterial: MeshLiquidMaterial;
  private _materialsToUpdate: MeshBlockMaterial[] = [];

  constructor(game: Game) {
    this._game = game;
    // Pass game reference at construction time so it's available when shader compiles
    // All materials need game reference for ambient light - NonLit just doesn't have block light levels
    this._opaqueMaterial = new MeshBlockMaterial(game, false, true);
    this._transparentMaterial = new MeshBlockMaterial(game, true, true);
    this._opaqueNonLitMaterial = new MeshBlockMaterial(game, false, false);
    this._transparentNonLitMaterial = new MeshBlockMaterial(game, true, false);
    this._liquidMaterial = new MeshLiquidMaterial();

    EventRouter.instance.on(
      BlockTextureAtlasEventType.Ready,
      () => {
        const textureAtlas = this._game.blockTextureAtlasManager.texture;
        this._opaqueMaterial.map = textureAtlas;
        this._transparentMaterial.map = textureAtlas;
        this._opaqueNonLitMaterial.map = textureAtlas;
        this._transparentNonLitMaterial.map = textureAtlas;
        this._liquidMaterial.uniforms[UNIFORM_TEXTURE_ATLAS].value = textureAtlas;

        // It seems that when map changes from null to non-null, it still requires an
        // explicit material.needsUpdate = true call to reflect the change.
        this._opaqueMaterial.needsUpdate = true;
        this._transparentMaterial.needsUpdate = true;
        this._opaqueNonLitMaterial.needsUpdate = true;
        this._transparentNonLitMaterial.needsUpdate = true;
        this._liquidMaterial.needsUpdate = true;

        this._materialsToUpdate.forEach(material => {
          material.map = textureAtlas;
          material.needsUpdate = true;
        });
        this._materialsToUpdate.length = 0;
      },
    )
  }

  public get opaqueMaterial(): MeshBlockMaterial { return this._opaqueMaterial; }
  public get transparentMaterial(): MeshBlockMaterial { return this._transparentMaterial; }
  public get opaqueNonLitMaterial(): MeshBlockMaterial { return this._opaqueNonLitMaterial; }
  public get transparentNonLitMaterial(): MeshBlockMaterial { return this._transparentNonLitMaterial; }
  public get liquidMaterial(): MeshLiquidMaterial { return this._liquidMaterial; }

  public update(): void {
    // Block materials (MeshBlockMaterial) directly reference ambientLight via getters,
    // so they don't need explicit updates. Only liquid material needs updating for time animation.
    const ambientLight = this._game.renderer.ambientLight;
    this._liquidMaterial.update(ambientLight.color, ambientLight.intensity);
  }

  public cloneTransparentNonLitMaterial(): MeshBlockMaterial {
    const clonedMaterial = this._transparentNonLitMaterial.clone();

    // If the texture is not ready yet, it must be set once it becomes available.
    // If we could create the BlockTextureAtlas texture instance synchronously,
    // we could remove this complexity...
    if (clonedMaterial.map === null) {
      this._materialsToUpdate.push(clonedMaterial);
    }

    return clonedMaterial;
  }
}