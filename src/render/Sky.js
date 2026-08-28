import * as THREE from 'three';

/**
 * Painterly anime sky: a vertical gradient with an atmospheric horizon band,
 * two layers of fbm cumulus lit from the sun direction, a soft sun disc and a
 * god-ray-ish radial bloom feeder. Rendered on an inverted sphere with
 * depth writes off so it never fights geometry.
 */
const skyVertex = /* glsl */ `
varying vec3 vWorldDir;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorldDir = normalize( world.xyz - cameraPosition );
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const skyFragment = /* glsl */ `
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uCloudLight;
uniform vec3  uCloudShadow;
uniform float uCloudCover;
uniform float uCloudSharpness;
uniform float uTime;
uniform float uHazeStrength;

varying vec3 vWorldDir;

vec3 hash3( vec3 p ) {
  p = vec3( dot( p, vec3( 127.1, 311.7, 74.7 ) ),
            dot( p, vec3( 269.5, 183.3, 246.1 ) ),
            dot( p, vec3( 113.5, 271.9, 124.6 ) ) );
  return -1.0 + 2.0 * fract( sin( p ) * 43758.5453123 );
}

float gnoise( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  vec3 u = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( dot( hash3( i + vec3(0,0,0) ), f - vec3(0,0,0) ),
              dot( hash3( i + vec3(1,0,0) ), f - vec3(1,0,0) ), u.x ),
         mix( dot( hash3( i + vec3(0,1,0) ), f - vec3(0,1,0) ),
              dot( hash3( i + vec3(1,1,0) ), f - vec3(1,1,0) ), u.x ), u.y ),
    mix( mix( dot( hash3( i + vec3(0,0,1) ), f - vec3(0,0,1) ),
              dot( hash3( i + vec3(1,0,1) ), f - vec3(1,0,1) ), u.x ),
         mix( dot( hash3( i + vec3(0,1,1) ), f - vec3(0,1,1) ),
              dot( hash3( i + vec3(1,1,1) ), f - vec3(1,1,1) ), u.x ), u.y ), u.z );
}

