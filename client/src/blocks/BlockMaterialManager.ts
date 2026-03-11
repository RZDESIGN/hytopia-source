import {
  Color,
  DoubleSide,
  FrontSide,
  Matrix4,
  MeshPhongMaterial,
  ShaderMaterial,
  Texture,
  Vector3,
  WebGLProgramParametersWithUniforms,
  WebGLRenderer,
} from 'three';
import { ALPHA_TEST_THRESHOLD, BlockTextureAtlasEventType, WATER_SURFACE_Y_OFFSET } from './BlockConstants';
import Game from '../Game';
import EventRouter from '../events/EventRouter';
import { applyDirectionalShadowEdgeFade } from '../three/directionalShadowFade';

const UNIFORM_RAW_AMBIENT_LIGHT_COLOR = 'rawAmbientLightColor';
const UNIFORM_AMBIENT_LIGHT_INTENSITY = 'ambientLightIntensity';
const BLOCK_OUTGOING_LIGHT_LINE = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;';

function applyBlockColorPunch(fragmentShader: string): string {
  if (fragmentShader.includes('blockHighlight') || !fragmentShader.includes(BLOCK_OUTGOING_LIGHT_LINE)) {
    return fragmentShader;
  }

  return fragmentShader.replace(
    BLOCK_OUTGOING_LIGHT_LINE,
    `
      vec3 outgoingLight = reflectedLight.directDiffuse * 1.06
        + reflectedLight.indirectDiffuse * 0.9
        + reflectedLight.directSpecular * 0.92
        + reflectedLight.indirectSpecular * 0.85
        + totalEmissiveRadiance;

      float blockLuma = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
      float blockHighlight = smoothstep( 0.24, 0.95, blockLuma );
      outgoingLight = mix( vec3( blockLuma ), outgoingLight, 1.08 + blockHighlight * 0.06 );
      outgoingLight *= 1.02 + blockHighlight * 0.05;
    `,
  );
}

class MeshBlockMaterial extends MeshPhongMaterial {
  constructor(_game: Game, transparent: boolean, hasLightLevel: boolean = true) {
    super({
      map: null, // set later,
      side: FrontSide,
      vertexColors: true,
      transparent,
      alphaTest: ALPHA_TEST_THRESHOLD,
      shininess: hasLightLevel ? 18 : 12,
      specular: hasLightLevel ? new Color(0.08, 0.08, 0.08) : new Color(0.04, 0.04, 0.04),
    });

    this.name = hasLightLevel ? 'MeshBlockMaterial' : 'MeshBlockMaterialNonLit';
  }

  public override onBeforeCompile(params: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer): void {
    super.onBeforeCompile(params, renderer);
    params.fragmentShader = applyBlockColorPunch(applyDirectionalShadowEdgeFade(params.fragmentShader));
  }
}

const UNIFORM_TIME = 'time';
const UNIFORM_TEXTURE_ATLAS = 'textureAtlas';
const UNIFORM_AMBIENT_LIGHT_COLOR = 'ambientLightColor';
const UNIFORM_FOG_REFLECTION_COLOR = 'fogReflectionColor';
const UNIFORM_SKY_REFLECTION_COLOR = 'skyReflectionColor';
const UNIFORM_SUN_COLOR = 'sunColor';
const UNIFORM_SUN_DIRECTION = 'sunDirection';
const UNIFORM_SUN_INTENSITY = 'sunIntensity';
const UNIFORM_REFLECTION_TEXTURE = 'reflectionTexture';
const UNIFORM_REFLECTION_TEXTURE_MATRIX = 'reflectionTextureMatrix';
const UNIFORM_REFLECTION_ENABLED = 'reflectionEnabled';
const UNIFORM_INTERACTION_CENTER = 'interactionCenter';
const ATTRIBUTE_FOAM_LEVEL = 'foamLevel';
const ATTRIBUTE_FOAM_LEVEL_DIAG = 'foamLevelDiag';
const ATTRIBUTE_SURFACE_FLAG = 'surfaceFlag';
const ATTRIBUTE_WIND_DATA = 'windData';

