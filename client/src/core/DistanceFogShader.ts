import {
  Vector3,
  WebGLProgramParametersWithUniforms,
} from 'three';
import type Game from '../Game';

export const DISTANCE_FOG_WORLD_POSITION_VARYING = 'vDistanceFogWorldPosition';
export const UNIFORM_DISTANCE_VISIBILITY_ANCHOR = 'distanceVisibilityAnchor';
export const UNIFORM_HAS_DISTANCE_VISIBILITY_ANCHOR = 'hasDistanceVisibilityAnchor';

type DistanceFogUniformValue = number | Vector3;
type DistanceFogUniforms = Record<string, { value: DistanceFogUniformValue }>;

export const createDistanceFogUniforms = (game: Game): DistanceFogUniforms => ({
  [UNIFORM_DISTANCE_VISIBILITY_ANCHOR]: {
    get value(): Vector3 {
      return game.camera.distanceVisibilityAnchor ?? game.camera.activeCamera.position;
    },
  },
  [UNIFORM_HAS_DISTANCE_VISIBILITY_ANCHOR]: {
    get value(): number {
      return game.camera.distanceVisibilityAnchor ? 1 : 0;
    },
  },
});

export const DISTANCE_FOG_VERTEX_DECLARATION = `varying vec3 ${DISTANCE_FOG_WORLD_POSITION_VARYING};`;

export const DISTANCE_FOG_FRAGMENT_DECLARATION = `
uniform vec3 ${UNIFORM_DISTANCE_VISIBILITY_ANCHOR};
uniform float ${UNIFORM_HAS_DISTANCE_VISIBILITY_ANCHOR};
varying vec3 ${DISTANCE_FOG_WORLD_POSITION_VARYING};
`;

export const DISTANCE_FOG_FRAGMENT = `
#ifdef USE_FOG
  vec2 distanceFogClosestPoint = cameraPosition.xz;
  if (${UNIFORM_HAS_DISTANCE_VISIBILITY_ANCHOR} > 0.5) {
    vec2 distanceFogSegment = ${UNIFORM_DISTANCE_VISIBILITY_ANCHOR}.xz - cameraPosition.xz;
    float distanceFogSegmentLengthSquared = dot(distanceFogSegment, distanceFogSegment);
    if (distanceFogSegmentLengthSquared > 0.000001) {
      float distanceFogSegmentT = clamp(
        dot(${DISTANCE_FOG_WORLD_POSITION_VARYING}.xz - cameraPosition.xz, distanceFogSegment) / distanceFogSegmentLengthSquared,
        0.0,
        1.0
      );
      distanceFogClosestPoint = cameraPosition.xz + distanceFogSegment * distanceFogSegmentT;
    }
  }

  float distanceFogDepth = length(${DISTANCE_FOG_WORLD_POSITION_VARYING}.xz - distanceFogClosestPoint);
  float fogFactor = smoothstep(fogNear, fogFar, distanceFogDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
#endif
`;

export const applyDistanceFogToFragmentShader = (fragmentShader: string): string => {
  return fragmentShader
    .replace(
      '#include <fog_pars_fragment>',
      `
        #include <fog_pars_fragment>
        ${DISTANCE_FOG_FRAGMENT_DECLARATION}
      `,
    )
    .replace('#include <fog_fragment>', DISTANCE_FOG_FRAGMENT);
};

export const applyDistanceFogToStandardShader = (
  params: WebGLProgramParametersWithUniforms,
  game: Game,
  worldPositionExpression: string = '(modelMatrix * vec4(transformed, 1.0)).xyz',
): void => {
  Object.assign(params.uniforms, createDistanceFogUniforms(game));

  params.vertexShader = params.vertexShader
    .replace(
      '#include <fog_pars_vertex>',
      `
        #include <fog_pars_vertex>
        ${DISTANCE_FOG_VERTEX_DECLARATION}
      `,
    )
    .replace(
      '#include <fog_vertex>',
      `
        #include <fog_vertex>
        ${DISTANCE_FOG_WORLD_POSITION_VARYING} = ${worldPositionExpression};
      `,
    );

  params.fragmentShader = applyDistanceFogToFragmentShader(params.fragmentShader);
};
