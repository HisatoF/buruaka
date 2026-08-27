import * as THREE from 'three';

/**
 * KivotosToonMaterial
 * -------------------
 * Three-tone cel shader tuned for the "anime key-visual" look: hue-shifted
 * shadows instead of flat darkening, a hard-edged specular band for hair and
 * plastic, and a fresnel rim that only fires along the silhouette.
 *
 * Built as a raw ShaderMaterial (lights: true) so it still inherits three's
 * skinning, shadow-map and fog plumbing.
 */

const vertexShader = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <fog_pars_vertex>

varying vec3 vNormalView;
varying vec3 vNormalWorld;
varying vec3 vViewPosition;
varying vec2 vUv;
varying vec3 vObjPos;

#ifdef USE_VERTEX_TINT
  attribute vec3 tint;
  varying vec3 vTint;
#endif

void main() {
  vUv = uv;
  #ifdef USE_VERTEX_TINT
    vTint = tint;
  #endif

  #include <beginnormal_vertex>
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>

  vNormalView = normalize( transformedNormal );
  vNormalWorld = normalize( mat3( modelMatrix ) * objectNormal );

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>

  vViewPosition = -mvPosition.xyz;
  vObjPos = transformed;

  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>

uniform vec3  uColor;
uniform sampler2D uMap;
uniform float uHasMap;
uniform sampler2D uNormalMap;
uniform float uHasNormalMap;
uniform float uNormalScale;
uniform vec2  uUvScale;
uniform vec2  uUvOffset;
uniform float uAlphaTest;
uniform float uOpacity;

// --- ramp -------------------------------------------------------------
uniform vec3  uShadowTint;      // multiplied into base for the core shadow
uniform vec3  uMidTint;         // multiplied into base for the mid band
uniform float uShadowStep;
uniform float uShadowSoft;
uniform float uMidStep;
uniform float uMidSoft;
uniform float uMidWeight;
uniform float uFlatten;         // 1.0 = ignore the ramp entirely (face / eyes)
uniform float uShadowStrength;  // how much the cast shadow map darkens
uniform float uShadowFloor;     // hard lower bound on the ramp multiplier

// --- rim --------------------------------------------------------------
uniform vec3  uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uRimBias;
uniform float uRimBacklight;    // 0 = rim on the lit side, 1 = opposite the key

// --- specular ---------------------------------------------------------
uniform vec3  uSpecColor;
uniform float uSpecGloss;
uniform float uSpecStrength;
uniform float uSpecStep;
uniform float uSpecSoft;
uniform float uSpecBand;        // 1 = band over UV.y, 2 = band over object-space Y
uniform float uSpecBandPos;
uniform float uSpecBandWidth;
uniform float uSpecBandRepeat;  // secondary band offset, for the classic double highlight

// --- ambient / emissive ----------------------------------------------
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform float uAmbient;
uniform vec3  uEmissive;
uniform float uEmissiveIntensity;

varying vec3 vNormalView;
varying vec3 vNormalWorld;
varying vec3 vViewPosition;
varying vec2 vUv;
varying vec3 vObjPos;

#ifdef USE_VERTEX_TINT
  varying vec3 vTint;
#endif

float bandStep( float x, float edge, float soft ) {
  return smoothstep( edge - soft, edge + soft, x );
}

/**
 * Cotangent frame from screen-space derivatives (Mikkelsen).
 *
 * Deriving the tangent basis in the fragment shader avoids having to generate
 * and store tangent attributes for every piece of level geometry, which for a
 * world built procedurally at load time would mean an extra pass over every
 * mesh for a basis that is only needed on the handful of surfaces that carry
 * a normal map.
 */
mat3 cotangentFrame( vec3 N, vec3 p, vec2 uv ) {
  vec3 dp1 = dFdx( p );
  vec3 dp2 = dFdy( p );
  vec2 duv1 = dFdx( uv );
  vec2 duv2 = dFdy( uv );

  vec3 dp2perp = cross( dp2, N );
  vec3 dp1perp = cross( N, dp1 );
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;

  float invmax = inversesqrt( max( dot( T, T ), dot( B, B ) ) );
  return mat3( T * invmax, B * invmax, N );
}

void main() {
  vec2 uv = vUv * uUvScale + uUvOffset;

  vec4 texel = vec4( 1.0 );
  if ( uHasMap > 0.5 ) texel = texture2D( uMap, uv );
  vec3 base = uColor * texel.rgb;
  #ifdef USE_VERTEX_TINT
    base *= vTint;
  #endif
  float alpha = uOpacity * texel.a;
  if ( alpha < uAlphaTest ) discard;

  vec3 N = normalize( vNormalView );
  if ( !gl_FrontFacing ) N = -N;
  vec3 V = normalize( vViewPosition );
  vec3 Nw = normalize( vNormalWorld );

  if ( uHasNormalMap > 0.5 ) {
    vec3 mapN = texture2D( uNormalMap, uv ).xyz * 2.0 - 1.0;
    mapN.xy *= uNormalScale;
    N = normalize( cotangentFrame( N, -vViewPosition, uv ) * mapN );
  }

  // ---- key light -----------------------------------------------------
  vec3 L = vec3( 0.0, 0.0, 1.0 );
  vec3 lightColor = vec3( 1.0 );
  #if NUM_DIR_LIGHTS > 0
    L = normalize( directionalLights[ 0 ].direction );
    lightColor = directionalLights[ 0 ].color;
  #endif

  float shadowMask = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow dls = directionalLightShadows[ 0 ];
    shadowMask = getShadow(
      directionalShadowMap[ 0 ], dls.shadowMapSize, dls.shadowIntensity,
      dls.shadowBias, dls.shadowRadius, vDirectionalShadowCoord[ 0 ]
    );
  #endif
  shadowMask = mix( 1.0, shadowMask, uShadowStrength );

  float ndl = dot( N, L );
  float halfLambert = ndl * 0.5 + 0.5;
  float lit = min( halfLambert, mix( 1.0, shadowMask, 0.85 ) );

  // Three-tone ramp: core shadow -> mid -> full light.
  float b1 = bandStep( lit, uShadowStep, uShadowSoft );
  float b2 = bandStep( lit, uMidStep, uMidSoft );
  float ramp = mix( b1 * uMidWeight + b2 * ( 1.0 - uMidWeight ), 1.0, uFlatten );

  // The ramp resolves to a *multiplier* on the base colour rather than three
  // independent colours. Keeping it multiplicative is what stops the lit band
  // from clipping to white the moment ambient is added, and it means an artist
  // can retint shadows without re-balancing exposure.
  vec3 lightMul = mix( uShadowTint, uMidTint, clamp( ramp * 2.0, 0.0, 1.0 ) );
  lightMul = mix( lightMul, vec3( 1.0 ), clamp( ramp * 2.0 - 1.0, 0.0, 1.0 ) );

  // A floor on the multiplier. Outward- and downward-facing cloth — a skirt
  // panel, a sock, a sleeve underside — sits permanently in the core shadow
  // band, and on an already-dark navy that lands close enough to the outline
  // colour that the garment stops reading as a garment. Anime art keeps its
  // darks well above black; this is where that gets enforced.
  lightMul = max( lightMul, vec3( uShadowFloor ) );

  vec3 diffuse = base * lightMul * lightColor;

  // ---- hemispheric fill ---------------------------------------------
  // Weighted toward the shadow side only: a uniform ambient add would lift the
  // lit band past 1.0 and flatten the whole ramp back out.
  vec3 ambient = mix( uGroundColor, uSkyColor, Nw.y * 0.5 + 0.5 ) * uAmbient;
  diffuse += base * ambient * ( 1.0 - ramp * 0.72 );

  // ---- anime specular band ------------------------------------------
  vec3 H = normalize( L + V );
  float ndh = max( dot( N, H ), 0.0 );
  float spec = pow( ndh, uSpecGloss );
  spec = bandStep( spec, uSpecStep, uSpecSoft );
  if ( uSpecBand > 0.5 ) {
    // Anime hair carries a hard highlight band that reads as a ring around
    // the head. Driving it from skinned object-space Y (mode 2) keeps it at a
    // fixed height on the hair regardless of how each strand is unwrapped;
    // driving it from UV.y (mode 1) suits cylindrical parts like sleeves.
    float coord = uSpecBand > 1.5 ? vObjPos.y : uv.y;
    float band = 1.0 - smoothstep( 0.0, uSpecBandWidth, abs( coord - uSpecBandPos ) );
    if ( uSpecBandRepeat > 0.0 ) {
      band = max( band, ( 1.0 - smoothstep( 0.0, uSpecBandWidth * 0.6, abs( coord - uSpecBandPos + uSpecBandRepeat ) ) ) * 0.55 );
    }
    spec *= band;
  }
  spec *= step( 0.0, ndl ) * shadowMask;
  vec3 specular = uSpecColor * spec * uSpecStrength;

  // ---- rim -----------------------------------------------------------
  float fres = pow( clamp( 1.0 - dot( N, V ), 0.0, 1.0 ), uRimPower );
  float rimMask = smoothstep( uRimBias, uRimBias + 0.25, fres );
  float side = mix( clamp( ndl * 1.4 + 0.15, 0.0, 1.0 ),
                    clamp( -ndl * 1.4 + 0.35, 0.0, 1.0 ), uRimBacklight );
  vec3 rim = uRimColor * rimMask * side * uRimStrength;

  vec3 outgoing = diffuse + specular + rim + uEmissive * uEmissiveIntensity;

  gl_FragColor = vec4( outgoing, alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export const TOON_DEFAULTS = {
  color: 0xffffff,
  map: null,
  normalMap: null,
  normalScale: 1,
  uvScale: [ 1, 1 ],
  uvOffset: [ 0, 0 ],
  opacity: 1,
  alphaTest: 0,
  shadowTint: 0x9c94c4,
  midTint: 0xcac3e4,
  shadowStep: 0.48,
  shadowSoft: 0.035,
  midStep: 0.66,
  midSoft: 0.06,
  midWeight: 0.55,
  flatten: 0,
  shadowStrength: 1,
  shadowFloor: 0,
  rimColor: 0xbfe8ff,
  rimPower: 3.2,
  rimStrength: 0.24,
  rimBias: 0.25,
  rimBacklight: 0.35,
  specColor: 0xffffff,
  specGloss: 44,
  specStrength: 0.12,
  specStep: 0.42,
  specSoft: 0.12,
  specBand: 0,
  specBandPos: 0.72,
  specBandWidth: 0.09,
  specBandRepeat: 0,
  skyColor: 0xbcd8ff,
  groundColor: 0xa79ec0,
  ambient: 0.42,
  emissive: 0x000000,
  emissiveIntensity: 1,
};

export function createToonMaterial( options = {} ) {
  const o = { ...TOON_DEFAULTS, ...options };
  const c = ( v ) => new THREE.Color( v );

  // Ramp tints are *multipliers*, not colours to be looked at, so they must
  // not be gamma-decoded. Passing 0x999999 through the usual sRGB conversion
  // yields 0.33 rather than 0.6, which crushes every saturated dark to black —
  // a navy skirt ends up indistinguishable from the outline around it.
  const mul = ( v ) => new THREE.Color().setHex( v, THREE.LinearSRGBColorSpace );

  const material = new THREE.ShaderMaterial( {
    lights: true,
    fog: true,
    transparent: o.opacity < 1 || !!options.transparent,
    side: options.side ?? THREE.FrontSide,
    depthWrite: options.depthWrite ?? true,
    defines: options.vertexTint ? { USE_VERTEX_TINT: '' } : {},
    vertexShader,
    fragmentShader,
    uniforms: THREE.UniformsUtils.merge( [
      THREE.UniformsLib.lights,
      THREE.UniformsLib.fog,
      {
        uColor: { value: c( o.color ) },
        uMap: { value: null },
        uHasMap: { value: 0 },
        uNormalMap: { value: null },
        uHasNormalMap: { value: 0 },
        uNormalScale: { value: o.normalScale },
        uUvScale: { value: new THREE.Vector2( o.uvScale[ 0 ], o.uvScale[ 1 ] ) },
        uUvOffset: { value: new THREE.Vector2( o.uvOffset[ 0 ], o.uvOffset[ 1 ] ) },
        uAlphaTest: { value: o.alphaTest },
        uOpacity: { value: o.opacity },
        uShadowTint: { value: mul( o.shadowTint ) },
        uMidTint: { value: mul( o.midTint ) },
        uShadowStep: { value: o.shadowStep },
        uShadowSoft: { value: o.shadowSoft },
        uMidStep: { value: o.midStep },
        uMidSoft: { value: o.midSoft },
        uMidWeight: { value: o.midWeight },
        uFlatten: { value: o.flatten },
        uShadowStrength: { value: o.shadowStrength },
        uShadowFloor: { value: o.shadowFloor },
        uRimColor: { value: c( o.rimColor ) },
        uRimPower: { value: o.rimPower },
        uRimStrength: { value: o.rimStrength },
        uRimBias: { value: o.rimBias },
        uRimBacklight: { value: o.rimBacklight },
        uSpecColor: { value: c( o.specColor ) },
        uSpecGloss: { value: o.specGloss },
        uSpecStrength: { value: o.specStrength },
        uSpecStep: { value: o.specStep },
        uSpecSoft: { value: o.specSoft },
        uSpecBand: { value: o.specBand },
        uSpecBandPos: { value: o.specBandPos },
        uSpecBandWidth: { value: o.specBandWidth },
        uSpecBandRepeat: { value: o.specBandRepeat },
        uSkyColor: { value: c( o.skyColor ) },
        uGroundColor: { value: c( o.groundColor ) },
        uAmbient: { value: o.ambient },
        uEmissive: { value: c( o.emissive ) },
        uEmissiveIntensity: { value: o.emissiveIntensity },
      },
    ] ),
  } );

  // UniformsUtils.merge clones values, so textures are assigned afterwards.
  if ( o.map ) {
    material.uniforms.uMap.value = o.map;
    material.uniforms.uHasMap.value = 1;
  }
  if ( o.normalMap ) {
    material.uniforms.uNormalMap.value = o.normalMap;
    material.uniforms.uHasNormalMap.value = 1;
  }
  // UniformsUtils.merge clones Vector2s too, so restore the requested values.
  material.uniforms.uUvScale.value.set( o.uvScale[ 0 ], o.uvScale[ 1 ] );
  material.uniforms.uUvOffset.value.set( o.uvOffset[ 0 ], o.uvOffset[ 1 ] );

  material.userData.isKivotosToon = true;

  // Convenience accessors so gameplay code can tint without touching uniforms.
  Object.defineProperty( material, 'color', {
    get() { return this.uniforms.uColor.value; },
    set( v ) { this.uniforms.uColor.value.set( v ); },
  } );
  Object.defineProperty( material, 'emissiveColor', {
    get() { return this.uniforms.uEmissive.value; },
    set( v ) { this.uniforms.uEmissive.value.set( v ); },
  } );

  return material;
}

/* ---------------------------------------------------------------------- */
/* Inverted-hull outline                                                   */
/* ---------------------------------------------------------------------- */

const outlineVertex = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>

uniform float uThickness;
uniform float uMinPixels;
uniform vec2  uResolution;

attribute vec3 aSmoothNormal;
attribute float aOutlineMask;

#ifdef USE_VERTEX_TINT
  attribute vec3 tint;
  varying vec3 vTint;
#endif

void main() {
  // Geometry hidden under clothing still grows a hull, and a constant-pixel
  // outline is a large world-space offset up close — so a leg's stroke punches
  // through the sock covering it and mottles the garment. Marked vertices are
  // pushed outside the clip volume so their triangles are dropped entirely.
  if ( aOutlineMask < 0.5 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }
  #ifdef USE_VERTEX_TINT
    vTint = tint;
  #endif
  vec3 smoothN = aSmoothNormal;
  if ( length( smoothN ) < 0.001 ) smoothN = normal;

  vec3 objectNormal = normalize( smoothN );
  #include <morphinstance_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>

  #include <begin_vertex>
  #include <skinning_vertex>

  vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
  vec4 clip = projectionMatrix * mvPosition;

  // Expand along the view-space normal, converted to a clip-space offset so
  // the outline holds a near-constant pixel width at any distance.
  //
  // NOT transformedNormal. This material is BackSide, and three sets
  // flipSided from exactly that, which defines FLIP_SIDED, which makes
  // <defaultnormal_vertex> negate transformedNormal. Using it here expanded
  // the hull *inward* — so the game rendered with no outlines at all, while
  // the collapsed hull z-fought its way through thin geometry and produced
  // stripes on hair and sawtooth speckle along every hem and cuff.
  // objectNormal is already skinned by <skinnormal_vertex> and is not
  // touched by the flip, so transform it directly.
  vec3 nView = normalize( normalMatrix * objectNormal );
  vec4 clipN = projectionMatrix * vec4( mvPosition.xyz + nView, 1.0 );
  vec2 dir = clipN.xy / max( clipN.w, 1e-4 ) - clip.xy / max( clip.w, 1e-4 );
  dir = length( dir ) > 1e-6 ? normalize( dir ) : vec2( 0.0 );

  float px = max( uThickness * uResolution.y * 0.5, uMinPixels );
  clip.xy += dir * ( px / uResolution ) * clip.w * 2.0;

  gl_Position = clip;
}
`;

const outlineFragment = /* glsl */ `
uniform vec3 uOutlineColor;
uniform float uTintMix;

#ifdef USE_VERTEX_TINT
  varying vec3 vTint;
#endif

void main() {
  vec3 c = uOutlineColor;
  #ifdef USE_VERTEX_TINT
    // A pure black outline flattens a cel character. Blending the stroke
    // toward a deep, desaturated version of the surface underneath keeps
    // blonde hair from being fenced in by the same ink as a navy skirt.
    vec3 deep = mix( vTint * 0.34, uOutlineColor, 0.45 );
    c = mix( uOutlineColor, deep, uTintMix );
  #endif
  gl_FragColor = vec4( c, 1.0 );
  #include <colorspace_fragment>
}
`;

export function createOutlineMaterial( {
  color = 0x2b2138, thickness = 0.0068, minPixels = 2.6,
  vertexTint = false, tintMix = 0.42,
} = {} ) {
  return new THREE.ShaderMaterial( {
    defines: vertexTint ? { USE_VERTEX_TINT: '' } : {},
    vertexShader: outlineVertex,
    fragmentShader: outlineFragment,
    side: THREE.BackSide,
    uniforms: {
      uOutlineColor: { value: new THREE.Color( color ) },
      uTintMix: { value: tintMix },
      uThickness: { value: thickness },
      uMinPixels: { value: minPixels },
      uResolution: { value: new THREE.Vector2( 1920, 1080 ) },
    },
  } );
}

/**
 * Fills a `tint` attribute with one colour, converted to the renderer's
 * working colour space.
 *
 * This is what lets an entire character — skin, shirt, skirt, socks, shoes —
 * merge into a single geometry and render in one draw call while still
 * reading as separate materials. A per-part texture atlas would do the same
 * job but bleeds across cells under mipmapping; a vertex attribute cannot.
 */
/**
 * Excludes a geometry from the inverted-hull outline pass.
 *
 * Use on anything that is always covered by another layer — the torso beneath
 * a shirt, the leg beneath a sock. The covered surface still shades and still
 * fills the silhouette; it just stops contributing a stroke that has nowhere
 * to go but through the garment on top of it.
 */
export function suppressOutline( geometry ) {
  const count = geometry.attributes.position.count;
  geometry.setAttribute( 'aOutlineMask', new THREE.BufferAttribute( new Float32Array( count ), 1 ) );
  return geometry;
}

/** Marks a geometry as outlined. Needed so merges keep a consistent attribute set. */
export function allowOutline( geometry ) {
  const count = geometry.attributes.position.count;
  geometry.setAttribute( 'aOutlineMask', new THREE.BufferAttribute( new Float32Array( count ).fill( 1 ), 1 ) );
  return geometry;
}

export function paintGeometry( geometry, hexColor ) {
  const c = new THREE.Color( hexColor );
  const count = geometry.attributes.position.count;
  const arr = new Float32Array( count * 3 );
  for ( let i = 0; i < count; i++ ) {
    arr[ i * 3 ] = c.r;
    arr[ i * 3 + 1 ] = c.g;
    arr[ i * 3 + 2 ] = c.b;
  }
  geometry.setAttribute( 'tint', new THREE.BufferAttribute( arr, 3 ) );
  return geometry;
}

/**
 * Averages normals across coincident vertices and stores the result in an
 * `aSmoothNormal` attribute. Without this, inverted-hull outlines split open
 * at every hard edge (cube corners, cuffs, collar seams).
 */
export function computeSmoothNormals( geometry, epsilon = 1e-4 ) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  if ( !pos || !nrm ) return geometry;

  const count = pos.count;
  const buckets = new Map();
  const quant = 1 / epsilon;

  for ( let i = 0; i < count; i++ ) {
    const k = `${Math.round( pos.getX( i ) * quant )}|${Math.round( pos.getY( i ) * quant )}|${Math.round( pos.getZ( i ) * quant )}`;
    let b = buckets.get( k );
    if ( !b ) buckets.set( k, ( b = { x: 0, y: 0, z: 0, list: [] } ) );
    b.x += nrm.getX( i );
    b.y += nrm.getY( i );
    b.z += nrm.getZ( i );
    b.list.push( i );
  }

  const out = new Float32Array( count * 3 );
  for ( const b of buckets.values() ) {
    const len = Math.hypot( b.x, b.y, b.z ) || 1;
    const x = b.x / len, y = b.y / len, z = b.z / len;
    for ( const i of b.list ) {
      out[ i * 3 ] = x;
      out[ i * 3 + 1 ] = y;
      out[ i * 3 + 2 ] = z;
    }
  }
  geometry.setAttribute( 'aSmoothNormal', new THREE.BufferAttribute( out, 3 ) );
  return geometry;
}