float fbm( vec3 p ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 5; i++ ) {
    v += a * gnoise( p );
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 dir = normalize( vWorldDir );
  float h = dir.y;

  // --- sky body -------------------------------------------------------
  float t = clamp( h * 1.15 + 0.05, 0.0, 1.0 );
  vec3 sky = mix( uHorizon, uZenith, pow( t, 0.72 ) );
  sky = mix( uGround, sky, smoothstep( -0.09, 0.015, h ) );

  // Atmospheric haze thickening toward the horizon.
  sky = mix( sky, uHorizon * 1.06, uHazeStrength * pow( 1.0 - clamp( h, 0.0, 1.0 ), 6.0 ) );

  // --- sun ------------------------------------------------------------
  float sunDot = max( dot( dir, normalize( uSunDir ) ), 0.0 );
  float disc = smoothstep( 0.9986, 0.99935, sunDot );
  float glow = pow( sunDot, 220.0 ) * 0.55 + pow( sunDot, 14.0 ) * 0.18 + pow( sunDot, 4.0 ) * 0.06;
  sky += uSunColor * ( disc * 6.0 + glow );

  // --- clouds ---------------------------------------------------------
  if ( h > -0.02 ) {
    // Project onto a virtual cloud plane so cumulus stretch correctly toward
    // the horizon instead of tiling like a dome texture. The height is clamped
    // harder than a true projection: near the horizon the unclamped term runs
    // to enormous values, the noise is sampled at a frequency far above what
    // the pixel grid can resolve, and the whole band averages out to a flat
    // wash — which is exactly what the sky used to look like.
    float planeH = 1.0 / max( h * 0.80 + 0.16, 0.10 );
    // Scale matters more than it looks: at 0.085 the whole visible sky mapped
    // to less than one noise period, so the entire dome resolved to a single
    // cloud mass and read as a flat cream wash. This gives roughly half a
    // dozen distinct cumulus across the sky.
    vec3 cp = vec3( dir.x * planeH, 0.0, dir.z * planeH ) * 0.95;
    cp.x += uTime * 0.010;
    cp.z += uTime * 0.004;

    // Two decks. The lower one carries the silhouette, the upper adds a
    // thinner veil so the sky is not one flat layer of blobs.
    float baseN = fbm( cp * 0.85 );
    float detail = fbm( cp * 2.6 + vec3( 11.3, 0.0, 4.1 ) );
    float shape = baseN * 0.72 + detail * 0.28;

    // Anime cumulus are bold flat masses with a firm edge, not a soft gradient,
    // so the coverage threshold is narrow.
    float cover = smoothstep( uCloudCover, uCloudCover + uCloudSharpness, shape );

    // Fake self-shadowing: resample offset toward the sun. The delta between
    // the two samples is what gives a cloud a lit crown and a shaded belly.
    vec3 sunOff = normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) ) * 0.55;
    float lit = fbm( ( cp + sunOff ) * 0.85 ) * 0.72;
    float density = clamp( ( shape - lit ) * 3.0 + 0.52, 0.0, 1.0 );

    vec3 cloudCol = mix( uCloudShadow, uCloudLight, smoothstep( 0.15, 0.85, density ) );
    // A warm rim where a cloud edge faces the sun.
    cloudCol += uSunColor * pow( sunDot, 16.0 ) * 0.26 * ( 1.0 - density );

    // A thin high veil, much fainter and moving faster.
    float veil = smoothstep( 0.10, 0.34, fbm( cp * 0.22 + vec3( 40.0, uTime * 0.004, 17.0 ) ) );
    sky = mix( sky, mix( sky, uCloudLight, 0.50 ), veil * smoothstep( 0.08, 0.34, h ) * 0.16 );

    float fade = smoothstep( -0.02, 0.09, h );
    sky = mix( sky, cloudCol, cover * fade * 0.96 );
  }

  gl_FragColor = vec4( sky, 1.0 );
  #include <colorspace_fragment>
}
`;

export const SKY_PRESETS = {
  /** Bright midday Kivotos — the default key-visual palette. */
  noon: {
    zenith: 0x1c6fd0,
    horizon: 0x9ed4f7,
    ground: 0x7d9ab4,
    sunColor: 0xfff4d6,
    cloudLight: 0xfdfeff,
    cloudShadow: 0x93add6,
    cloudCover: 0.055,
    cloudSharpness: 0.055,
    haze: 0.30,
  },
  /** Late-afternoon operation window: warmer, longer shadows. */
  afternoon: {
    zenith: 0x3d7fc4,
    horizon: 0xffd9b0,
    ground: 0xb09a92,
    sunColor: 0xffd9a0,
    cloudLight: 0xfff0e2,
    cloudShadow: 0xb49ab6,
    cloudCover: 0.085,
    cloudSharpness: 0.06,
    haze: 0.72,
  },
  /** Overcast siege weather. */
  overcast: {
    zenith: 0x6d86a6,
    horizon: 0xc3ccd8,
    ground: 0x8c93a0,
    sunColor: 0xe8eef6,
    cloudLight: 0xdfe6f0,
    cloudShadow: 0x8a93a8,
    cloudCover: -0.04,
    cloudSharpness: 0.09,
    haze: 0.85,
  },
};

export class Sky {
  constructor( preset = 'noon' ) {
    const p = SKY_PRESETS[ preset ] ?? SKY_PRESETS.noon;

    this.material = new THREE.ShaderMaterial( {
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color( p.zenith ) },
        uHorizon: { value: new THREE.Color( p.horizon ) },
        uGround: { value: new THREE.Color( p.ground ) },
        uSunDir: { value: new THREE.Vector3( 0.42, 0.62, 0.66 ).normalize() },
        uSunColor: { value: new THREE.Color( p.sunColor ) },
        uCloudLight: { value: new THREE.Color( p.cloudLight ) },
        uCloudShadow: { value: new THREE.Color( p.cloudShadow ) },
        uCloudCover: { value: p.cloudCover },
        uCloudSharpness: { value: p.cloudSharpness },
        uHazeStrength: { value: p.haze },
        uTime: { value: 0 },
      },
    } );

    this.mesh = new THREE.Mesh( new THREE.SphereGeometry( 300, 48, 32 ), this.material );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'Sky';
  }

  setSunDirection( v ) {
    this.material.uniforms.uSunDir.value.copy( v ).normalize();
  }

  update( dt, elapsed ) {
    this.material.uniforms.uTime.value = elapsed;
  }
}
