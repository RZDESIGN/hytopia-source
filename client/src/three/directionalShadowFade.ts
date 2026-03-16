const DIRECTIONAL_LIGHT_SECTION = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const DIRECTIONAL_LIGHT_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';
const DIRECTIONAL_SHADOW_SETUP = 'directionalLightShadow = directionalLightShadows[ i ];';
const DIRECTIONAL_SHADOW_APPLY = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
const DIRECTIONAL_RE_DIRECT = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

export function applyDirectionalShadowEdgeFade(fragmentShader: string): string {
  if (
    fragmentShader.includes('directionalShadowEdgeFade')
    || !fragmentShader.includes(DIRECTIONAL_LIGHT_INFO)
    || !fragmentShader.includes(DIRECTIONAL_SHADOW_SETUP)
    || !fragmentShader.includes(DIRECTIONAL_SHADOW_APPLY)
    || !fragmentShader.includes(DIRECTIONAL_RE_DIRECT)
  ) {
    return fragmentShader;
  }

  return fragmentShader
    .replace(
      DIRECTIONAL_LIGHT_SECTION,
      `${DIRECTIONAL_LIGHT_SECTION}

		float getDirectionalShadowEdgeFadeAmount( vec4 shadowCoord ) {
			vec3 directionalShadowCoord = shadowCoord.xyz / max( shadowCoord.w, 0.0001 );
			float directionalShadowEdge = max( abs( directionalShadowCoord.x * 2.0 - 1.0 ), abs( directionalShadowCoord.y * 2.0 - 1.0 ) );
			return smoothstep( 0.72, 1.0, directionalShadowEdge );
		}

		float getDirectionalCascadeBlendAmount( vec4 shadowCoord ) {
			vec3 directionalShadowCoord = shadowCoord.xyz / max( shadowCoord.w, 0.0001 );
			float directionalCascadeEdge = max( abs( directionalShadowCoord.x * 2.0 - 1.0 ), abs( directionalShadowCoord.y * 2.0 - 1.0 ) );
			return smoothstep( 0.58, 0.92, directionalCascadeEdge );
		}`,
    )
    .replace(
      DIRECTIONAL_SHADOW_SETUP,
      `${DIRECTIONAL_SHADOW_SETUP}
		float directionalShadowSample = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		float directionalShadowEdgeFade = getDirectionalShadowEdgeFadeAmount( vDirectionalShadowCoord[ i ] );`,
    )
    .replace(
      DIRECTIONAL_SHADOW_APPLY,
      `#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS >= 2 ) && ( NUM_DIR_LIGHTS == NUM_DIR_LIGHT_SHADOWS )
		float directionalCascadeBlend = getDirectionalCascadeBlendAmount( vDirectionalShadowCoord[ 0 ] );
		#if ( UNROLLED_LOOP_INDEX == 0 )
			directLight.color *= mix( directionalShadowSample, 1.0, directionalShadowEdgeFade ) * ( 1.0 - directionalCascadeBlend );
		#elif ( UNROLLED_LOOP_INDEX == 1 )
			directLight.color *= mix( directionalShadowSample, 1.0, directionalShadowEdgeFade ) * directionalCascadeBlend;
		#else
			directLight.color *= mix( directionalShadowSample, 1.0, directionalShadowEdgeFade );
		#endif
	#else
		directLight.color *= mix( directionalShadowSample, 1.0, directionalShadowEdgeFade );
	#endif`,
    )
    .replace(
      DIRECTIONAL_LIGHT_INFO,
      `${DIRECTIONAL_LIGHT_INFO}
		#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS >= 2 ) && ( NUM_DIR_LIGHTS > NUM_DIR_LIGHT_SHADOWS )
			#if ( UNROLLED_LOOP_INDEX == NUM_DIR_LIGHT_SHADOWS )
				float directionalCascadeNear = getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] );
				directionalCascadeNear = mix( directionalCascadeNear, 1.0, getDirectionalShadowEdgeFadeAmount( vDirectionalShadowCoord[ 0 ] ) );
				float directionalCascadeFar = getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] );
				directionalCascadeFar = mix( directionalCascadeFar, 1.0, getDirectionalShadowEdgeFadeAmount( vDirectionalShadowCoord[ 1 ] ) );
				vec3 directionalCascadeCoord = vDirectionalShadowCoord[ 0 ].xyz / max( vDirectionalShadowCoord[ 0 ].w, 0.0001 );
				float directionalCascadeBlend = smoothstep( 0.58, 0.92, max( abs( directionalCascadeCoord.x * 2.0 - 1.0 ), abs( directionalCascadeCoord.y * 2.0 - 1.0 ) ) );
				directLight.color *= mix( directionalCascadeNear, directionalCascadeFar, directionalCascadeBlend );
			#endif
		#endif`,
    );
}