class MeshLiquidMaterial extends ShaderMaterial {
  constructor() {
    // TODO: Support Light Level
    super({
      uniforms: {
        [UNIFORM_TIME]: { value: 0 },
        [UNIFORM_TEXTURE_ATLAS]: { value: null }, // set later
        [UNIFORM_AMBIENT_LIGHT_COLOR]: { value: new Color() },
        [UNIFORM_FOG_REFLECTION_COLOR]: { value: new Color() },
        [UNIFORM_SKY_REFLECTION_COLOR]: { value: new Color() },
        [UNIFORM_SUN_COLOR]: { value: new Color(1, 1, 1) },
        [UNIFORM_SUN_DIRECTION]: { value: new Vector3(0.3, -1, 0.2).normalize() },
        [UNIFORM_SUN_INTENSITY]: { value: 0 },
        [UNIFORM_REFLECTION_TEXTURE]: { value: null },
        [UNIFORM_REFLECTION_TEXTURE_MATRIX]: { value: new Matrix4() },
        [UNIFORM_REFLECTION_ENABLED]: { value: 0 },
      },
      vertexShader: `
        uniform float ${UNIFORM_TIME};

        attribute vec4 ${ATTRIBUTE_FOAM_LEVEL};
        attribute vec4 ${ATTRIBUTE_FOAM_LEVEL_DIAG};
        attribute float ${ATTRIBUTE_SURFACE_FLAG};

        varying vec3 vNormal;
        varying vec3 vViewVector;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec4 vFoamLevel;
        varying vec4 vFoamLevelDiag;
        varying float vSurfaceFlag;

        void main() {
          vFoamLevel = ${ATTRIBUTE_FOAM_LEVEL};
          vFoamLevelDiag = ${ATTRIBUTE_FOAM_LEVEL_DIAG};
          vSurfaceFlag = ${ATTRIBUTE_SURFACE_FLAG};
          vNormal = normalize(normal);
          vUv = uv;

          // Calculate world position and view vector
          vec4 worldPos = modelMatrix * vec4(position, 1.0);

          // Wave animation calculations
          vec3 pos = position;
          float slowTime = ${UNIFORM_TIME} * 0.5;

          // Optimize face checks by combining conditions
          float yOffset = ${WATER_SURFACE_Y_OFFSET};
          float normalY = normal.y;
          float absNormalX = abs(normal.x);
          float absNormalZ = abs(normal.z);

          // Apply vertical offset to all faces that need it
          if (vSurfaceFlag > 0.5 && (normalY > 0.5 || absNormalX > 0.5 || absNormalZ > 0.5)) {
            pos.y += yOffset;
          }

          // Minimal outward push for side faces
          if (absNormalX > 0.5) pos.x += sign(normal.x) * 0.001;
          if (absNormalZ > 0.5) pos.z += sign(normal.z) * 0.001;

          // Simplified wave calculation
          float wave = 0.0;
          if (vSurfaceFlag > 0.5) {
            vec2 corner = floor(worldPos.xz + 0.5);
            wave = sin(dot(corner, vec2(0.5)) + slowTime) * cos(dot(corner, vec2(0.5)) + slowTime) * 0.04 +
                   sin(dot(corner, vec2(0.8)) + slowTime * 1.2) * cos(dot(corner, vec2(0.8)) + slowTime * 0.8) * 0.02;

            // Only apply negative waves
            wave = min(0.0, wave);
            pos.y += wave;

            // Apply inward depression only to the actual liquid surface block.
            float depression = abs(wave) * 0.05;
            if (absNormalX > 0.5) pos.x -= sign(normal.x) * depression;
            if (absNormalZ > 0.5) pos.z -= sign(normal.z) * depression;
          }

          vec4 displacedWorldPos = modelMatrix * vec4(pos, 1.0);
          vWorldPos = displacedWorldPos.xyz;
          vViewVector = normalize(cameraPosition - displacedWorldPos.xyz);

          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform float ${UNIFORM_TIME};
        uniform sampler2D ${UNIFORM_TEXTURE_ATLAS};
        uniform vec3 ${UNIFORM_AMBIENT_LIGHT_COLOR};
        uniform vec3 ${UNIFORM_FOG_REFLECTION_COLOR};
        uniform vec3 ${UNIFORM_SKY_REFLECTION_COLOR};
        uniform vec3 ${UNIFORM_SUN_COLOR};
        uniform vec3 ${UNIFORM_SUN_DIRECTION};
        uniform float ${UNIFORM_SUN_INTENSITY};
        uniform sampler2D ${UNIFORM_REFLECTION_TEXTURE};
        uniform mat4 ${UNIFORM_REFLECTION_TEXTURE_MATRIX};
        uniform float ${UNIFORM_REFLECTION_ENABLED};

        varying vec3 vNormal;
        varying vec3 vViewVector;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec4 vFoamLevel;
        varying vec4 vFoamLevelDiag;
        varying float vSurfaceFlag;

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
          vec3 surfaceNormal = gl_FrontFacing ? normalize(vNormal) : normalize(-vNormal);

          // Apply ambient light
          color *= ${UNIFORM_AMBIENT_LIGHT_COLOR};

          // Only the top block in a liquid column should look like a surface.
          if (vSurfaceFlag > 0.5 && vNormal.y > 0.5) {
              vec2 ripplePhase = vWorldPos.xz * vec2(0.24, 0.21) + vec2(${UNIFORM_TIME} * 0.18, -${UNIFORM_TIME} * 0.14);
              vec2 detailPhase = vWorldPos.xz * vec2(0.58, 0.51) + vec2(-${UNIFORM_TIME} * 0.11, ${UNIFORM_TIME} * 0.09);
              vec2 rippleNormal = vec2(
                sin(ripplePhase.x) * 0.028 + cos(ripplePhase.y * 1.18) * 0.018 + sin(detailPhase.x * 1.07) * 0.010,
                cos(ripplePhase.x * 0.92) * 0.024 + sin(ripplePhase.y * 1.09) * 0.016 + cos(detailPhase.y * 0.96) * 0.010
              );
              surfaceNormal = normalize(vec3(surfaceNormal.x + rippleNormal.x, surfaceNormal.y + 0.35, surfaceNormal.z + rippleNormal.y));
              // Reflection is only valid when viewing the water surface from above and when
              // the projected reflection sample is still inside the reflection viewport.
              if (gl_FrontFacing && ${UNIFORM_REFLECTION_ENABLED} > 0.5) {
                vec3 viewDir = normalize(vViewVector);
                float fresnel = pow(1.0 - clamp(dot(surfaceNormal, viewDir), 0.0, 1.0), 3.6);
                vec4 reflectionUv = ${UNIFORM_REFLECTION_TEXTURE_MATRIX} * vec4(vWorldPos, 1.0);
                vec2 projectedReflectionUv = reflectionUv.xy / max(reflectionUv.w, 0.0001);
                float projectedEdgeDistance = min(
                  min(projectedReflectionUv.x, projectedReflectionUv.y),
                  min(1.0 - projectedReflectionUv.x, 1.0 - projectedReflectionUv.y)
                );
                float reflectionOffsetFade = smoothstep(0.0, 0.10, projectedEdgeDistance);
                vec2 projectedReflectionOffset = rippleNormal * mix(0.010, 0.018, fresnel) * reflectionOffsetFade;
                vec2 reflectionSampleUv = clamp(projectedReflectionUv + projectedReflectionOffset, 0.0, 1.0);
                float inBounds = step(0.0, projectedReflectionUv.x) * step(projectedReflectionUv.x, 1.0)
                  * step(0.0, projectedReflectionUv.y) * step(projectedReflectionUv.y, 1.0)
                  * step(0.0, reflectionUv.w);
                float reflectionEdgeFade = smoothstep(0.015, 0.10, projectedEdgeDistance);
                vec3 sceneReflection = texture2D(${UNIFORM_REFLECTION_TEXTURE}, clamp(reflectionSampleUv, 0.0, 1.0)).rgb;
                vec3 reflectionTinted = mix(color, sceneReflection, 0.45 + fresnel * 0.15);
                float reflectionStrength = clamp(0.16 + fresnel * 0.32, 0.0, 0.52) * inBounds * reflectionEdgeFade;

                color = mix(color, reflectionTinted, reflectionStrength);
              }

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

              if (gl_FrontFacing && minDist < maxFoamDist) {
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

  public update(
    ambientLightColor: Color,
    ambientLightIntensity: number,
    fogReflectionColor: Color,
    skyReflectionColor: Color,
    sunDirection: Vector3,
    sunColor: Color,
    sunIntensity: number,
  ): void {
    this.uniforms[UNIFORM_TIME].value += 0.0075;
    this.uniforms[UNIFORM_AMBIENT_LIGHT_COLOR].value.copy(ambientLightColor).multiplyScalar(ambientLightIntensity);
    this.uniforms[UNIFORM_FOG_REFLECTION_COLOR].value.copy(fogReflectionColor);
    this.uniforms[UNIFORM_SKY_REFLECTION_COLOR].value.copy(skyReflectionColor);
    this.uniforms[UNIFORM_SUN_DIRECTION].value.copy(sunDirection);
    this.uniforms[UNIFORM_SUN_COLOR].value.copy(sunColor);
    this.uniforms[UNIFORM_SUN_INTENSITY].value = sunIntensity;
  }

  public setReflection(reflectionTexture: Texture | null, reflectionTextureMatrix: Matrix4, enabled: boolean): void {
    this.uniforms[UNIFORM_REFLECTION_TEXTURE].value = reflectionTexture;
    this.uniforms[UNIFORM_REFLECTION_TEXTURE_MATRIX].value.copy(reflectionTextureMatrix);
    this.uniforms[UNIFORM_REFLECTION_ENABLED].value = enabled ? 1 : 0;
  }
}

class MeshFoliageMaterial extends ShaderMaterial {
  constructor() {
    super({
      uniforms: {
        [UNIFORM_TIME]: { value: 0 },
        [UNIFORM_TEXTURE_ATLAS]: { value: null },
        [UNIFORM_RAW_AMBIENT_LIGHT_COLOR]: { value: new Color() },
        [UNIFORM_AMBIENT_LIGHT_INTENSITY]: { value: 1 },
        [UNIFORM_INTERACTION_CENTER]: { value: new Vector3() },
      },
      vertexShader: `
        uniform float ${UNIFORM_TIME};
        uniform vec3 ${UNIFORM_INTERACTION_CENTER};

        attribute vec4 color;
        attribute vec2 ${ATTRIBUTE_WIND_DATA};

        varying vec2 vUv;
        varying vec4 vColor;
        varying float vTipWeight;

        void main() {
          vUv = uv;
          vColor = color;
          vTipWeight = color.a;

          vec3 pos = position;
          float tipWeight = vTipWeight;
          float tipWeightSq = tipWeight * tipWeight;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vec2 windDir = normalize(vec2(1.0, 0.32));

          float swayPrimary = 0.5 + 0.5 * sin(${UNIFORM_TIME} * 2.2 + worldPos.x * 0.05 + worldPos.z * 0.04);
          float swaySecondary = 0.5 + 0.5 * sin(${UNIFORM_TIME} * 1.4 + ${ATTRIBUTE_WIND_DATA}.y * 0.45);
          float swayMix = mix(swayPrimary, swaySecondary, 0.35);
          float sway = (0.04 + ${ATTRIBUTE_WIND_DATA}.x * 0.03) * swayMix * tipWeightSq;

          pos.xz += windDir * sway;
          pos.y -= sway * 0.12 * tipWeightSq;

          vec2 away = worldPos.xz - ${UNIFORM_INTERACTION_CENTER}.xz;
          float awayLength = length(away);
          float bendFalloff = 1.0 - smoothstep(0.0, 1.8, awayLength);
          float pressFalloff = 1.0 - smoothstep(0.0, 0.85, awayLength);
          if (bendFalloff > 0.0) {
            vec2 awayDir = awayLength > 0.0001 ? away / awayLength : windDir;
            float spread = bendFalloff * (0.16 + ${ATTRIBUTE_WIND_DATA}.x * 0.16) * tipWeightSq;
            float flatten = (pressFalloff * pressFalloff * 0.28 + bendFalloff * 0.07) * tipWeightSq;
            pos.xz += awayDir * spread;
            pos.y -= flatten;
          }

          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D ${UNIFORM_TEXTURE_ATLAS};
        uniform vec3 ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR};
        uniform float ${UNIFORM_AMBIENT_LIGHT_INTENSITY};

        varying vec2 vUv;
        varying vec4 vColor;
        varying float vTipWeight;

        void main() {
          vec4 texColor = texture2D(${UNIFORM_TEXTURE_ATLAS}, vUv);
          if (texColor.a < ${ALPHA_TEST_THRESHOLD}) {
            discard;
          }

          vec3 ambientLight = ${UNIFORM_RAW_AMBIENT_LIGHT_COLOR} * ${UNIFORM_AMBIENT_LIGHT_INTENSITY};
          float bladeGradient = mix(0.72, 1.0, clamp(vTipWeight, 0.0, 1.0));
          vec3 litColor = texColor.rgb * vColor.rgb * ambientLight * bladeGradient;

          gl_FragColor = vec4(litColor, texColor.a);
        }
      `,
      side: DoubleSide,
    });
  }

  public update(ambientLightColor: Color, ambientLightIntensity: number): void {
    this.uniforms[UNIFORM_TIME].value += 0.02;
    this.uniforms[UNIFORM_RAW_AMBIENT_LIGHT_COLOR].value.copy(ambientLightColor);
    this.uniforms[UNIFORM_AMBIENT_LIGHT_INTENSITY].value = ambientLightIntensity;
  }
}

export default class BlockMaterialManager {
  private _game: Game;

  private _foliageMaterial: MeshFoliageMaterial;
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
    this._foliageMaterial = new MeshFoliageMaterial();
    this._liquidMaterial = new MeshLiquidMaterial();

    EventRouter.instance.on(
      BlockTextureAtlasEventType.Ready,
      () => {
        const textureAtlas = this._game.blockTextureAtlasManager.texture;
        this._opaqueMaterial.map = textureAtlas;
        this._transparentMaterial.map = textureAtlas;
        this._opaqueNonLitMaterial.map = textureAtlas;
        this._transparentNonLitMaterial.map = textureAtlas;
        this._foliageMaterial.uniforms[UNIFORM_TEXTURE_ATLAS].value = textureAtlas;
        this._liquidMaterial.uniforms[UNIFORM_TEXTURE_ATLAS].value = textureAtlas;

        // It seems that when map changes from null to non-null, it still requires an
        // explicit material.needsUpdate = true call to reflect the change.
        this._opaqueMaterial.needsUpdate = true;
        this._transparentMaterial.needsUpdate = true;
        this._opaqueNonLitMaterial.needsUpdate = true;
        this._transparentNonLitMaterial.needsUpdate = true;
        this._foliageMaterial.needsUpdate = true;
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
  public get foliageMaterial(): MeshFoliageMaterial { return this._foliageMaterial; }
  public get liquidMaterial(): MeshLiquidMaterial { return this._liquidMaterial; }

  public setLiquidReflection(reflectionTexture: Texture | null, reflectionTextureMatrix: Matrix4, enabled: boolean): void {
    this._liquidMaterial.setReflection(reflectionTexture, reflectionTextureMatrix, enabled);
  }

  public update(): void {
    // Block materials (MeshBlockMaterial) directly reference ambientLight via getters.
    // Shader-based materials update their animation state and lighting uniforms here.
    const ambientLight = this._game.renderer.ambientLight;
    const fogReflectionColor = this._game.renderer.fogColor;
    const skyReflectionColor = this._game.renderer.skyColor;
    const sunDirection = this._game.renderer.sunDirection;
    const sunColor = this._game.renderer.sunLightColor;
    const sunIntensity = this._game.renderer.sunLightIntensity;
    const interactionSource = this._game.camera.gameCameraAttachedEntity?.position ?? this._game.camera.activeCamera.position;
    this._foliageMaterial.uniforms[UNIFORM_INTERACTION_CENTER].value.set(
      interactionSource.x,
      interactionSource.y,
      interactionSource.z,
    );
    this._foliageMaterial.update(ambientLight.color, ambientLight.intensity);
    this._liquidMaterial.update(
      ambientLight.color,
      ambientLight.intensity,
      fogReflectionColor,
      skyReflectionColor,
      sunDirection,
      sunColor,
      sunIntensity,
    );
  }

  public cloneNonLitMaterial(transparent: boolean): MeshBlockMaterial {
    const clonedMaterial = (transparent ? this._transparentNonLitMaterial : this._opaqueNonLitMaterial).clone();

    // If the texture is not ready yet, it must be set once it becomes available.
    // If we could create the BlockTextureAtlas texture instance synchronously,
    // we could remove this complexity...
    if (clonedMaterial.map === null) {
      this._materialsToUpdate.push(clonedMaterial);
    }

    return clonedMaterial;
  }

  public cloneTransparentNonLitMaterial(): MeshBlockMaterial {
    return this.cloneNonLitMaterial(true);
  }

  public isSharedNonLitMaterial(material: unknown): boolean {
    return material === this._opaqueNonLitMaterial || material === this._transparentNonLitMaterial;
  }
}
