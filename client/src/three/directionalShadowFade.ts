const DIRECTIONAL_SHADOW_SETUP = 'directionalLightShadow = directionalLightShadows[ i ];';
const DIRECTIONAL_SHADOW_APPLY = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';

export function applyDirectionalShadowEdgeFade(fragmentShader: string): string {
  if (
    fragmentShader.includes('directionalShadowEdgeFade')
    || !fragmentShader.includes(DIRECTIONAL_SHADOW_SETUP)
    || !fragmentShader.includes(DIRECTIONAL_SHADOW_APPLY)
  ) {
    return fragmentShader;
  }

  return fragmentShader
    .replace(
      DIRECTIONAL_SHADOW_SETUP,
      `${DIRECTIONAL_SHADOW_SETUP}
		float directionalShadowSample = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		vec3 directionalShadowCoord = vDirectionalShadowCoord[ i ].xyz / max( vDirectionalShadowCoord[ i ].w, 0.0001 );
		float directionalShadowEdge = max( abs( directionalShadowCoord.x * 2.0 - 1.0 ), abs( directionalShadowCoord.y * 2.0 - 1.0 ) );
		float directionalShadowEdgeFade = smoothstep( 0.72, 1.0, directionalShadowEdge );`,
    )
    .replace(
      DIRECTIONAL_SHADOW_APPLY,
      'directLight.color *= mix( directionalShadowSample, 1.0, directionalShadowEdgeFade );',
    );
}
