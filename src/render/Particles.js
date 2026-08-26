import * as THREE from 'three';

/**
 * Particles.js — the BURUAKA VFX system.
 * ======================================================================
 *
 * Art direction first: this is not a physically-plausible particle sim, it is
 * an anime effects rig. Everything is built from four ideas.
 *
 *   1. FLAT BOLD SHAPES. Sprites are shaped procedurally in the fragment
 *      shader — 4-point star flares, hard rings, tapered crosses, hex shards,
 *      cel-banded smoke puffs. No textures, no soft photoreal fireballs.
 *   2. SNAP. Most bursts are fully resolved in 0.25–0.6 s: a 2–3 frame attack,
 *      then a cubic ease-out. Linear fades read cheap, so nothing fades linearly.
 *   3. HDR. Additive layers are authored well above 1.0 in linear space so the
 *      UnrealBloom threshold (~0.94) actually catches them and they bloom.
 *   4. ONE DRAW CALL PER BLEND MODE. Two pooled `THREE.Points` objects (one
 *      additive, one alpha) back every preset. Particles live in preallocated
 *      Float32Arrays, are integrated on the CPU and uploaded as a single dirty
 *      range per frame. Nothing is allocated while the game is running.
 *
 * ----------------------------------------------------------------------
 * Quick start
 * ----------------------------------------------------------------------
 *   import { ParticleSystem } from './render/Particles.js';
 *
 *   const vfx = new ParticleSystem( scene, { capacity: 4000, quality: 2 } );
 *   engine.add( vfx );                       // update(dt) is called for us
 *
 *   vfx.emit( 'muzzleFlash', { position: muzzle, direction: aim } );
 *   vfx.emit( 'impactMetal', { position: hit,   direction: normal } );
 *   vfx.emit( 'explosion',   { position: p, scale: 1.4 } );
 *
 * `update( dt, camera )` also drives the non-particle helpers the system owns
 * (`vfx.rings`, `vfx.decals`, `vfx.damageFlash`, and any `vfx.createTrail()`),
 * so a single call per frame runs the whole VFX layer.
 */

/* ====================================================================== */
/* Palette                                                                */
/* ====================================================================== */

/**
 * The VFX palette. These are the only colours effects are allowed to use;
 * keeping the set small is what makes a screenful of overlapping effects still
 * read as one art style.
 */
export const VFX_COLORS = {
  white:      0xffffff,
  hotCore:    0xfffbe8,   // white-hot centre of any flash
  muzzle:     0xffd54a,   // warm gunfire
  muzzleDeep: 0xff8a3d,
  ember:      0xffb45a,
  emberDeep:  0xff4a1e,
  cyan:       0x7fd6ff,   // player / UI / shield
  cyanDeep:   0x35a3ea,
  halo:       0x9fe8ff,
  enemy:      0xff5d6c,   // enemy coral
  enemyDeep:  0xc8213a,
  damage:     0xb07dff,   // stylised "damage" violet — never blood red
  damageDeep: 0x5b8cff,
  heal:       0x4ce0a4,   // mint
  smoke:      0xd6d0e2,
  smokeDeep:  0x8b8398,
  concrete:   0xcfc9c2,
  concreteDeep: 0x9a9490,
  brass:      0xe0a83c,
  brassDark:  0x8c5f1d,
  rain:       0xbcd8ee,
};

/* ====================================================================== */
/* Sprite shapes                                                          */
/* ====================================================================== */

/**
 * Procedural sprite shapes, selected per particle by the `aShape` attribute
 * and evaluated from `gl_PointCoord`. No atlas, no texture fetch, no filtering
 * — every sprite is resolution-independent and stays crisp when a point sprite
 * fills half the screen.
 */
export const SHAPE = {
  DISC:  0,   // soft round blob with a hot core — the workhorse
  GLOW:  1,   // wide featureless halo, pure bloom food
  RING:  2,   // hard annulus, thickness from aParam
  STAR4: 3,   // anime 4-point flare, spike sharpness from aParam
  SPARK: 4,   // stretched capsule streak, aspect from aStretch, aimed by velocity
  SMOKE: 5,   // lumpy cel-banded puff, lumps from aSeed
  HEX:   6,   // flat hexagon with a bright rim — shields, runes
  CROSS: 7,   // crisp tapered plus — the hit flash
  SHARD: 8,   // angular chip with a lit top edge — debris, shell casings
  RUNE:  9,   // hollow diamond outline with a centre dot
};

/* ====================================================================== */
/* Point shaders                                                          */
/* ====================================================================== */

const particleVertex = /* glsl */ `
precision highp float;

uniform float uProjScale;   // 0.5 * viewportHeightPx * projectionMatrix[1][1]
uniform float uSizeScale;   // global size multiplier (quality / art tuning)
uniform float uMaxPoint;    // hardware point-size clamp
uniform float uFadeNear;    // camera-proximity fade-out distance
uniform float uDepthBias;   // pulls big sprites toward the camera (see below)

attribute vec3  aVel;
attribute vec3  aColor;
attribute float aSize;
attribute float aRot;
attribute float aOpacity;
attribute float aShape;
attribute float aStretch;
attribute float aParam;
attribute float aSeed;

varying vec3  vColor;
varying float vOpacity;
varying float vShape;
varying float vStretch;
varying float vParam;
varying float vSeed;
varying vec2  vRot;         // (cos, sin) of the sprite rotation
varying float vViewDepth;

void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );

  float dist = max( -mv.z, 0.02 );
  vViewDepth = dist;

  // Perspective attenuation, then a hard clamp so a particle spawned inside
  // the near plane can never rasterise a screen-sized quad and tank fill rate.
  float px = aSize * uSizeScale * uProjScale / dist;
  gl_PointSize = clamp( px, 0.9, uMaxPoint );

  // A point sprite is a flat screen-facing quad at ONE depth, so a 4 m flash
  // standing on the floor gets its lower half killed by the floor's depth and
  // renders as a dome. Biasing depth toward the camera in proportion to the
  // sprite's own radius removes that slice while keeping real occlusion: a
  // wall well in front of the effect still hides it.
  float bias = min( aSize * uSizeScale * uDepthBias, dist * 0.55 );
  mv.z += bias;
  gl_Position = projectionMatrix * mv;

  // Sub-pixel particles shimmer; fade them out instead of aliasing them.
  float tiny = smoothstep( 0.6, 2.6, px );
  // Anything about to clip through the camera fades rather than popping.
  float near = smoothstep( 0.0, uFadeNear, dist );

  vColor   = aColor;
  vOpacity = aOpacity * tiny * near;
  vShape   = aShape;
  vStretch = aStretch;
  vParam   = aParam;
  vSeed    = aSeed;

  // Sparks orient themselves along screen-space velocity so a streak always
  // reads as travelling; every other shape uses its own spin.
  float ang = aRot;
  if ( abs( aShape - 4.0 ) < 0.5 ) {
    vec3 vv = mat3( modelViewMatrix ) * aVel;
    if ( dot( vv.xy, vv.xy ) > 1e-8 ) ang = atan( vv.y, vv.x );
  }
  vRot = vec2( cos( ang ), sin( ang ) );
}
`;

const particleFragment = /* glsl */ `
precision highp float;

uniform float uIntensity;   // global brightness (quality / art tuning)
uniform float uTime;

#ifdef SOFT_DEPTH
  uniform sampler2D uDepthTexture;
  uniform vec2  uInvResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uSoftness;
#endif

varying vec3  vColor;
varying float vOpacity;
varying float vShape;
varying float vStretch;
varying float vParam;
varying float vSeed;
varying vec2  vRot;
varying float vViewDepth;

const float TAU = 6.2831853;

void main() {
  if ( vOpacity <= 0.002 ) discard;

  // Point coord -> centred, y-up, then rotated into the sprite's local frame.
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;
  vec2 q = vec2( p.x * vRot.x + p.y * vRot.y, -p.x * vRot.y + p.y * vRot.x );

  float d = length( q );
  float a = 0.0;
  vec3  c = vColor;
  float s = vShape;

  if ( s < 0.5 ) {
    // ---- DISC: soft blob, hot core -----------------------------------
    float body = clamp( 1.0 - d, 0.0, 1.0 );
    a = pow( body, 1.5 ) * 0.95 + exp( -d * d * 12.0 ) * 0.60;

  } else if ( s < 1.5 ) {
    // ---- GLOW: wide halo, no edge ------------------------------------
    // Deliberately NOT a gaussian: a gaussian halo plus a wide bloom kernel
    // turns every effect into a photoreal fireball. This is a flat pool of
    // light with a defined shoulder, so the shape on top stays readable.
    float body = clamp( 1.0 - d, 0.0, 1.0 );
    a = smoothstep( 1.0, 0.34, d ) * 0.82 + pow( body, 3.0 ) * 0.45;

  } else if ( s < 2.5 ) {
    // ---- RING: hard annulus ------------------------------------------
    float t = max( vParam, 0.012 );          // half thickness, fraction of radius
    float r = 1.0 - t * 1.6;
    float e = abs( d - r );
    a  = smoothstep( t, t * 0.32, e );       // crisp band
    a += smoothstep( t * 3.0, 0.0, e ) * 0.20;  // outer bleed for bloom
    a *= step( d, 1.0 );

  } else if ( s < 3.5 ) {
    // ---- STAR4: the anime flare --------------------------------------
    // A FILLED astroid ( |x|^e + |y|^e <= 1, e < 1 ), not a sum of thin
    // spikes. Thin spikes vanish under a wide bloom kernel; a bold concave
    // four-point silhouette survives it, which is the whole point of the
    // shape. aParam picks how pointy: 5 is a fat star, 10 a needle.
    float e = clamp( 0.80 - vParam * 0.055, 0.28, 0.62 );
    float sx = pow( abs( q.x ), e ) + pow( abs( q.y ), e );
    float star = 1.0 - smoothstep( 0.84, 1.06, sx );

    // A second, half-size star at 45 degrees turns the flare into the
    // eight-point sparkle the key art actually uses.
    vec2 r45 = vec2( q.x + q.y, q.y - q.x ) * 0.70710678;
    float sd = pow( abs( r45.x ), 0.46 ) + pow( abs( r45.y ), 0.46 );
    float star2 = 1.0 - smoothstep( 0.84, 1.06, sd * 2.15 );

    float core = exp( -d * d * 26.0 );
    a = star * 1.10 + star2 * 0.42 + core * 0.85;
    // The core burns to white, the arms hold the tint.
    c = mix( vColor, vColor + vec3( 0.95 ), clamp( core * 0.85 + star * 0.12, 0.0, 1.0 ) );

  } else if ( s < 4.5 ) {
    // ---- SPARK: velocity-aligned streak ------------------------------
    vec2 r2 = vec2( q.x, q.y * max( vStretch, 1.0 ) );
    float dx = max( abs( r2.x ) - 0.78, 0.0 ) / 0.22;
    float dist = length( vec2( dx, r2.y ) );
    a = smoothstep( 1.0, 0.10, dist );
    a *= mix( 0.18, 1.0, smoothstep( -1.0, 0.85, r2.x ) );   // hot head, thin tail
    c = mix( vColor, vColor + vec3( 0.6 ), smoothstep( 0.55, 1.0, r2.x ) );

  } else if ( s < 5.5 ) {
    // ---- SMOKE: lumpy cel puff ---------------------------------------
    float ang = atan( q.y, q.x );
    float sd = vSeed * TAU;
    float wob = 0.74
      + 0.150 * sin( ang * 3.0 + sd )
      + 0.090 * sin( ang * 5.0 - sd * 1.7 )
      + 0.055 * sin( ang * 7.0 + sd * 2.6 );
    float e = d / max( wob, 0.05 );
    a = 1.0 - smoothstep( 0.62, 1.0, e );
    // Two-step cel shading with the key light coming from the upper left.
    float lam = dot( normalize( q + vec2( 1e-5 ) ), vec2( -0.55, 0.83 ) );
    float band = smoothstep( -0.15, 0.05, lam ) * 0.5 + smoothstep( 0.35, 0.55, lam ) * 0.5;
    c *= mix( 0.66, 1.12, band );

  } else if ( s < 6.5 ) {
    // ---- HEX: shield / rune shard ------------------------------------
    vec2 ap = abs( q );
    float hx = max( ap.x * 0.8660254 + ap.y * 0.5, ap.y ) / 0.92;
    float fill = 1.0 - smoothstep( 0.94, 1.0, hx );
    float rim  = smoothstep( 0.74, 0.96, hx ) * fill;
    a = fill * clamp( vParam, 0.0, 1.0 ) * 0.7 + rim * 1.5;
    c = mix( vColor, vColor + vec3( 0.7 ), rim );

  } else if ( s < 7.5 ) {
    // ---- CROSS: the crisp hit flash ----------------------------------
    vec2 ap = abs( q );
    float th = max( vParam, 0.02 );
    float wx = max( th * ( 1.0 - ap.x * 0.9 ), 0.0015 );
    float wy = max( th * ( 1.0 - ap.y * 0.9 ), 0.0015 );
    float barH = ( 1.0 - smoothstep( wx * 0.35, wx, ap.y ) ) * ( 1.0 - smoothstep( 0.80, 1.0, ap.x ) );
    float barV = ( 1.0 - smoothstep( wy * 0.35, wy, ap.x ) ) * ( 1.0 - smoothstep( 0.80, 1.0, ap.y ) );
    a = max( barH, barV ) + exp( -d * d * 30.0 ) * 0.9;
    c = mix( vColor, vColor + vec3( 0.8 ), exp( -d * d * 24.0 ) );

  } else if ( s < 8.5 ) {
    // ---- SHARD: lit chip (debris, brass) ------------------------------
    vec2 r2 = vec2( q.x, q.y * max( vStretch, 1.0 ) );
    float dia = abs( r2.x ) * 0.78 + abs( r2.y );
    a = 1.0 - smoothstep( 0.80, 0.96, dia );
    float lit = smoothstep( -0.55, 0.65, r2.y - r2.x * 0.35 );
    c *= mix( 0.45, 1.55, lit );

  } else {
    // ---- RUNE: hollow diamond ----------------------------------------
    float dia = ( abs( q.x ) + abs( q.y ) ) / 0.94;
    a = smoothstep( 1.0, 0.84, dia ) * smoothstep( 0.46, 0.64, dia );
    a += exp( -d * d * 46.0 ) * 0.55;
    c = mix( vColor, vColor + vec3( 0.4 ), a * 0.5 );
  }

  a *= vOpacity;
  if ( a <= 0.003 ) discard;

#ifdef SOFT_DEPTH
  // Soft-particle fade: dissolve the sprite where it intersects opaque
  // geometry so smoke never shows a hard intersection line on the floor.
  vec2 suv = gl_FragCoord.xy * uInvResolution;
  float raw = texture2D( uDepthTexture, suv ).x;
  float ndc = raw * 2.0 - 1.0;
  float sceneZ = ( 2.0 * uCameraNear * uCameraFar ) /
                 ( uCameraFar + uCameraNear - ndc * ( uCameraFar - uCameraNear ) );
  a *= clamp( ( sceneZ - vViewDepth ) / max( uSoftness, 1e-3 ), 0.0, 1.0 );
  if ( a <= 0.003 ) discard;
#endif

  gl_FragColor = vec4( c * uIntensity, a );

  #include <colorspace_fragment>
}
`;

/* ====================================================================== */
/* Pool                                                                    */
/* ====================================================================== */

const TAU = Math.PI * 2;
const _tmpColor = new THREE.Color();
const _tmpColorB = new THREE.Color();

function rr( r ) { return r[ 0 ] + Math.random() * ( r[ 1 ] - r[ 0 ] ); }

/**
 * One pooled `THREE.Points` — a single draw call, a single geometry, a single
 * material, and a flat struct-of-arrays for every particle it owns.
 *
 * The GPU-visible arrays are the ones the shader reads. The remaining arrays
 * are simulation state that never leaves the CPU, so the per-frame upload is
 * 16 floats per live particle and nothing more. Dead particles are removed by
 * swapping the last live particle into the hole, which keeps [0, count) packed
 * and lets the upload be exactly one dirty range.
 */
class ParticlePool {
  constructor( capacity, blending, renderOrder ) {
    this.capacity = capacity;
    this.count = 0;

    // --- GPU attributes ---------------------------------------------------
    this.pos     = new Float32Array( capacity * 3 );
    this.vel     = new Float32Array( capacity * 3 );
    this.col     = new Float32Array( capacity * 3 );
    this.size    = new Float32Array( capacity );
    this.rot     = new Float32Array( capacity );
    this.opacity = new Float32Array( capacity );
    this.shape   = new Float32Array( capacity );
    this.stretch = new Float32Array( capacity );
    this.param   = new Float32Array( capacity );
    this.seed    = new Float32Array( capacity );

    // --- CPU-only simulation state ---------------------------------------
    this.life    = new Float32Array( capacity );   // seconds remaining
    this.maxLife = new Float32Array( capacity );
    this.delay   = new Float32Array( capacity );   // pre-birth hold, seconds
    this.drag    = new Float32Array( capacity );
    this.grav    = new Float32Array( capacity );   // gravity scale
    this.size0   = new Float32Array( capacity );
    this.size1   = new Float32Array( capacity );
    this.sizePow = new Float32Array( capacity );
    this.col0    = new Float32Array( capacity * 3 );
    this.col1    = new Float32Array( capacity * 3 );
    this.op0     = new Float32Array( capacity );
    this.fadeIn  = new Float32Array( capacity );
    this.fadePow = new Float32Array( capacity );
    this.angVel  = new Float32Array( capacity );
    this.rest    = new Float32Array( capacity );   // < 0 = no ground collision
    this.fric    = new Float32Array( capacity );
    this.turb    = new Float32Array( capacity );
    this.flick   = new Float32Array( capacity );

    const geo = new THREE.BufferGeometry();
    const attr = ( arr, item ) => {
      const a = new THREE.BufferAttribute( arr, item );
      a.setUsage( THREE.DynamicDrawUsage );
      return a;
    };
    geo.setAttribute( 'position', attr( this.pos, 3 ) );
    geo.setAttribute( 'aVel',     attr( this.vel, 3 ) );
    geo.setAttribute( 'aColor',   attr( this.col, 3 ) );
    geo.setAttribute( 'aSize',    attr( this.size, 1 ) );
    geo.setAttribute( 'aRot',     attr( this.rot, 1 ) );
    geo.setAttribute( 'aOpacity', attr( this.opacity, 1 ) );
    geo.setAttribute( 'aShape',   attr( this.shape, 1 ) );
    geo.setAttribute( 'aStretch', attr( this.stretch, 1 ) );
    geo.setAttribute( 'aParam',   attr( this.param, 1 ) );
    geo.setAttribute( 'aSeed',    attr( this.seed, 1 ) );
    geo.setDrawRange( 0, 0 );
    // The pool spans the whole arena; a bounding sphere would be stale every
    // frame, so culling is disabled outright.
    geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );

    const material = new THREE.ShaderMaterial( {
      vertexShader: particleVertex,
      fragmentShader: particleFragment,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending,
      uniforms: {
        uProjScale:  { value: 900 },
        uSizeScale:  { value: 1 },
        uMaxPoint:   { value: 700 },
        uFadeNear:   { value: 0.5 },
        uDepthBias:  { value: 0.5 },
        uIntensity:  { value: 1 },
        uTime:       { value: 0 },
        uDepthTexture:  { value: null },
        uInvResolution: { value: new THREE.Vector2( 1 / 1600, 1 / 900 ) },
        uCameraNear: { value: 0.4 },
        uCameraFar:  { value: 400 },
        uSoftness:   { value: 0.6 },
      },
    } );

    this.geometry = geo;
    this.material = material;
    this.points = new THREE.Points( geo, material );
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.matrixAutoUpdate = false;
    this.points.updateMatrix();

    this.attributes = [
      geo.attributes.position, geo.attributes.aVel, geo.attributes.aColor,
      geo.attributes.aSize, geo.attributes.aRot, geo.attributes.aOpacity,
      geo.attributes.aShape, geo.attributes.aStretch, geo.attributes.aParam,
      geo.attributes.aSeed,
    ];
  }

  /** Claims a slot. Returns the index, or -1 when the budget is full. */
  alloc( budget ) {
    const limit = Math.min( budget, this.capacity );
    if ( this.count >= limit ) return -1;
    return this.count++;
  }

  /** Swap-removes particle `i`, keeping [0, count) contiguous. */
  kill( i ) {
    const last = --this.count;
    if ( i === last ) return;
    const i3 = i * 3, l3 = last * 3;
    this.pos[ i3 ] = this.pos[ l3 ]; this.pos[ i3 + 1 ] = this.pos[ l3 + 1 ]; this.pos[ i3 + 2 ] = this.pos[ l3 + 2 ];
    this.vel[ i3 ] = this.vel[ l3 ]; this.vel[ i3 + 1 ] = this.vel[ l3 + 1 ]; this.vel[ i3 + 2 ] = this.vel[ l3 + 2 ];
    this.col[ i3 ] = this.col[ l3 ]; this.col[ i3 + 1 ] = this.col[ l3 + 1 ]; this.col[ i3 + 2 ] = this.col[ l3 + 2 ];
    this.col0[ i3 ] = this.col0[ l3 ]; this.col0[ i3 + 1 ] = this.col0[ l3 + 1 ]; this.col0[ i3 + 2 ] = this.col0[ l3 + 2 ];
    this.col1[ i3 ] = this.col1[ l3 ]; this.col1[ i3 + 1 ] = this.col1[ l3 + 1 ]; this.col1[ i3 + 2 ] = this.col1[ l3 + 2 ];
    this.size[ i ] = this.size[ last ];
    this.rot[ i ] = this.rot[ last ];
    this.opacity[ i ] = this.opacity[ last ];
    this.shape[ i ] = this.shape[ last ];
    this.stretch[ i ] = this.stretch[ last ];
    this.param[ i ] = this.param[ last ];
    this.seed[ i ] = this.seed[ last ];
    this.life[ i ] = this.life[ last ];
    this.maxLife[ i ] = this.maxLife[ last ];
    this.delay[ i ] = this.delay[ last ];
    this.drag[ i ] = this.drag[ last ];
    this.grav[ i ] = this.grav[ last ];
    this.size0[ i ] = this.size0[ last ];
    this.size1[ i ] = this.size1[ last ];
    this.sizePow[ i ] = this.sizePow[ last ];
    this.op0[ i ] = this.op0[ last ];
    this.fadeIn[ i ] = this.fadeIn[ last ];
    this.fadePow[ i ] = this.fadePow[ last ];
    this.angVel[ i ] = this.angVel[ last ];
    this.rest[ i ] = this.rest[ last ];
    this.fric[ i ] = this.fric[ last ];
    this.turb[ i ] = this.turb[ last ];
    this.flick[ i ] = this.flick[ last ];
  }

  /** Uploads exactly the live range, once, for every attribute. */
  flush() {
    const n = this.count;
    this.geometry.setDrawRange( 0, n );
    if ( n === 0 ) return;
    for ( let k = 0; k < this.attributes.length; k++ ) {
      const a = this.attributes[ k ];
      a.clearUpdateRanges();
      a.addUpdateRange( 0, n * a.itemSize );
      a.needsUpdate = true;
    }
  }

  clear() { this.count = 0; this.geometry.setDrawRange( 0, 0 ); }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ====================================================================== */
/* Presets                                                                 */
/* ====================================================================== */

/**
 * A preset is a stack of *layers*. Each layer is one burst of one sprite shape
 * with its own timing, so an effect is composed the way a 2D animator would
 * build it: a flash frame on top, motion underneath, atmosphere last.
 *
 * Timing convention: `delay` staggers a layer, `life` is its duration, and
 * `fadePow` shapes the decay (2 = ease-out, 3+ = a snap). Nothing here fades
 * linearly and nothing except smoke, embers and ambience outlives 0.6 s.
 */
const PRESETS = {

  /* ---- gunfire ------------------------------------------------------- */

  muzzleFlash: {
    layers: [
      { // the flash frame: one big 4-point star, two frames long
        shape: SHAPE.STAR4, count: 1, pool: 'add',
        life: [ 0.070, 0.085 ], size: [ 1.05, 1.30 ], sizeEnd: 1.35, sizePow: 1.9,
        color: 0xfff4cf, colorEnd: 0xffc23d, hdr: 4.4, hdrEnd: 2.1,
        param: [ 7, 10 ], rot: [ -0.35, 0.35 ], fadeIn: 0.10, fadePow: 1.5,
        dirSpeed: [ 0.6, 0.9 ], tint: true,
      },
      { // warm halo behind it so the star sits in a pool of light
        shape: SHAPE.GLOW, count: 1, pool: 'add',
        life: [ 0.10, 0.13 ], size: [ 0.50, 0.62 ], sizeEnd: 1.7, sizePow: 1.9,
        color: 0xffd54a, colorEnd: 0xff8a3d, hdr: 1.9, hdrEnd: 0.7,
        opacity: 0.85, fadeIn: 0.08, fadePow: 2.4, tint: true,
      },
      { // cone of fast sparks
        shape: SHAPE.SPARK, count: 16, pool: 'add',
        life: [ 0.10, 0.24 ], size: [ 0.42, 0.85 ], sizeEnd: 0.35, sizePow: 1.6,
        color: 0xffe9a8, colorEnd: 0xff5d1e, hdr: 2.9, hdrEnd: 1.4,
        dirSpeed: [ 9, 24 ], cone: 0.30, stretch: [ 4.5, 8.0 ],
        drag: 5.5, gravity: 0.35, fadeIn: 0.04, fadePow: 2.6, tint: true,
      },
      { // a few wide strays so the cone is not a perfect fan
        shape: SHAPE.SPARK, count: 5, pool: 'add', minQuality: 1,
        life: [ 0.12, 0.28 ], size: [ 0.30, 0.55 ], sizeEnd: 0.3, sizePow: 1.6,
        color: 0xffd54a, colorEnd: 0xff4a1e, hdr: 2.4, hdrEnd: 1.0,
        dirSpeed: [ 4, 11 ], cone: 1.05, stretch: [ 3.5, 6.0 ],
        drag: 4.0, gravity: 1.1, fadePow: 2.4,
      },
      { // muzzle smoke, arriving a frame late and drifting forward
        shape: SHAPE.SMOKE, count: 6, pool: 'alpha', minQuality: 1,
        delay: [ 0.015, 0.05 ], life: [ 0.32, 0.55 ],
        size: [ 0.22, 0.34 ], sizeEnd: 3.0, sizePow: 2.4,
        color: 0xe6e0ee, colorEnd: 0xb9b2cc, hdr: 0.95, hdrEnd: 0.8,
        opacity: [ 0.16, 0.30 ], fadeIn: 0.18, fadePow: 1.8,
        dirSpeed: [ 1.4, 3.4 ], cone: 0.55, upSpeed: [ 0.3, 0.9 ],
        drag: 3.2, spin: [ -1.6, 1.6 ], turb: 0.5,
      },
    ],
  },

  /* ---- impacts -------------------------------------------------------- */

  impactConcrete: {
    layers: [
      { shape: SHAPE.STAR4, count: 1, pool: 'add',
        life: [ 0.075, 0.095 ], size: [ 0.62, 0.82 ], sizeEnd: 1.5, sizePow: 1.9,
        color: 0xfff0d0, colorEnd: 0xffd08a, hdr: 3.4, hdrEnd: 1.8,
        param: [ 7, 10 ], rot: [ -0.6, 0.6 ],
        fadeIn: 0.12, fadePow: 1.6 },
      { shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.17, 0.21 ], size: [ 0.24, 0.30 ], sizeEnd: 4.6, sizePow: 3.0,
        color: 0xffe6bd, colorEnd: 0xcfc9c2, hdr: 2.3, hdrEnd: 1.0, param: [ 0.16, 0.22 ],
        opacity: 0.85, fadeIn: 0.06, fadePow: 2.6 },
      { // chips that arc and skitter
        shape: SHAPE.SHARD, count: 9, pool: 'alpha',
        life: [ 0.45, 0.85 ], size: [ 0.05, 0.11 ], sizeEnd: 0.9, sizePow: 1,
        color: 0xb5aea6, colorEnd: 0x8b857e, hdr: 1, hdrEnd: 1,
        dirSpeed: [ 2.5, 8.5 ], cone: 1.0, upSpeed: [ 0.6, 2.4 ],
        gravity: 1.5, drag: 0.5, spin: [ -14, 14 ], stretch: [ 1.4, 2.2 ],
        restitution: 0.28, friction: 0.6, fadeIn: 0.04, fadePow: 3.0 },
      { // grey dust that lingers
        shape: SHAPE.SMOKE, count: 7, pool: 'alpha',
        delay: [ 0, 0.04 ], life: [ 0.38, 0.66 ],
        size: [ 0.16, 0.26 ], sizeEnd: 3.4, sizePow: 2.2,
        color: 0xd8d2c8, colorEnd: 0xaaa39a, hdr: 1, hdrEnd: 0.9,
        opacity: [ 0.18, 0.34 ], fadeIn: 0.16, fadePow: 1.9,
        dirSpeed: [ 1.0, 3.0 ], cone: 0.9, drag: 3.4, spin: [ -2, 2 ], turb: 0.6 },
    ],
    decal: { type: 'bullet', radius: [ 0.10, 0.17 ], color: 0x3a3340, opacity: 0.55, life: 9 },
  },

  impactMetal: {
    layers: [
      { shape: SHAPE.STAR4, count: 1, pool: 'add',
        life: [ 0.075, 0.095 ], size: [ 0.95, 1.25 ], sizeEnd: 1.5, sizePow: 1.9,
        color: 0xfffbe8, colorEnd: 0xffd54a, hdr: 4.8, hdrEnd: 2.4,
        param: [ 6, 9 ], rot: [ -0.7, 0.7 ], fadeIn: 0.10, fadePow: 1.5 },
      { shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.14, 0.18 ], size: [ 0.22, 0.3 ], sizeEnd: 4.8, sizePow: 3.2,
        color: 0xffe08a, colorEnd: 0xffa83c, hdr: 2.8, hdrEnd: 1.1,
        param: [ 0.12, 0.18 ], fadeIn: 0.05, fadePow: 2.8 },
      { // ricochet sparks: long, hot, gravity-bent, and they bounce
        shape: SHAPE.SPARK, count: 22, pool: 'add',
        life: [ 0.20, 0.48 ], size: [ 0.35, 0.75 ], sizeEnd: 0.4, sizePow: 1.5,
        color: 0xfff3c0, colorEnd: 0xff5a12, hdr: 3.4, hdrEnd: 1.5,
        dirSpeed: [ 5, 17 ], cone: 1.15, stretch: [ 5, 9 ],
        gravity: 1.5, drag: 1.6, restitution: 0.42, friction: 0.72,
        fadeIn: 0.04, fadePow: 2.2, tint: true },
      { shape: SHAPE.SPARK, count: 8, pool: 'add', minQuality: 1,
        life: [ 0.35, 0.7 ], size: [ 0.22, 0.4 ], sizeEnd: 0.25, sizePow: 1.4,
        color: 0xffc46a, colorEnd: 0xff3a08, hdr: 2.4, hdrEnd: 0.9,
        dirSpeed: [ 2, 7 ], cone: 1.5, stretch: [ 3, 6 ],
        gravity: 2.2, drag: 1.0, restitution: 0.35, friction: 0.7,
        fadePow: 2.0, flicker: 0.5 },
      { shape: SHAPE.SMOKE, count: 3, pool: 'alpha', minQuality: 2,
        delay: [ 0.02, 0.06 ], life: [ 0.3, 0.5 ],
        size: [ 0.12, 0.2 ], sizeEnd: 3.0, sizePow: 2.2,
        color: 0xcfc8d8, hdr: 0.9, opacity: [ 0.10, 0.20 ],
        dirSpeed: [ 0.8, 2.2 ], cone: 0.8, drag: 3.0, fadePow: 1.8 },
    ],
    decal: { type: 'bullet', radius: [ 0.08, 0.13 ], color: 0x2f2a38, opacity: 0.45, life: 8 },
  },

  // Deliberately not gore: a stylised violet/blue "damage" burst, the way the
  // source material handles a hit landing on a character.
  impactFlesh: {
    layers: [
      { shape: SHAPE.CROSS, count: 1, pool: 'add',
        life: [ 0.085, 0.11 ], size: [ 0.95, 1.25 ], sizeEnd: 1.45, sizePow: 1.9,
        color: 0xffffff, colorEnd: 0xd0b0ff, hdr: 4.2, hdrEnd: 2.0,
        param: [ 0.13, 0.19 ], rot: [ -0.5, 0.5 ], fadeIn: 0.12, fadePow: 1.8 },
      { shape: SHAPE.GLOW, count: 1, pool: 'add',
        life: [ 0.18, 0.24 ], size: [ 0.52, 0.68 ], sizeEnd: 1.9, sizePow: 1.1,
        color: 0xb07dff, colorEnd: 0x5b8cff, hdr: 1.8, hdrEnd: 0.45,
        opacity: 0.7, fadeIn: 0.10, fadePow: 2.4, tint: true },
      { // chunky angular shards, not a fog of dots
        shape: SHAPE.SHARD, count: 13, pool: 'add',
        life: [ 0.18, 0.34 ], size: [ 0.18, 0.42 ], sizeEnd: 0.5, sizePow: 1.6,
        color: 0xd7bcff, colorEnd: 0x5b8cff, hdr: 2.9, hdrEnd: 1.3,
        dirSpeed: [ 5, 13 ], cone: 1.25, stretch: [ 2.0, 3.4 ],
        drag: 6.5, gravity: 0.4, fadeIn: 0.05, fadePow: 2.6, tint: true },
      { // motes that peel upward afterwards — reads as "damage number" energy
        shape: SHAPE.DISC, count: 9, pool: 'add', minQuality: 1,
        delay: [ 0.02, 0.10 ], life: [ 0.30, 0.55 ],
        size: [ 0.06, 0.13 ], sizeEnd: 0.2, sizePow: 2,
        color: 0xc9a6ff, colorEnd: 0x6f8dff, hdr: 2.4, hdrEnd: 0.8,
        dirSpeed: [ 1, 3 ], cone: 1.6, upSpeed: [ 1.2, 2.8 ],
        drag: 1.6, turb: 1.2, fadePow: 1.8, tint: true },
    ],
  },

  impactShield: {
    layers: [
      { shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.26, 0.32 ], size: [ 0.35, 0.45 ], sizeEnd: 5.5, sizePow: 3.0,
        color: 0xd8f4ff, colorEnd: 0x7fd6ff, hdr: 3.4, hdrEnd: 1.5,
        param: [ 0.10, 0.15 ], fadeIn: 0.05, fadePow: 2.4, tint: true },
      { shape: SHAPE.STAR4, count: 1, pool: 'add',
        life: [ 0.09, 0.115 ], size: [ 0.95, 1.25 ], sizeEnd: 1.35, sizePow: 1.9,
        color: 0xffffff, colorEnd: 0x7fd6ff, hdr: 4.0, hdrEnd: 1.9,
        param: [ 7, 11 ], rot: [ -0.5, 0.5 ], fadeIn: 0.10, fadePow: 1.6 },
      { // the hex lattice cracking outward
        shape: SHAPE.HEX, count: 14, pool: 'add',
        life: [ 0.24, 0.44 ], size: [ 0.24, 0.46 ], sizeEnd: 0.6, sizePow: 1.5,
        color: 0xbfeaff, colorEnd: 0x35a3ea, hdr: 2.6, hdrEnd: 1.1,
        param: [ 0.16, 0.34 ],
        dirSpeed: [ 2.5, 7.5 ], cone: 1.35, drag: 7.0,
        spin: [ -6, 6 ], fadeIn: 0.06, fadePow: 2.6, tint: true },
      { shape: SHAPE.SPARK, count: 8, pool: 'add', minQuality: 1,
        life: [ 0.12, 0.26 ], size: [ 0.28, 0.5 ], sizeEnd: 0.3, sizePow: 1.5,
        color: 0xe8faff, colorEnd: 0x7fd6ff, hdr: 3.0, hdrEnd: 1.2,
        dirSpeed: [ 6, 14 ], cone: 1.2, stretch: [ 4, 7 ], drag: 7, fadePow: 2.6 },
    ],
  },

  /* ---- physical debris ------------------------------------------------ */

  // One brass case per call. Ejects sideways, tumbles, bounces off y = 0 with
  // restitution and friction, then rests and fades.
  shellCasing: {
    layers: [
      { shape: SHAPE.SHARD, count: 1, pool: 'alpha',
        life: [ 1.5, 2.1 ], size: [ 0.075, 0.095 ], sizeEnd: 1, sizePow: 1,
        color: 0xf0c455, colorEnd: 0xc08a2a, hdr: 1.1, hdrEnd: 1,
        dirSpeed: [ 2.4, 4.2 ], cone: 0.30, upSpeed: [ 1.6, 2.8 ],
        gravity: 1.0, drag: 0.25, spin: [ -22, 22 ], stretch: [ 2.2, 2.8 ],
        restitution: 0.42, friction: 0.55,
        opacity: 1, fadeIn: 0.01, fadePow: 6.0 },
      { // a single warm glint so the brass catches the eye mid-air
        shape: SHAPE.GLOW, count: 1, pool: 'add', minQuality: 2,
        life: [ 0.16, 0.22 ], size: [ 0.10, 0.16 ], sizeEnd: 0.4, sizePow: 2,
        color: 0xffd98a, hdr: 2.2, opacity: 0.8,
        dirSpeed: [ 2.4, 3.6 ], cone: 0.3, upSpeed: [ 1.6, 2.4 ],
        gravity: 1.0, fadePow: 2.2 },
    ],
  },

  /* ---- hit feedback --------------------------------------------------- */

  // The crisp white cross-flash that confirms a hit landed. Two crosses at
  // 45 degrees to each other plus a thin ring: five frames, gone.
  hitSpark: {
    layers: [
      { shape: SHAPE.CROSS, count: 1, pool: 'add',
        life: [ 0.11, 0.14 ], size: [ 1.0, 1.25 ], sizeEnd: 1.5, sizePow: 1.9,
        color: 0xffffff, hdr: 5.0, hdrEnd: 2.8, colorEnd: 0xdff4ff,
        param: [ 0.11, 0.15 ], rot: [ -0.25, 0.25 ], fadeIn: 0.10, fadePow: 2.0 },
      { shape: SHAPE.CROSS, count: 1, pool: 'add',
        life: [ 0.08, 0.10 ], size: [ 0.62, 0.8 ], sizeEnd: 1.6, sizePow: 1.9,
        color: 0xd8f4ff, colorEnd: 0x7fd6ff, hdr: 3.2, hdrEnd: 1.3,
        param: [ 0.09, 0.12 ], rot: [ 0.68, 0.90 ], fadeIn: 0.10, fadePow: 2.2, tint: true },
      { shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.13, 0.16 ], size: [ 0.25, 0.32 ], sizeEnd: 4.0, sizePow: 3.0,
        color: 0xffffff, colorEnd: 0xbfe6ff, hdr: 2.4, hdrEnd: 0.9,
        param: [ 0.09, 0.13 ], opacity: 0.9, fadeIn: 0.05, fadePow: 3.0 },
      { shape: SHAPE.SPARK, count: 7, pool: 'add', minQuality: 1,
        life: [ 0.09, 0.16 ], size: [ 0.28, 0.5 ], sizeEnd: 0.25, sizePow: 1.5,
        color: 0xffffff, colorEnd: 0xbfe6ff, hdr: 3.2, hdrEnd: 1.3,
        dirSpeed: [ 7, 15 ], cone: 1.6, stretch: [ 4, 7 ], drag: 9, fadePow: 2.4 },
    ],
  },

  /* ---- explosion ------------------------------------------------------ */

  explosion: {
    layers: [
      { // frame 1: the star
        shape: SHAPE.STAR4, count: 1, pool: 'add',
        life: [ 0.15, 0.18 ], size: [ 3.2, 3.8 ], sizeEnd: 1.4, sizePow: 1.9,
        color: 0xfffbe8, colorEnd: 0xffb03a, hdr: 5.0, hdrEnd: 2.4,
        param: [ 5, 8 ], rot: [ -0.4, 0.4 ], fadeIn: 0.09, fadePow: 1.7 },
      { shape: SHAPE.GLOW, count: 1, pool: 'add',
        life: [ 0.22, 0.30 ], size: [ 0.75, 0.95 ], sizeEnd: 1.9, sizePow: 1.0,
        color: 0xffc46a, hdr: 1.7, hdrEnd: 0.28, colorEnd: 0xff5d1e,
        opacity: 0.45, fadeIn: 0.08, fadePow: 2.4 },
      { // frame 2-3: the hard ring
        shape: SHAPE.RING, count: 1, pool: 'add',
        delay: [ 0.028, 0.036 ], life: [ 0.30, 0.36 ],
        size: [ 1.0, 1.2 ], sizeEnd: 7.0, sizePow: 3.2,
        color: 0xffe9b0, colorEnd: 0xff7a3c, hdr: 3.4, hdrEnd: 1.4,
        param: [ 0.085, 0.12 ], fadeIn: 0.05, fadePow: 2.6 },
      { // a second, thinner, whiter ring one frame behind it
        shape: SHAPE.RING, count: 1, pool: 'add',
        delay: [ 0.05, 0.07 ], life: [ 0.26, 0.32 ],
        size: [ 0.8, 1.0 ], sizeEnd: 9.0, sizePow: 3.4,
        color: 0xffffff, colorEnd: 0xffd54a, hdr: 2.6, hdrEnd: 1.0,
        param: [ 0.04, 0.065 ], opacity: 0.9, fadeIn: 0.05, fadePow: 3.0 },
      { // embers
        shape: SHAPE.SPARK, count: 30, pool: 'add',
        life: [ 0.5, 1.15 ], size: [ 0.4, 0.95 ], sizeEnd: 0.3, sizePow: 1.4,
        color: 0xffe08a, colorEnd: 0xff3a10, hdr: 3.0, hdrEnd: 1.2,
        radius: [ 0.2, 0.8 ], radialSpeed: [ 6, 20 ], upSpeed: [ 1, 6 ],
        stretch: [ 4, 8 ], gravity: 1.5, drag: 1.3,
        restitution: 0.3, friction: 0.65, fadeIn: 0.03, fadePow: 2.0, flicker: 0.35 },
      { // chunky debris
        shape: SHAPE.SHARD, count: 10, pool: 'alpha', minQuality: 1,
        life: [ 0.7, 1.3 ], size: [ 0.10, 0.22 ], sizeEnd: 0.9, sizePow: 1,
        color: 0x6d6470, colorEnd: 0x4a434f, hdr: 1, hdrEnd: 1,
        radius: [ 0.2, 0.7 ], radialSpeed: [ 3, 10 ], upSpeed: [ 2, 6.5 ],
        gravity: 1.7, drag: 0.4, spin: [ -16, 16 ], stretch: [ 1.3, 2.0 ],
        restitution: 0.3, friction: 0.6, fadePow: 4.0 },
      { // rising smoke columns
        shape: SHAPE.SMOKE, count: 16, pool: 'alpha',
        delay: [ 0.02, 0.16 ], life: [ 0.75, 1.4 ],
        size: [ 0.55, 0.9 ], sizeEnd: 3.4, sizePow: 2.0,
        color: 0xd2cadf, colorEnd: 0x8b8398, hdr: 1.0, hdrEnd: 0.75,
        opacity: [ 0.30, 0.52 ], fadeIn: 0.14, fadePow: 1.7,
        radius: [ 0.1, 1.1 ], radialSpeed: [ 1.2, 4.5 ], upSpeed: [ 2.4, 6.5 ],
        drag: 1.5, spin: [ -1.4, 1.4 ], turb: 1.1 },
      { // a low ground-hugging skirt of dust
        shape: SHAPE.SMOKE, count: 10, pool: 'alpha', minQuality: 1,
        delay: [ 0.03, 0.10 ], life: [ 0.6, 1.0 ],
        size: [ 0.5, 0.8 ], sizeEnd: 3.2, sizePow: 2.2,
        color: 0xdcd6c9, colorEnd: 0xa8a196, hdr: 1, hdrEnd: 0.9,
        opacity: [ 0.16, 0.30 ], fadeIn: 0.18, fadePow: 1.8,
        radius: [ 0.3, 1.0 ], height: [ -0.4, -0.1 ],
        radialSpeed: [ 5, 12 ], upSpeed: [ 0.1, 0.8 ],
        drag: 2.6, spin: [ -1.6, 1.6 ], turb: 0.7 },
    ],
    shockwave: { radius: 6.5, life: 0.42, color: 0xffd07a, hdr: 2.6, thickness: 0.06 },
    decal: { type: 'scorch', radius: [ 1.6, 2.2 ], color: 0x241d2c, opacity: 0.72, life: 16 },
  },

  /* ---- movement ------------------------------------------------------- */

  dust: {
    layers: [
      { shape: SHAPE.SMOKE, count: 6, pool: 'alpha',
        life: [ 0.32, 0.55 ], size: [ 0.14, 0.24 ], sizeEnd: 3.0, sizePow: 2.2,
        color: 0xe0dacd, colorEnd: 0xb6b0a4, hdr: 1, hdrEnd: 0.9,
        opacity: [ 0.10, 0.22 ], fadeIn: 0.2, fadePow: 1.7,
        radius: [ 0, 0.16 ], radialSpeed: [ 1.0, 2.8 ], upSpeed: [ 0.25, 0.9 ],
        drag: 3.6, spin: [ -2, 2 ], turb: 0.5 },
      { shape: SHAPE.SHARD, count: 3, pool: 'alpha', minQuality: 2,
        life: [ 0.3, 0.55 ], size: [ 0.03, 0.06 ], sizeEnd: 0.9, sizePow: 1,
        color: 0xb9b2a6, hdr: 1,
        radialSpeed: [ 1.4, 3.4 ], upSpeed: [ 1.0, 2.4 ],
        gravity: 1.6, spin: [ -12, 12 ], stretch: [ 1.3, 1.9 ], fadePow: 3 },
    ],
  },

  /* ---- support / skills ------------------------------------------------ */

  healPulse: {
    layers: [
      { shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.42, 0.5 ], size: [ 0.6, 0.7 ], sizeEnd: 4.2, sizePow: 2.6,
        color: 0xd6ffef, hdr: 2.6, hdrEnd: 1.1, colorEnd: 0x4ce0a4,
        param: [ 0.07, 0.11 ], fadeIn: 0.10, fadePow: 2.2, tint: true },
      { // rising motes
        shape: SHAPE.DISC, count: 20, pool: 'add',
        delay: [ 0, 0.25 ], life: [ 0.55, 1.0 ],
        size: [ 0.07, 0.16 ], sizeEnd: 0.35, sizePow: 2.0,
        color: 0xb7ffe0, colorEnd: 0x2fc98c, hdr: 2.3, hdrEnd: 0.9,
        opacity: 0.95, fadeIn: 0.18, fadePow: 1.8,
        radius: [ 0.15, 0.95 ], height: [ 0, 0.25 ],
        upSpeed: [ 1.1, 2.6 ], tangentSpeed: [ 0.3, 1.0 ],
        drag: 0.9, turb: 0.9, tint: true },
      { // a handful of "+" sparkles among them
        shape: SHAPE.CROSS, count: 6, pool: 'add', minQuality: 1,
        delay: [ 0.05, 0.35 ], life: [ 0.35, 0.6 ],
        size: [ 0.16, 0.3 ], sizeEnd: 0.7, sizePow: 1.4,
        color: 0xeafff6, colorEnd: 0x4ce0a4, hdr: 2.8, hdrEnd: 1.1,
        param: [ 0.16, 0.24 ], rot: [ -0.15, 0.15 ],
        radius: [ 0.2, 0.9 ], upSpeed: [ 0.9, 2.0 ],
        drag: 1.2, fadeIn: 0.16, fadePow: 2.0, tint: true },
    ],
    shockwave: { radius: 2.6, life: 0.55, color: 0x4ce0a4, hdr: 2.0, thickness: 0.05 },
  },

  // Two beats in one preset: shards spiral inward for ~0.4 s, then the centre
  // detonates. The second beat is scheduled with per-layer `delay`.
  skillCast: {
    layers: [
      { shape: SHAPE.HEX, count: 22, pool: 'add',
        delay: [ 0, 0.10 ], life: [ 0.40, 0.48 ],
        size: [ 0.14, 0.30 ], sizeEnd: 0.35, sizePow: 2.4,
        color: 0xdcf6ff, colorEnd: 0x35a3ea, hdr: 2.6, hdrEnd: 1.2,
        param: [ 0.15, 0.4 ],
        radius: [ 2.2, 3.2 ], height: [ 0.1, 2.2 ],
        radialSpeed: [ -7.5, -5.0 ], tangentSpeed: [ 2.0, 4.5 ], upSpeed: [ -0.6, 0.6 ],
        drag: 0.4, spin: [ -7, 7 ], fadeIn: 0.14, fadePow: 1.6, tint: true },
      { shape: SHAPE.RUNE, count: 8, pool: 'add', minQuality: 1,
        delay: [ 0, 0.12 ], life: [ 0.40, 0.5 ],
        size: [ 0.22, 0.4 ], sizeEnd: 0.4, sizePow: 2.4,
        color: 0xbfeaff, colorEnd: 0x7fd6ff, hdr: 2.4, hdrEnd: 1.1,
        radius: [ 2.4, 3.4 ], height: [ 0.2, 1.8 ],
        radialSpeed: [ -8, -6 ], tangentSpeed: [ 2.5, 5 ],
        drag: 0.4, spin: [ -4, 4 ], fadeIn: 0.16, fadePow: 1.6, tint: true },
      { // the detonation
        shape: SHAPE.STAR4, count: 1, pool: 'add',
        delay: [ 0.44, 0.44 ], life: [ 0.14, 0.17 ],
        size: [ 2.4, 2.9 ], sizeEnd: 1.4, sizePow: 1.9, height: [ 1.0, 1.0 ],
        color: 0xffffff, colorEnd: 0x7fd6ff, hdr: 4.4, hdrEnd: 2.0,
        param: [ 6, 9 ], rot: [ -0.3, 0.3 ], fadeIn: 0.09, fadePow: 1.7, tint: true },
      { shape: SHAPE.RING, count: 1, pool: 'add',
        delay: [ 0.45, 0.45 ], life: [ 0.30, 0.36 ],
        size: [ 0.8, 1.0 ], sizeEnd: 6.5, sizePow: 3.2, height: [ 1.0, 1.0 ],
        color: 0xe8fbff, colorEnd: 0x35a3ea, hdr: 3.0, hdrEnd: 1.3,
        param: [ 0.06, 0.09 ], fadeIn: 0.05, fadePow: 2.6, tint: true },
      { shape: SHAPE.SPARK, count: 24, pool: 'add',
        delay: [ 0.45, 0.50 ], life: [ 0.22, 0.42 ],
        size: [ 0.45, 0.85 ], sizeEnd: 0.3, sizePow: 1.5, height: [ 0.9, 1.1 ],
        color: 0xeafcff, colorEnd: 0x2f8fe0, hdr: 3.0, hdrEnd: 1.2,
        radialSpeed: [ 7, 18 ], upSpeed: [ -1.5, 3.5 ], radius: [ 0, 0.3 ],
        stretch: [ 5, 9 ], drag: 4.0, fadeIn: 0.04, fadePow: 2.4, tint: true },
      { shape: SHAPE.HEX, count: 10, pool: 'add', minQuality: 1,
        delay: [ 0.46, 0.55 ], life: [ 0.3, 0.5 ],
        size: [ 0.16, 0.32 ], sizeEnd: 0.5, sizePow: 1.6, height: [ 0.7, 1.3 ],
        color: 0xbfeaff, colorEnd: 0x35a3ea, hdr: 2.4, hdrEnd: 1.0,
        param: [ 0.2, 0.5 ], radialSpeed: [ 3, 9 ], upSpeed: [ 0.5, 3 ],
        drag: 3.0, spin: [ -8, 8 ], fadePow: 2.2, tint: true },
    ],
    shockwave: { radius: 4.0, life: 0.5, color: 0x7fd6ff, hdr: 2.4, thickness: 0.05, delay: 0.45 },
  },

  // Ambient sparkle around a character's halo. Call it every ~0.2 s.
  haloSpark: {
    layers: [
      { shape: SHAPE.DISC, count: 3, pool: 'add',
        life: [ 0.7, 1.4 ], size: [ 0.030, 0.075 ], sizeEnd: 0.25, sizePow: 2.2,
        color: 0xdff6ff, colorEnd: 0x9fe8ff, hdr: 2.4, hdrEnd: 1.1,
        radius: [ 0.10, 0.30 ], upSpeed: [ 0.10, 0.45 ],
        jitterSpeed: [ 0.05, 0.25 ], drag: 1.1, turb: 0.55,
        fadeIn: 0.22, fadePow: 1.6, flicker: 0.35, tint: true },
      { shape: SHAPE.CROSS, count: 1, pool: 'add', minQuality: 1,
        life: [ 0.35, 0.6 ], size: [ 0.10, 0.19 ], sizeEnd: 0.5, sizePow: 1.5,
        color: 0xffffff, colorEnd: 0x9fe8ff, hdr: 2.8, hdrEnd: 1.1,
        param: [ 0.13, 0.2 ], rot: [ -0.3, 0.3 ],
        radius: [ 0.12, 0.32 ], upSpeed: [ 0.1, 0.4 ],
        fadeIn: 0.24, fadePow: 2.0, tint: true },
    ],
  },

  // Emitted every frame along a flying projectile. Two particles per call.
  bulletTrail: {
    layers: [
      { shape: SHAPE.SPARK, count: 1, pool: 'add',
        life: [ 0.07, 0.11 ], size: [ 0.55, 0.8 ], sizeEnd: 0.5, sizePow: 1.4,
        color: 0xeafaff, colorEnd: 0x7fd6ff, hdr: 3.0, hdrEnd: 1.1,
        dirSpeed: [ 1.5, 2.5 ], cone: 0.02, stretch: [ 8, 12 ],
        drag: 8, fadeIn: 0.05, fadePow: 2.2, tint: true },
      { shape: SHAPE.GLOW, count: 1, pool: 'add',
        life: [ 0.10, 0.16 ], size: [ 0.16, 0.24 ], sizeEnd: 0.3, sizePow: 2,
        color: 0xbfe6ff, hdr: 1.5, hdrEnd: 0.4, colorEnd: 0x35a3ea,
        opacity: 0.7, jitterSpeed: [ 0, 0.3 ], drag: 4, fadePow: 2.0, tint: true },
    ],
  },

  /* ---- ambience ------------------------------------------------------- */

  rain: {
    ambient: { rate: 900, box: [ 22, 14, 22 ], y: 7, follow: true },
    layers: [
      { shape: SHAPE.SPARK, count: 1, pool: 'alpha',
        life: [ 0.55, 0.85 ], size: [ 0.75, 1.15 ], sizeEnd: 1, sizePow: 1,
        color: 0xcfe4f5, colorEnd: 0xa8c8e2, hdr: 1.1, hdrEnd: 1,
        opacity: [ 0.16, 0.34 ], fadeIn: 0.06, fadePow: 0.7,
        upSpeed: [ -26, -20 ], jitterSpeed: [ 0.2, 0.9 ],
        stretch: [ 12, 20 ], drag: 0 },
    ],
  },

  emberDrift: {
    ambient: { rate: 26, box: [ 16, 6, 16 ], y: 2.6, follow: true },
    layers: [
      { shape: SHAPE.DISC, count: 1, pool: 'add',
        life: [ 1.8, 3.6 ], size: [ 0.028, 0.065 ], sizeEnd: 0.5, sizePow: 2,
        color: 0xffc46a, colorEnd: 0xff5d1e, hdr: 2.2, hdrEnd: 0.8,
        upSpeed: [ 0.25, 0.85 ], jitterSpeed: [ 0.1, 0.5 ],
        drag: 0.5, turb: 0.75, fadeIn: 0.18, fadePow: 1.5, flicker: 0.55, tint: true },
    ],
  },
};

/** Every preset name, in menu order. Handy for tooling and debug UI. */
export const PRESET_NAMES = Object.keys( PRESETS );

/* ====================================================================== */
/* Shared helpers                                                          */
/* ====================================================================== */

/** Reads a preset field that may be a scalar, a `[min,max]` range, or absent. */
function rv( v, d ) {
  if ( v === undefined || v === null ) return d;
  if ( typeof v === 'number' ) return v;
  return v[ 0 ] + Math.random() * ( v[ 1 ] - v[ 0 ] );
}

/** Cubic ease-out: fast off the line, decelerating. `p` is the strength. */
function easeOut( u, p ) {
  const inv = 1 - u;
  return 1 - ( p === 2 ? inv * inv : Math.pow( inv, p ) );
}

const _q = new THREE.Quaternion();
const _up = new THREE.Vector3( 0, 0, 1 );
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _size2 = new THREE.Vector2();
const _tmpVec = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _qb = new THREE.Quaternion();
const _upY = new THREE.Vector3( 0, 1, 0 );
const _rightX = new THREE.Vector3( 1, 0, 0 );

/* ====================================================================== */
/* ShockwaveRing                                                           */
/* ====================================================================== */

const ringVertex = /* glsl */ `
attribute vec3 aColor;
attribute vec3 aParams;      // x = alpha, y = thickness, z = squash
varying vec2 vUv;
varying vec3 vColor;
varying vec3 vParams;
void main() {
  vUv = uv;
  vColor = aColor;
  vParams = aParams;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
}
`;

const ringFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vColor;
varying vec3 vParams;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length( p );
  if ( d > 1.0 ) discard;

  float t = max( vParams.y, 0.004 );
  float r = 1.0 - t * 1.7;
  float e = abs( d - r );

  // A crisp band with a soft outer bleed, so the ring reads as a hard cel
  // shape but still has something for the bloom pass to catch.
  float a  = smoothstep( t, t * 0.28, e );
  a += smoothstep( t * 4.0, 0.0, e ) * 0.28;

  // Leading edge burns toward white.
  vec3 c = mix( vColor, vColor + vec3( 0.8 ), smoothstep( r * 0.9, 1.0, d ) * 0.7 );

  a *= vParams.x;
  if ( a <= 0.004 ) discard;
  gl_FragColor = vec4( c, a );
  #include <colorspace_fragment>
}
`;

/**
 * A pool of expanding shockwave rings drawn as ONE instanced draw call.
 *
 * Rings are flat discs oriented to an arbitrary normal (ground blasts use
 * `+Y`, wall impacts use the surface normal). Radius eases out hard — a
 * shockwave that expands linearly looks like a loading spinner.
 */
export class ShockwaveRing {
  constructor( scene, capacity = 16 ) {
    this.capacity = capacity;
    this.count = 0;
    this.scene = scene;

    const geo = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry( 2, 2 );
    geo.setAttribute( 'position', plane.attributes.position );
    geo.setAttribute( 'uv', plane.attributes.uv );
    geo.setIndex( plane.index );
    plane.dispose();

    this.aColor = new Float32Array( capacity * 3 );
    this.aParams = new Float32Array( capacity * 3 );
    geo.setAttribute( 'aColor', new THREE.InstancedBufferAttribute( this.aColor, 3 ).setUsage( THREE.DynamicDrawUsage ) );
    geo.setAttribute( 'aParams', new THREE.InstancedBufferAttribute( this.aParams, 3 ).setUsage( THREE.DynamicDrawUsage ) );
    geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial( {
      vertexShader: ringVertex,
      fragmentShader: ringFragment,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    } );

    this.mesh = new THREE.InstancedMesh( geo, mat, capacity );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );

    // CPU state.
    this.px = new Float32Array( capacity );
    this.py = new Float32Array( capacity );
    this.pz = new Float32Array( capacity );
    this.nx = new Float32Array( capacity );
    this.ny = new Float32Array( capacity );
    this.nz = new Float32Array( capacity );
    this.r0 = new Float32Array( capacity );
    this.r1 = new Float32Array( capacity );
    this.life = new Float32Array( capacity );
    this.maxLife = new Float32Array( capacity );
    this.delay = new Float32Array( capacity );
    this.thick = new Float32Array( capacity );
    this.squash = new Float32Array( capacity );
    this.pow = new Float32Array( capacity );

    if ( scene ) scene.add( this.mesh );
  }

  /**
   * @param {object} o  { position, normal, radius, startRadius, life, color,
   *                      hdr, thickness, delay, squash, ease }
   */
  spawn( o ) {
    let i;
    if ( this.count < this.capacity ) i = this.count++;
    else i = 0;                                     // recycle the oldest slot

    const p = o.position;
    this.px[ i ] = p ? ( p.x ?? 0 ) : 0;
    this.py[ i ] = p ? ( p.y ?? 0 ) : 0;
    this.pz[ i ] = p ? ( p.z ?? 0 ) : 0;
    const n = o.normal;
    this.nx[ i ] = n ? n.x : 0;
    this.ny[ i ] = n ? n.y : 1;
    this.nz[ i ] = n ? n.z : 0;
    this.r0[ i ] = o.startRadius ?? ( o.radius ?? 4 ) * 0.12;
    this.r1[ i ] = o.radius ?? 4;
    this.maxLife[ i ] = this.life[ i ] = o.life ?? 0.45;
    this.delay[ i ] = o.delay ?? 0;
    this.thick[ i ] = o.thickness ?? 0.06;
    this.squash[ i ] = o.squash ?? 1;
    this.pow[ i ] = o.ease ?? 3.0;

    _tmpColor.setHex( o.color ?? 0xffffff );
    const h = o.hdr ?? 3;
    const i3 = i * 3;
    this.aColor[ i3 ] = _tmpColor.r * h;
    this.aColor[ i3 + 1 ] = _tmpColor.g * h;
    this.aColor[ i3 + 2 ] = _tmpColor.b * h;
    this.aParams[ i3 ] = 0;
    this.aParams[ i3 + 1 ] = this.thick[ i ];
    this.aParams[ i3 + 2 ] = this.squash[ i ];
    return i;
  }

  update( dt ) {
    const mat = this.mesh.instanceMatrix.array;
    for ( let i = this.count - 1; i >= 0; i-- ) {
      if ( this.delay[ i ] > 0 ) {
        this.delay[ i ] -= dt;
        this.aParams[ i * 3 ] = 0;
        continue;
      }
      this.life[ i ] -= dt;
      if ( this.life[ i ] <= 0 ) { this._kill( i ); continue; }

      const u = 1 - this.life[ i ] / this.maxLife[ i ];
      const k = easeOut( u, this.pow[ i ] );
      const r = this.r0[ i ] + ( this.r1[ i ] - this.r0[ i ] ) * k;

      // Thin the band as it expands: constant world thickness on a growing
      // radius means the fraction has to shrink.
      const i3 = i * 3;
      this.aParams[ i3 ] = Math.pow( 1 - u, 2.2 );
      this.aParams[ i3 + 1 ] = Math.max( this.thick[ i ] * ( this.r1[ i ] / Math.max( r, 1e-3 ) ) * 0.35, 0.006 );

      _n.set( this.nx[ i ], this.ny[ i ], this.nz[ i ] ).normalize();
      _q.setFromUnitVectors( _up, _n );
      _s.set( r, r * this.squash[ i ], r );
      _m.compose( _tmpVec.set( this.px[ i ], this.py[ i ], this.pz[ i ] ), _q, _s );
      _m.toArray( mat, i * 16 );
    }
    this.mesh.count = this.count;
    this.mesh.geometry.instanceCount = this.count;
    if ( this.count > 0 ) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.geometry.attributes.aColor.needsUpdate = true;
      this.mesh.geometry.attributes.aParams.needsUpdate = true;
    }
  }

  _kill( i ) {
    const last = --this.count;
    if ( i === last ) return;
    const copy = ( a ) => { a[ i ] = a[ last ]; };
    copy( this.px ); copy( this.py ); copy( this.pz );
    copy( this.nx ); copy( this.ny ); copy( this.nz );
    copy( this.r0 ); copy( this.r1 );
    copy( this.life ); copy( this.maxLife ); copy( this.delay );
    copy( this.thick ); copy( this.squash ); copy( this.pow );
    const i3 = i * 3, l3 = last * 3;
    for ( let k = 0; k < 3; k++ ) {
      this.aColor[ i3 + k ] = this.aColor[ l3 + k ];
      this.aParams[ i3 + k ] = this.aParams[ l3 + k ];
    }
    const mat = this.mesh.instanceMatrix.array;
    for ( let k = 0; k < 16; k++ ) mat[ i * 16 + k ] = mat[ last * 16 + k ];
  }

  clear() { this.count = 0; this.mesh.count = 0; }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove( this.mesh );
  }
}

/* ====================================================================== */
/* GroundDecalPool                                                         */
/* ====================================================================== */

const decalVertex = /* glsl */ `
attribute vec3 aColor;
attribute vec4 aParams;      // x = alpha, y = type, z = seed, w = spare
varying vec2 vUv;
varying vec3 vColor;
varying vec4 vParams;
void main() {
  vUv = uv;
  vColor = aColor;
  vParams = aParams;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
}
`;

const decalFragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vColor;
varying vec4 vParams;
const float TAU = 6.2831853;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length( p );
  if ( d > 1.0 ) discard;

  float seed = vParams.z * TAU;
  float ang = atan( p.y, p.x );
  float type = vParams.y;
  float a = 0.0;
  vec3 c = vColor;

  // A wobbling radius keeps every decal from being a perfect circle stamp.
  float wob = 0.80
    + 0.13 * sin( ang * 3.0 + seed )
    + 0.08 * sin( ang * 5.0 - seed * 1.6 )
    + 0.05 * sin( ang * 8.0 + seed * 2.3 );

  if ( type < 0.5 ) {
    // ---- BULLET: a dark chip with a dusty ring and short radial cracks ---
    float core = 1.0 - smoothstep( 0.24 * wob, 0.46 * wob, d );
    float halo = ( 1.0 - smoothstep( 0.35, 1.0, d ) ) * 0.30;
    float spokes = pow( abs( sin( ang * 3.0 + seed ) ), 22.0 )
                 * ( 1.0 - smoothstep( 0.25, 0.95, d ) ) * 0.55;
    a = core + halo + spokes;
    c = mix( vColor * 1.9, vColor, core );      // dusty rim, dark centre

  } else if ( type < 1.5 ) {
    // ---- SCORCH: soft blast mark, denser toward the middle --------------
    float body = 1.0 - smoothstep( 0.10, 1.0, d / max( wob, 0.05 ) );
    a = pow( body, 1.35 );
    float mottle = 0.5 + 0.5 * sin( d * 22.0 + seed * 3.0 ) * sin( ang * 4.0 - seed );
    a *= mix( 0.78, 1.0, mottle );
    c = mix( vColor * 2.4, vColor, pow( body, 0.6 ) );

  } else if ( type < 2.5 ) {
    // ---- CRACK: spider fracture, for heavy impacts -----------------------
    float arms = pow( abs( sin( ang * 4.0 + seed ) ), 40.0 );
    float taper = 1.0 - smoothstep( 0.05, 1.0, d );
    a = arms * taper * 1.4 + ( 1.0 - smoothstep( 0.0, 0.22, d ) ) * 0.9;
    float ring = smoothstep( 0.02, 0.0, abs( d - 0.42 * wob ) ) * 0.5;
    a += ring * taper;

  } else {
    // ---- RUNE: hex sigil, additive; skill circles and summon markers -----
    vec2 ap = abs( p );
    float hx = max( ap.x * 0.8660254 + ap.y * 0.5, ap.y );
    float outer = smoothstep( 0.02, 0.0, abs( hx - 0.92 ) );
    float inner = smoothstep( 0.02, 0.0, abs( hx - 0.62 ) ) * 0.7;
    float ticks = pow( abs( sin( ang * 6.0 ) ), 30.0 )
                * ( 1.0 - smoothstep( 0.62, 0.92, d ) ) * smoothstep( 0.30, 0.55, d );
    float dot0 = exp( -d * d * 60.0 ) * 0.8;
    a = outer + inner + ticks + dot0;
    c = mix( vColor, vColor + vec3( 0.5 ), outer );
  }

  a *= vParams.x;
  if ( a <= 0.004 ) discard;
  gl_FragColor = vec4( c, clamp( a, 0.0, 1.0 ) );
  #include <colorspace_fragment>
}
`;

export const DECAL_TYPE = { bullet: 0, scorch: 1, crack: 2, rune: 3 };

/**
 * Pooled ground decals: bullet chips, scorch marks, fracture spiders and
 * additive skill sigils. Two instanced draw calls total (one multiply-ish
 * dark pass, one additive pass), a fixed capacity, and oldest-out recycling.
 *
 * Decals lie in the XZ plane and are lifted a hair off `y = 0` with a
 * per-slot bias so overlapping marks never z-fight.
 */
export class GroundDecalPool {
  constructor( scene, capacity = 48 ) {
    this.capacity = capacity;
    this.scene = scene;
    this.dark = this._makeLayer( capacity, THREE.NormalBlending, 3 );
    this.glow = this._makeLayer( Math.max( 8, capacity >> 2 ), THREE.AdditiveBlending, 4 );
    if ( scene ) { scene.add( this.dark.mesh ); scene.add( this.glow.mesh ); }
  }

  _makeLayer( capacity, blending, renderOrder ) {
    const geo = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry( 2, 2 );
    geo.setAttribute( 'position', plane.attributes.position );
    geo.setAttribute( 'uv', plane.attributes.uv );
    geo.setIndex( plane.index );
    plane.dispose();

    const aColor = new Float32Array( capacity * 3 );
    const aParams = new Float32Array( capacity * 4 );
    geo.setAttribute( 'aColor', new THREE.InstancedBufferAttribute( aColor, 3 ).setUsage( THREE.DynamicDrawUsage ) );
    geo.setAttribute( 'aParams', new THREE.InstancedBufferAttribute( aParams, 4 ).setUsage( THREE.DynamicDrawUsage ) );
    geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial( {
      vertexShader: decalVertex,
      fragmentShader: decalFragment,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    } );

    const mesh = new THREE.InstancedMesh( geo, mat, capacity );
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );

    return {
      capacity, count: 0, mesh, aColor, aParams,
      life: new Float32Array( capacity ),
      maxLife: new Float32Array( capacity ),
      fade: new Float32Array( capacity ),
      grow: new Float32Array( capacity ),
      op: new Float32Array( capacity ),
      radius: new Float32Array( capacity ),
      px: new Float32Array( capacity ),
      pz: new Float32Array( capacity ),
      py: new Float32Array( capacity ),
      rot: new Float32Array( capacity ),
    };
  }

  /**
   * @param {object} o { position, type, radius, color, opacity, life, hdr,
   *                     grow, rotation }
   */
  spawn( o ) {
    const type = typeof o.type === 'string' ? ( DECAL_TYPE[ o.type ] ?? 0 ) : ( o.type ?? 0 );
    const L = type >= 3 ? this.glow : this.dark;
    let i;
    if ( L.count < L.capacity ) i = L.count++;
    else i = 0;

    const p = o.position;
    L.px[ i ] = p ? ( p.x ?? 0 ) : 0;
    L.pz[ i ] = p ? ( p.z ?? 0 ) : 0;
    L.py[ i ] = ( o.y ?? 0.012 ) + ( i % 16 ) * 0.0009;
    L.radius[ i ] = o.radius ?? 0.4;
    L.rot[ i ] = o.rotation ?? Math.random() * TAU;
    L.maxLife[ i ] = L.life[ i ] = o.life ?? 10;
    L.fade[ i ] = o.fade ?? Math.min( 1.6, ( o.life ?? 10 ) * 0.35 );
    L.grow[ i ] = o.grow ?? 0;
    L.op[ i ] = o.opacity ?? 0.6;

    _tmpColor.setHex( o.color ?? 0x2b2138 );
    const h = o.hdr ?? 1;
    const i3 = i * 3;
    L.aColor[ i3 ] = _tmpColor.r * h;
    L.aColor[ i3 + 1 ] = _tmpColor.g * h;
    L.aColor[ i3 + 2 ] = _tmpColor.b * h;
    const i4 = i * 4;
    L.aParams[ i4 ] = L.op[ i ];
    L.aParams[ i4 + 1 ] = type;
    L.aParams[ i4 + 2 ] = Math.random();
    L.aParams[ i4 + 3 ] = 0;
    this._writeMatrix( L, i, L.radius[ i ] );
    return i;
  }

  _writeMatrix( L, i, r ) {
    _q.setFromAxisAngle( _upY, L.rot[ i ] );
    _qb.setFromAxisAngle( _rightX, -Math.PI * 0.5 );
    _q.multiply( _qb );
    _s.set( r, r, r );
    _m.compose( _tmpVec.set( L.px[ i ], L.py[ i ], L.pz[ i ] ), _q, _s );
    _m.toArray( L.mesh.instanceMatrix.array, i * 16 );
  }

  update( dt ) {
    this._updateLayer( this.dark, dt );
    this._updateLayer( this.glow, dt );
  }

  _updateLayer( L, dt ) {
    for ( let i = L.count - 1; i >= 0; i-- ) {
      L.life[ i ] -= dt;
      if ( L.life[ i ] <= 0 ) { this._kill( L, i ); continue; }
      const rem = L.life[ i ];
      const f = L.fade[ i ];
      let a = L.op[ i ];
      if ( rem < f ) { const w = rem / f; a *= w * w; }
      const u = 1 - rem / L.maxLife[ i ];
      // A blast mark keeps creeping outward for a beat after the flash.
      if ( L.grow[ i ] > 0 ) {
        const r = L.radius[ i ] * ( 1 + L.grow[ i ] * easeOut( Math.min( u * 6, 1 ), 2.2 ) );
        this._writeMatrix( L, i, r );
      }
      L.aParams[ i * 4 ] = a;
    }
    L.mesh.count = L.count;
    L.mesh.geometry.instanceCount = L.count;
    if ( L.count > 0 ) {
      L.mesh.instanceMatrix.needsUpdate = true;
      L.mesh.geometry.attributes.aColor.needsUpdate = true;
      L.mesh.geometry.attributes.aParams.needsUpdate = true;
    }
  }

  _kill( L, i ) {
    const last = --L.count;
    if ( i === last ) return;
    const cp = ( a ) => { a[ i ] = a[ last ]; };
    cp( L.life ); cp( L.maxLife ); cp( L.fade ); cp( L.grow );
    cp( L.op ); cp( L.radius ); cp( L.px ); cp( L.py ); cp( L.pz ); cp( L.rot );
    for ( let k = 0; k < 3; k++ ) L.aColor[ i * 3 + k ] = L.aColor[ last * 3 + k ];
    for ( let k = 0; k < 4; k++ ) L.aParams[ i * 4 + k ] = L.aParams[ last * 4 + k ];
    const m = L.mesh.instanceMatrix.array;
    for ( let k = 0; k < 16; k++ ) m[ i * 16 + k ] = m[ last * 16 + k ];
  }

  clear() {
    this.dark.count = 0; this.dark.mesh.count = 0;
    this.glow.count = 0; this.glow.mesh.count = 0;
  }

  dispose() {
    for ( const L of [ this.dark, this.glow ] ) {
      L.mesh.geometry.dispose();
      L.mesh.material.dispose();
      L.mesh.parent?.remove( L.mesh );
    }
  }
}

/* ====================================================================== */
/* BeamTrail                                                               */
/* ====================================================================== */

const trailVertex = /* glsl */ `
precision highp float;
uniform float uLife;
uniform float uWidth;
attribute vec3  aSide;      // unit side vector, already signed by cross
attribute float aAge;
attribute float aCross;     // -1 .. 1 across the ribbon
attribute float aWidth;
varying float vFade;
varying float vCross;
void main() {
  float age = clamp( aAge / uLife, 0.0, 1.0 );
  // The ribbon narrows as it ages, so a dead segment collapses to a
  // zero-area sliver instead of needing to be removed from the buffer.
  float taper = pow( 1.0 - age, 0.55 );
  vec3 p = position + aSide * ( aWidth * uWidth * taper );
  vFade = 1.0 - age;
  vCross = aCross;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}
`;

const trailFragment = /* glsl */ `
precision highp float;
uniform vec3  uColor;
uniform vec3  uColorEnd;
uniform float uOpacity;
varying float vFade;
varying float vCross;
void main() {
  if ( vFade <= 0.001 ) discard;
  float x = abs( vCross );
  // Hard-ish core with a soft shoulder: reads as a drawn stroke, not a blur.
  float body = pow( 1.0 - x, 1.5 );
  float core = exp( -x * x * 10.0 );
  float a = ( body * 0.75 + core * 0.7 ) * pow( vFade, 1.8 ) * uOpacity;
  if ( a <= 0.004 ) discard;
  vec3 c = mix( uColorEnd, uColor, vFade );
  c = mix( c, c + vec3( 0.9 ), core * 0.55 );
  gl_FragColor = vec4( c, a );
  #include <colorspace_fragment>
}
`;

/**
 * A camera-facing ribbon on a rolling vertex buffer.
 *
 * The geometry is allocated once as `segments` independent quads. `push()`
 * overwrites ONE quad in place — the oldest slot — and bumps a head index.
 * Nothing is ever rebuilt, re-indexed or reallocated; the per-frame work is
 * writing one float per vertex (the age) so old segments taper themselves out
 * of existence.
 *
 * Side vectors are computed at write time against the camera and the previous
 * segment's side is reused for the shared edge, so consecutive quads join
 * seamlessly instead of showing a crease.
 */
export class BeamTrail {
  constructor( options = {} ) {
    const segments = this.segments = options.segments ?? 48;
    this.life = options.life ?? 0.22;
    this.width = options.width ?? 0.22;
    this.maxStep = options.maxStep ?? 0.6;
    this.opacity = options.opacity ?? 1;

    const verts = segments * 6;
    this.pos = new Float32Array( verts * 3 );
    this.side = new Float32Array( verts * 3 );
    this.age = new Float32Array( verts );
    this.cross = new Float32Array( verts );
    this.wide = new Float32Array( verts );
    this.segAge = new Float32Array( segments );
    this.segAge.fill( 1e9 );
    this.age.fill( 1e9 );

    const geo = new THREE.BufferGeometry();
    const attr = ( a, n ) => {
      const b = new THREE.BufferAttribute( a, n );
      b.setUsage( THREE.DynamicDrawUsage );
      return b;
    };
    geo.setAttribute( 'position', attr( this.pos, 3 ) );
    geo.setAttribute( 'aSide', attr( this.side, 3 ) );
    geo.setAttribute( 'aAge', attr( this.age, 1 ) );
    geo.setAttribute( 'aCross', attr( this.cross, 1 ) );
    geo.setAttribute( 'aWidth', attr( this.wide, 1 ) );
    geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );

    const c0 = new THREE.Color().setHex( options.color ?? 0x7fd6ff );
    const c1 = new THREE.Color().setHex( options.colorEnd ?? options.color ?? 0x35a3ea );
    const h0 = options.hdr ?? 4.0;
    const h1 = options.hdrEnd ?? 1.2;

    this.material = new THREE.ShaderMaterial( {
      vertexShader: trailVertex,
      fragmentShader: trailFragment,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: options.blending ?? THREE.AdditiveBlending,
      uniforms: {
        uLife: { value: this.life },
        uWidth: { value: this.width },
        uOpacity: { value: this.opacity },
        uColor: { value: c0.multiplyScalar( h0 ) },
        uColorEnd: { value: c1.multiplyScalar( h1 ) },
      },
    } );

    this.geometry = geo;
    this.mesh = new THREE.Mesh( geo, this.material );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = options.renderOrder ?? 8;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.object3D = this.mesh;

    this.head = -1;
    this._hasPrev = false;
    this._hasSide = false;
    this._dirty = false;
    this._lastX = 0; this._lastY = 0; this._lastZ = 0;
    this._sx = 0; this._sy = 1; this._sz = 0;
    this._camera = null;
    this.alive = true;
  }

  /** Restarts the ribbon at the next `push()` without touching allocation. */
  reset() {
    this.segAge.fill( 1e9 );
    this.age.fill( 1e9 );
    this.geometry.attributes.aAge.needsUpdate = true;
    this._hasPrev = false;
    this._hasSide = false;
    this.head = -1;
  }

  setColor( color, hdr = 4.0, colorEnd = color, hdrEnd = 1.2 ) {
    this.material.uniforms.uColor.value.setHex( color ).multiplyScalar( hdr );
    this.material.uniforms.uColorEnd.value.setHex( colorEnd ).multiplyScalar( hdrEnd );
  }

  /**
   * Appends a point. Long jumps are subdivided so a fast projectile still
   * draws a smooth ribbon instead of a chunky polyline.
   */
  push( p, camera ) {
    const cam = camera ?? this._camera;
    const x = p.x, y = p.y, z = p.z;
    if ( !this._hasPrev ) {
      this._lastX = x; this._lastY = y; this._lastZ = z;
      this._hasPrev = true;
      return;
    }
    const dx = x - this._lastX, dy = y - this._lastY, dz = z - this._lastZ;
    const len = Math.sqrt( dx * dx + dy * dy + dz * dz );
    if ( len < 1e-5 ) return;
    const steps = Math.min( 8, Math.max( 1, Math.ceil( len / this.maxStep ) ) );
    for ( let s = 1; s <= steps; s++ ) {
      const t = s / steps;
      this._segment( x - dx * ( 1 - t ), y - dy * ( 1 - t ), z - dz * ( 1 - t ), cam );
    }
  }

  /** Writes one quad between the current ribbon tip and (x,y,z). */
  _segment( x, y, z, cam ) {
    const p0x = this._lastX, p0y = this._lastY, p0z = this._lastZ;
    const ax = x - p0x, ay = y - p0y, az = z - p0z;

    // Side = axis x view, so the ribbon always faces the camera.
    let vx = 0, vy = 1, vz = 0;
    if ( cam ) {
      vx = cam.position.x - x; vy = cam.position.y - y; vz = cam.position.z - z;
    }
    let sx = ay * vz - az * vy;
    let sy = az * vx - ax * vz;
    let sz = ax * vy - ay * vx;
    let sl = Math.sqrt( sx * sx + sy * sy + sz * sz );
    if ( sl < 1e-6 ) { sx = 1; sy = 0; sz = 0; sl = 1; }
    sx /= sl; sy /= sl; sz /= sl;

    // Reuse the previous segment's side vector for the shared edge so the
    // ribbon joins without a visible crease.
    let q0x = this._sx, q0y = this._sy, q0z = this._sz;
    if ( !this._hasSide ) { q0x = sx; q0y = sy; q0z = sz; this._hasSide = true; }

    const slot = this.head = ( this.head + 1 ) % this.segments;
    const base = slot * 6;
    this._writeVertex( base + 0, p0x, p0y, p0z, q0x, q0y, q0z, -1 );
    this._writeVertex( base + 1, p0x, p0y, p0z, q0x, q0y, q0z, 1 );
    this._writeVertex( base + 2, x, y, z, sx, sy, sz, 1 );
    this._writeVertex( base + 3, p0x, p0y, p0z, q0x, q0y, q0z, -1 );
    this._writeVertex( base + 4, x, y, z, sx, sy, sz, 1 );
    this._writeVertex( base + 5, x, y, z, sx, sy, sz, -1 );

    this.segAge[ slot ] = 0;
    this._sx = sx; this._sy = sy; this._sz = sz;
    this._lastX = x; this._lastY = y; this._lastZ = z;
    this._dirty = true;
  }

  _writeVertex( vi, px, py, pz, ux, uy, uz, cr ) {
    const i3 = vi * 3;
    this.pos[ i3 ] = px; this.pos[ i3 + 1 ] = py; this.pos[ i3 + 2 ] = pz;
    this.side[ i3 ] = ux * cr; this.side[ i3 + 1 ] = uy * cr; this.side[ i3 + 2 ] = uz * cr;
    this.cross[ vi ] = cr;
    this.wide[ vi ] = 1;
    this.age[ vi ] = 0;
  }

  update( dt, camera ) {
    if ( camera ) this._camera = camera;
    const seg = this.segments;
    const life = this.life;
    let live = 0;
    for ( let s = 0; s < seg; s++ ) {
      const a = this.segAge[ s ] + dt;
      this.segAge[ s ] = a;
      if ( a < life ) live++;
      const base = s * 6;
      for ( let k = 0; k < 6; k++ ) this.age[ base + k ] = a;
    }
    this.geometry.attributes.aAge.needsUpdate = true;
    if ( this._dirty ) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aSide.needsUpdate = true;
      this.geometry.attributes.aCross.needsUpdate = true;
      this.geometry.attributes.aWidth.needsUpdate = true;
      this._dirty = false;
    }
    this.mesh.visible = live > 0;
    this.liveSegments = live;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove( this.mesh );
    this.alive = false;
  }
}

/* ====================================================================== */
/* DamageFlash                                                             */
/* ====================================================================== */

const flashVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // Screen-space quad: ignore the camera entirely so this always covers the
  // frame no matter where it sits in the graph.
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const flashFragment = /* glsl */ `
precision highp float;
uniform vec3  uColor;
uniform float uAmount;
uniform float uEdge;
uniform float uFull;
uniform vec2  uDir;
uniform float uDirStrength;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec2 e = vec2( p.x * uAspect, p.y ) / max( uAspect, 1.0 );
  float r = length( e );

  // A vignette-shaped bloom around the frame edge: reads instantly as "you
  // took a hit" without covering the thing the player is aiming at.
  float edge = smoothstep( uEdge, 1.05, r );
  edge = pow( edge, 1.6 );

  // Optional directional bias so the flash points at whatever hit you.
  float bias = 1.0;
  if ( uDirStrength > 0.0 ) {
    vec2 nd = normalize( p + vec2( 1e-5 ) );
    bias = mix( 1.0, clamp( 0.15 + 0.85 * ( 0.5 + 0.5 * dot( nd, uDir ) ), 0.0, 1.0 ) * 1.9, uDirStrength );
  }

  float a = ( edge * bias + uFull ) * uAmount;
  if ( a <= 0.002 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
  #include <colorspace_fragment>
}
`;

/**
 * Full-frame damage / heal / skill flash.
 *
 * Drawn as a screen-space quad inside the main scene so it goes through the
 * bloom pass with everything else — an HDR coral edge-vignette blooms into
 * the frame the way a hit indicator should, which a DOM overlay cannot do.
 * Decay is cubic: it snaps off rather than dissolving.
 */
export class DamageFlash {
  constructor( scene ) {
    const geo = new THREE.PlaneGeometry( 2, 2 );
    this.material = new THREE.ShaderMaterial( {
      vertexShader: flashVertex,
      fragmentShader: flashFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color( 0xff5d6c ) },
        uAmount: { value: 0 },
        uEdge: { value: 0.42 },
        uFull: { value: 0 },
        uDir: { value: new THREE.Vector2( 0, 1 ) },
        uDirStrength: { value: 0 },
        uAspect: { value: 1.78 },
      },
    } );
    this.mesh = new THREE.Mesh( geo, this.material );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 990;
    this.mesh.visible = false;
    this.object3D = this.mesh;
    this.amount = 0;
    this.decay = 4.5;
    this.hold = 0;
    if ( scene ) scene.add( this.mesh );
  }

  setAspect( a ) { this.material.uniforms.uAspect.value = a; }

  /**
   * @param {number} color   flash tint (coral for damage, mint for heal)
   * @param {number} amount  peak intensity — go above 1 to blow out and bloom
   * @param {number} decay   1/seconds; 4.5 ≈ a 0.22 s snap
   * @param {object} o       { edge, full, hold, dir:{x,y}, dirStrength }
   */
  flash( color = 0xff5d6c, amount = 1.1, decay = 4.5, o = null ) {
    const u = this.material.uniforms;
    u.uColor.value.setHex( color );
    u.uEdge.value = o?.edge ?? 0.42;
    u.uFull.value = o?.full ?? 0;
    u.uDirStrength.value = o?.dirStrength ?? 0;
    if ( o?.dir ) {
      const l = Math.hypot( o.dir.x, o.dir.y ) || 1;
      u.uDir.value.set( o.dir.x / l, o.dir.y / l );
    }
    this.amount = Math.max( this.amount, amount );
    this.decay = decay;
    this.hold = o?.hold ?? 0;
    this.mesh.visible = true;
  }

  update( dt ) {
    if ( this.amount <= 0 ) { this.mesh.visible = false; return; }
    if ( this.hold > 0 ) this.hold -= dt;
    else this.amount = Math.max( 0, this.amount - dt * this.decay * ( 0.35 + this.amount ) );
    this.material.uniforms.uAmount.value = this.amount;
    this.mesh.visible = this.amount > 0.002;
  }

  clear() { this.amount = 0; this.hold = 0; this.mesh.visible = false; }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove( this.mesh );
  }
}

/* ====================================================================== */
/* ParticleSystem                                                          */
/* ====================================================================== */

const QUALITY = [
  // 0 = potato                      1 = balanced                    2 = maximum
  { budget: 0.34, count: 0.45, size: 1.06, intensity: 0.92, ambient: 0.30, decals: 0.4, rings: true },
  { budget: 0.72, count: 0.78, size: 1.02, intensity: 0.97, ambient: 0.70, decals: 0.8, rings: true },
  { budget: 1.00, count: 1.00, size: 1.00, intensity: 1.00, ambient: 1.00, decals: 1.0, rings: true },
];

const GRAVITY = 9.81;

/**
 * The VFX front end.
 *
 * Owns two pooled `THREE.Points` (additive + alpha), a shockwave ring pool, a
 * ground decal pool, the screen flash and any beam trails handed out by
 * `createTrail()`. One `update( dt, camera )` drives the whole layer.
 *
 * ```js
 * const vfx = new ParticleSystem( scene, { renderer, camera, capacity: 4000 } );
 * vfx.emit( 'impactMetal', { position: hit, direction: normal } );
 * vfx.update( dt, camera );
 * ```
 */
export class ParticleSystem {
  constructor( scene, options = {} ) {
    this.scene = scene;
    this.renderer = options.renderer ?? null;
    this.capacity = options.capacity ?? 4000;
    this.groundY = options.groundY ?? 0;
    this.gravity = options.gravity ?? GRAVITY;
    this.time = 0;
    this.enabled = true;

    // Additive carries every glowing layer, alpha carries smoke and debris.
    // Splitting by blend mode is what keeps the whole system at two draws.
    const addCap = Math.round( this.capacity * 0.62 );
    const alphaCap = this.capacity - addCap;
    this.add = new ParticlePool( addCap, THREE.AdditiveBlending, 6 );
    this.alpha = new ParticlePool( alphaCap, THREE.NormalBlending, 5 );
    this.add.material.uniforms.uDepthBias.value = options.depthBias ?? 0.55;
    this.alpha.material.uniforms.uDepthBias.value = ( options.depthBias ?? 0.55 ) * 0.45;

    this.rings = new ShockwaveRing( scene, options.rings ?? 16 );
    this.decals = new GroundDecalPool( scene, options.decals ?? 48 );
    this.damageFlash = new DamageFlash( scene );
    this.trails = [];

    if ( scene ) {
      scene.add( this.alpha.points );
      scene.add( this.add.points );
    }

    // Hardware point-size ceiling. Exceeding it silently clamps, so query it
    // once and let the vertex shader clamp to the real limit.
    let maxPoint = 700;
    if ( this.renderer ) {
      try {
        const gl = this.renderer.getContext();
        const range = gl.getParameter( gl.ALIASED_POINT_SIZE_RANGE );
        if ( range && range[ 1 ] > 1 ) maxPoint = Math.min( 2048, range[ 1 ] );
      } catch { /* keep the default */ }
    }
    this.maxPoint = maxPoint;
    this.add.material.uniforms.uMaxPoint.value = maxPoint;
    this.alpha.material.uniforms.uMaxPoint.value = maxPoint;

    this.viewportHeight = options.viewportHeight ?? 900;
    this._userColor = new THREE.Color();
    this._hasUserColor = false;
    this._ambient = [];
    // Reused payload objects so emit() never allocates.
    this._ringOpts = {
      position: null, normal: null, radius: 4, startRadius: 0.4, life: 0.45,
      color: 0xffffff, hdr: 3, thickness: 0.06, delay: 0, squash: 1, ease: 3,
    };
    this._decalOpts = {
      position: null, type: 0, radius: 0.3, color: 0x2b2138, opacity: 0.6,
      life: 10, grow: 0, hdr: 1, y: undefined, fade: undefined, rotation: undefined,
    };
    this.stats = { live: 0, peak: 0, add: 0, alpha: 0, dropped: 0, emits: 0 };

    this.setQuality( options.quality ?? 2 );
    if ( options.camera ) this.syncCamera( options.camera );
  }

  /* ---- configuration ------------------------------------------------- */

  /** 0 = potato, 1 = balanced, 2 = maximum. Scales budget, counts and size. */
  setQuality( level ) {
    const q = QUALITY[ Math.max( 0, Math.min( 2, level | 0 ) ) ];
    this.quality = Math.max( 0, Math.min( 2, level | 0 ) );
    this.budgetAdd = Math.round( this.add.capacity * q.budget );
    this.budgetAlpha = Math.round( this.alpha.capacity * q.budget );
    this.countScale = q.count;
    this.ambientScale = q.ambient;
    this.decalScale = q.decals;
    this.add.material.uniforms.uSizeScale.value = q.size;
    this.alpha.material.uniforms.uSizeScale.value = q.size;
    this.add.material.uniforms.uIntensity.value = q.intensity;
    this.alpha.material.uniforms.uIntensity.value = q.intensity;
    this.rings.mesh.visible = q.rings;
    return this;
  }

  /** Call on resize so point sizes stay physically correct. */
  setSize( width, height, pixelRatio = 1 ) {
    this.viewportHeight = height * pixelRatio;
    const inv = this.add.material.uniforms.uInvResolution.value;
    inv.set( 1 / Math.max( 1, width * pixelRatio ), 1 / Math.max( 1, height * pixelRatio ) );
    this.alpha.material.uniforms.uInvResolution.value.copy( inv );
    this.damageFlash.setAspect( width / Math.max( 1, height ) );
    return this;
  }

  /** Pulls projection scale and clip planes off the active camera. */
  syncCamera( camera ) {
    let h = this.viewportHeight;
    if ( this.renderer ) {
      this.renderer.getDrawingBufferSize( _size2 );
      if ( _size2.y > 1 ) h = _size2.y;
    }
    const projScale = 0.5 * h * camera.projectionMatrix.elements[ 5 ];
    for ( const p of [ this.add, this.alpha ] ) {
      const u = p.material.uniforms;
      u.uProjScale.value = projScale;
      u.uCameraNear.value = camera.near;
      u.uCameraFar.value = camera.far;
      u.uFadeNear.value = camera.near * 2.5;
    }
  }

  /**
   * Enables soft particles. Pass the scene depth texture; smoke then dissolves
   * where it intersects geometry instead of showing a hard cut on the floor.
   */
  setDepthTexture( texture, softness = 0.6 ) {
    for ( const p of [ this.add, this.alpha ] ) {
      p.material.uniforms.uDepthTexture.value = texture ?? null;
      p.material.uniforms.uSoftness.value = softness;
      const want = texture ? 1 : 0;
      const has = p.material.defines?.SOFT_DEPTH ? 1 : 0;
      if ( want !== has ) {
        p.material.defines = texture ? { SOFT_DEPTH: '' } : {};
        p.material.needsUpdate = true;
      }
    }
    return this;
  }

  /* ---- emission ------------------------------------------------------ */

  /**
   * Fires a preset.
   *
   * @param {string} preset  a key of `PRESET_NAMES`
   * @param {object} o
   *   `position`  {x,y,z} world spawn point (default origin)
   *   `direction` {x,y,z} aim / surface normal (default +Y)
   *   `count`     multiplier on every layer's particle count (default 1)
   *   `scale`     multiplier on sizes, offsets and speeds (default 1)
   *   `color`     hex or THREE.Color, recolours layers marked `tint`
   */
  emit( preset, o ) {
    const P = typeof preset === 'string' ? PRESETS[ preset ] : preset;
    if ( !P || !this.enabled ) return this;

    const pos = o?.position;
    const px = pos ? ( pos.x ?? 0 ) : 0;
    const py = pos ? ( pos.y ?? 0 ) : 0;
    const pz = pos ? ( pos.z ?? 0 ) : 0;

    // Orthonormal frame around the aim direction, used by every cone layer.
    let dx = 0, dy = 1, dz = 0;
    const d = o?.direction;
    if ( d ) {
      dx = d.x ?? 0; dy = d.y ?? 0; dz = d.z ?? 0;
      const l = Math.sqrt( dx * dx + dy * dy + dz * dz );
      if ( l > 1e-6 ) { dx /= l; dy /= l; dz /= l; } else { dx = 0; dy = 1; dz = 0; }
    }
    let ux = 0, uy = 1, uz = 0;
    if ( Math.abs( dy ) > 0.94 ) { ux = 1; uy = 0; uz = 0; }
    let t1x = uy * dz - uz * dy, t1y = uz * dx - ux * dz, t1z = ux * dy - uy * dx;
    let tl = Math.sqrt( t1x * t1x + t1y * t1y + t1z * t1z ) || 1;
    t1x /= tl; t1y /= tl; t1z /= tl;
    const t2x = dy * t1z - dz * t1y, t2y = dz * t1x - dx * t1z, t2z = dx * t1y - dy * t1x;

    const scale = o?.scale ?? 1;
    const countMul = o?.count ?? 1;
    this._hasUserColor = o?.color !== undefined && o?.color !== null;
    if ( this._hasUserColor ) {
      if ( typeof o.color === 'number' ) this._userColor.setHex( o.color );
      else this._userColor.copy( o.color );
    }

    const layers = P.layers;
    for ( let li = 0; li < layers.length; li++ ) {
      const layer = layers[ li ];
      if ( ( layer.minQuality ?? 0 ) > this.quality ) continue;
      // Flash frames are never thinned by quality — losing the key pose of an
      // effect is far worse than losing a dozen sparks.
      const n = layer.count === 1
        ? Math.max( 1, Math.round( countMul ) )
        : Math.max( 1, Math.round( layer.count * countMul * this.countScale ) );
      this._spawnLayer( layer, n, px, py, pz, dx, dy, dz, t1x, t1y, t1z, t2x, t2y, t2z, scale );
    }

    if ( P.shockwave ) {
      const sw = P.shockwave;
      this.rings.spawn( this._fillRing( sw, px, py, pz, dx, dy, dz, scale ) );
    }
    if ( P.decal && this.decalScale > 0 ) {
      const dc = P.decal;
      const dOpt = this._decalOpts;
      _tmpVec.set( px, py, pz );
      dOpt.position = _tmpVec;
      dOpt.type = dc.type;
      dOpt.radius = rv( dc.radius, 0.3 ) * scale;
      dOpt.color = dc.color ?? 0x2b2138;
      dOpt.opacity = ( dc.opacity ?? 0.6 ) * ( 0.6 + 0.4 * this.decalScale );
      dOpt.life = dc.life ?? 10;
      dOpt.grow = dc.grow ?? 0;
      dOpt.hdr = dc.hdr ?? 1;
      dOpt.y = undefined;
      dOpt.fade = undefined;
      dOpt.rotation = undefined;
      // Only stamp decals that actually land on the ground plane.
      if ( Math.abs( py - this.groundY ) < 0.6 ) this.decals.spawn( dOpt );
    }
    this.stats.emits++;
    return this;
  }

  _fillRing( sw, px, py, pz, dx, dy, dz, scale ) {
    const r = this._ringOpts;
    _tmpVec.set( px, py + ( sw.y ?? 0.05 ), pz );
    _tmpVecB.set( sw.normal ? sw.normal.x : 0, sw.normal ? sw.normal.y : 1, sw.normal ? sw.normal.z : 0 );
    r.position = _tmpVec;
    r.normal = _tmpVecB;
    r.radius = ( sw.radius ?? 4 ) * scale;
    r.startRadius = ( sw.startRadius ?? ( sw.radius ?? 4 ) * 0.10 ) * scale;
    r.life = sw.life ?? 0.45;
    r.color = sw.color ?? 0xffffff;
    r.hdr = sw.hdr ?? 3;
    r.thickness = sw.thickness ?? 0.06;
    r.delay = sw.delay ?? 0;
    r.squash = sw.squash ?? 1;
    r.ease = sw.ease ?? 3.0;
    return r;
  }

  _spawnLayer( layer, n, px, py, pz, dx, dy, dz, t1x, t1y, t1z, t2x, t2y, t2z, scale ) {
    const alphaPool = layer.pool === 'alpha';
    const pool = alphaPool ? this.alpha : this.add;
    const budget = alphaPool ? this.budgetAlpha : this.budgetAdd;
    const shape = layer.shape ?? 0;

    // Colour endpoints are resolved once per layer, not per particle.
    _tmpColor.setHex( layer.color ?? 0xffffff );
    if ( layer.tint && this._hasUserColor ) _tmpColor.lerp( this._userColor, 0.5 );
    const h0 = layer.hdr ?? 1;
    const c0r = _tmpColor.r * h0, c0g = _tmpColor.g * h0, c0b = _tmpColor.b * h0;

    _tmpColorB.setHex( layer.colorEnd ?? layer.color ?? 0xffffff );
    if ( layer.tint && this._hasUserColor ) _tmpColorB.lerp( this._userColor, 0.92 );
    const h1 = layer.hdrEnd ?? h0;
    const c1r = _tmpColorB.r * h1, c1g = _tmpColorB.g * h1, c1b = _tmpColorB.b * h1;

    const drag = layer.drag ?? 0;
    const grav = layer.gravity ?? 0;
    const rest = layer.restitution ?? -1;
    const fric = layer.friction ?? 0.7;
    const turb = layer.turb ?? 0;
    const flick = layer.flicker ?? 0;
    const sizeEnd = layer.sizeEnd ?? 1;
    const sizePow = layer.sizePow ?? 2;
    const fadeIn = layer.fadeIn ?? 0;
    const fadePow = layer.fadePow ?? 2;
    const cone = layer.cone ?? 0;
    const defParam = shape === SHAPE.RING ? 0.15
      : shape === SHAPE.STAR4 ? 8
      : shape === SHAPE.CROSS ? 0.14
      : shape === SHAPE.HEX ? 0.3 : 0;

    for ( let k = 0; k < n; k++ ) {
      const i = pool.alloc( budget );
      if ( i < 0 ) { this.stats.dropped++; break; }
      const i3 = i * 3;

      let ox = 0, oy = 0, oz = 0, vx = 0, vy = 0, vz = 0;

      // --- cylindrical placement around world +Y (rings, columns, auras) ---
      if ( layer.radius || layer.radialSpeed || layer.tangentSpeed ) {
        const th = Math.random() * TAU;
        const ca = Math.cos( th ), sa = Math.sin( th );
        if ( layer.radius ) {
          const r = rv( layer.radius, 0 ) * scale;
          ox += ca * r; oz += sa * r;
        }
        if ( layer.radialSpeed ) {
          const rs = rv( layer.radialSpeed, 0 ) * scale;
          vx += ca * rs; vz += sa * rs;
        }
        if ( layer.tangentSpeed ) {
          const ts = rv( layer.tangentSpeed, 0 ) * scale;
          vx += -sa * ts; vz += ca * ts;
        }
      }
      if ( layer.height ) oy += rv( layer.height, 0 ) * scale;
      if ( layer.upSpeed ) vy += rv( layer.upSpeed, 0 ) * scale;

      // --- cone around the aim direction (muzzles, impacts) ----------------
      if ( layer.dirSpeed ) {
        const sp = rv( layer.dirSpeed, 0 ) * scale;
        let ax = dx, ay = dy, az = dz;
        if ( cone > 0 ) {
          // pow() biases samples toward the axis so the cone has a dense core
          // and a few strays, which reads better than a uniform fan.
          const a = cone * Math.pow( Math.random(), 0.62 );
          const ph = Math.random() * TAU;
          const sn = Math.sin( a ), cs = Math.cos( a );
          const bx = Math.cos( ph ) * sn, by = Math.sin( ph ) * sn;
          ax = dx * cs + t1x * bx + t2x * by;
          ay = dy * cs + t1y * bx + t2y * by;
          az = dz * cs + t1z * bx + t2z * by;
        }
        vx += ax * sp; vy += ay * sp; vz += az * sp;
      }

      // --- isotropic jitter (ambience, sparkle) ----------------------------
      if ( layer.jitterSpeed ) {
        const js = rv( layer.jitterSpeed, 0 ) * scale;
        const z2 = Math.random() * 2 - 1;
        const ph = Math.random() * TAU;
        const rp = Math.sqrt( Math.max( 0, 1 - z2 * z2 ) );
        vx += Math.cos( ph ) * rp * js; vy += z2 * js; vz += Math.sin( ph ) * rp * js;
      }

      pool.pos[ i3 ] = px + ox;
      pool.pos[ i3 + 1 ] = py + oy;
      pool.pos[ i3 + 2 ] = pz + oz;
      pool.vel[ i3 ] = vx;
      pool.vel[ i3 + 1 ] = vy;
      pool.vel[ i3 + 2 ] = vz;

      pool.col0[ i3 ] = c0r; pool.col0[ i3 + 1 ] = c0g; pool.col0[ i3 + 2 ] = c0b;
      pool.col1[ i3 ] = c1r; pool.col1[ i3 + 1 ] = c1g; pool.col1[ i3 + 2 ] = c1b;
      pool.col[ i3 ] = c0r; pool.col[ i3 + 1 ] = c0g; pool.col[ i3 + 2 ] = c0b;

      const life = rv( layer.life, 0.4 );
      pool.life[ i ] = life;
      pool.maxLife[ i ] = life;
      pool.delay[ i ] = rv( layer.delay, 0 );

      const s0 = rv( layer.size, 0.2 ) * scale;
      pool.size0[ i ] = s0;
      pool.size1[ i ] = s0 * sizeEnd;
      pool.sizePow[ i ] = sizePow;
      pool.size[ i ] = s0;

      const op = rv( layer.opacity, 1 );
      pool.op0[ i ] = op;
      pool.fadeIn[ i ] = fadeIn;
      pool.fadePow[ i ] = fadePow;
      pool.opacity[ i ] = fadeIn > 0 ? 0 : op;

      pool.drag[ i ] = drag;
      pool.grav[ i ] = grav;
      pool.rest[ i ] = rest;
      pool.fric[ i ] = fric;
      pool.turb[ i ] = turb;
      pool.flick[ i ] = flick;
      pool.angVel[ i ] = rv( layer.spin, 0 );
      pool.rot[ i ] = layer.rot !== undefined ? rv( layer.rot, 0 ) : Math.random() * TAU;
      pool.shape[ i ] = shape;
      pool.stretch[ i ] = rv( layer.stretch, 1 );
      pool.param[ i ] = rv( layer.param, defParam );
      pool.seed[ i ] = Math.random();
    }
  }

  /* ---- ambience ------------------------------------------------------- */

  /**
   * Turns a continuous ambient preset (`rain`, `emberDrift`) on or off.
   * The spawn volume rides with the camera so weather never runs out.
   *
   * @param {string} name
   * @param {boolean|number} on  false to stop; a number overrides the rate
   */
  setAmbient( name, on, o = null ) {
    const P = PRESETS[ name ];
    if ( !P || !P.ambient ) return this;
    let slot = null;
    for ( let i = 0; i < this._ambient.length; i++ ) if ( this._ambient[ i ].name === name ) slot = this._ambient[ i ];
    if ( !slot ) {
      slot = { name, preset: P, acc: 0, rate: 0, enabled: false, box: P.ambient.box, y: P.ambient.y, follow: P.ambient.follow };
      this._ambient.push( slot );
    }
    slot.enabled = on !== false && on !== 0;
    slot.rate = typeof on === 'number' ? on : ( o?.rate ?? P.ambient.rate ?? 30 );
    if ( o?.box ) slot.box = o.box;
    if ( o?.y !== undefined ) slot.y = o.y;
    if ( o?.follow !== undefined ) slot.follow = o.follow;
    if ( !slot.enabled ) slot.acc = 0;
    return this;
  }

  _stepAmbient( dt, camera ) {
    for ( let i = 0; i < this._ambient.length; i++ ) {
      const s = this._ambient[ i ];
      if ( !s.enabled ) continue;
      s.acc += s.rate * this.ambientScale * dt;
      let budget = Math.min( 64, Math.floor( s.acc ) );
      if ( budget <= 0 ) continue;
      s.acc -= budget;
      const bx = s.box[ 0 ], by = s.box[ 1 ], bz = s.box[ 2 ];
      const cx = s.follow && camera ? camera.position.x : 0;
      const cz = s.follow && camera ? camera.position.z : 0;
      const cy = s.follow && camera ? camera.position.y : 0;
      while ( budget-- > 0 ) {
        _ambientOpts.position.set(
          cx + ( Math.random() * 2 - 1 ) * bx,
          cy + s.y + ( Math.random() * 2 - 1 ) * by * 0.5,
          cz + ( Math.random() * 2 - 1 ) * bz
        );
        this.emit( s.preset, _ambientOpts );
      }
    }
  }

  /* ---- trails --------------------------------------------------------- */

  /** Creates a ribbon trail, adds it to the scene and drives it from update(). */
  createTrail( options = {} ) {
    const t = new BeamTrail( options );
    if ( this.scene ) this.scene.add( t.mesh );
    this.trails.push( t );
    return t;
  }

  removeTrail( t ) {
    const i = this.trails.indexOf( t );
    if ( i >= 0 ) this.trails.splice( i, 1 );
    t.dispose();
    return this;
  }

  /* ---- simulation ----------------------------------------------------- */

  update( dt, camera ) {
    dt = Math.min( Math.max( dt || 0, 0 ), 0.05 );
    this.time += dt;
    if ( camera ) this.syncCamera( camera );
    this.add.material.uniforms.uTime.value = this.time;
    this.alpha.material.uniforms.uTime.value = this.time;

    if ( dt > 0 ) this._stepAmbient( dt, camera );

    this._integrate( this.add, dt );
    this._integrate( this.alpha, dt );
    this.add.flush();
    this.alpha.flush();

    this.rings.update( dt );
    this.decals.update( dt );
    this.damageFlash.update( dt );
    for ( let i = 0; i < this.trails.length; i++ ) this.trails[ i ].update( dt, camera );

    this.stats.add = this.add.count;
    this.stats.alpha = this.alpha.count;
    this.stats.live = this.add.count + this.alpha.count;
    if ( this.stats.live > this.stats.peak ) this.stats.peak = this.stats.live;
    return this;
  }

  /**
   * CPU integration. Runs backwards so swap-removal never revisits a slot,
   * touches only typed arrays and allocates nothing.
   */
  _integrate( pool, dt ) {
    if ( dt <= 0 || pool.count === 0 ) return;
    const t = this.time;
    const gY = this.groundY;
    const g = this.gravity;
    const pos = pool.pos, vel = pool.vel, col = pool.col, col0 = pool.col0, col1 = pool.col1;

    for ( let i = pool.count - 1; i >= 0; i-- ) {
      if ( pool.delay[ i ] > 0 ) {
        pool.delay[ i ] -= dt;
        pool.opacity[ i ] = 0;
        continue;
      }
      const life = pool.life[ i ] - dt;
      if ( life <= 0 ) { pool.kill( i ); continue; }
      pool.life[ i ] = life;

      const i3 = i * 3;
      let vx = vel[ i3 ], vy = vel[ i3 + 1 ], vz = vel[ i3 + 2 ];

      const dr = pool.drag[ i ];
      if ( dr > 0 ) {
        const f = 1 / ( 1 + dr * dt );     // stable exponential-ish decay
        vx *= f; vy *= f; vz *= f;
      }
      const gv = pool.grav[ i ];
      if ( gv !== 0 ) vy -= g * gv * dt;

      const tb = pool.turb[ i ];
      if ( tb > 0 ) {
        const sd = pool.seed[ i ] * 61.7;
        vx += Math.sin( t * 2.1 + sd ) * tb * 2.6 * dt;
        vy += Math.sin( t * 1.7 + sd * 1.7 ) * tb * 1.3 * dt;
        vz += Math.cos( t * 2.6 + sd * 2.3 ) * tb * 2.6 * dt;
      }

      let x = pos[ i3 ] + vx * dt;
      let y = pos[ i3 + 1 ] + vy * dt;
      let z = pos[ i3 + 2 ] + vz * dt;

      // --- ground bounce: restitution + tangential friction ---------------
      const rst = pool.rest[ i ];
      if ( rst >= 0 && y < gY ) {
        y = gY;
        if ( vy < 0 ) {
          vy = -vy * rst;
          // Kill the micro-bounce jitter so casings actually come to rest.
          if ( vy < 0.45 ) { vy = 0; pool.rest[ i ] = 0; }
        }
        const fr = pool.fric[ i ];
        vx *= fr; vz *= fr;
        pool.angVel[ i ] *= fr;
      }

      pos[ i3 ] = x; pos[ i3 + 1 ] = y; pos[ i3 + 2 ] = z;
      vel[ i3 ] = vx; vel[ i3 + 1 ] = vy; vel[ i3 + 2 ] = vz;

      const ml = pool.maxLife[ i ];
      const u = 1 - life / ml;
      const inv = 1 - u;
      const k = 1 - Math.pow( inv, pool.sizePow[ i ] );   // ease-out

      pool.size[ i ] = pool.size0[ i ] + ( pool.size1[ i ] - pool.size0[ i ] ) * k;
      col[ i3 ] = col0[ i3 ] + ( col1[ i3 ] - col0[ i3 ] ) * k;
      col[ i3 + 1 ] = col0[ i3 + 1 ] + ( col1[ i3 + 1 ] - col0[ i3 + 1 ] ) * k;
      col[ i3 + 2 ] = col0[ i3 + 2 ] + ( col1[ i3 + 2 ] - col0[ i3 + 2 ] ) * k;

      let a = pool.op0[ i ];
      const fi = pool.fadeIn[ i ];
      if ( fi > 0 && u < fi ) {
        const w = u / fi;
        a *= w * w * ( 3 - 2 * w );
      } else {
        const v = fi > 0 ? ( u - fi ) / ( 1 - fi ) : u;
        a *= Math.pow( 1 - v, pool.fadePow[ i ] );
      }
      const fl = pool.flick[ i ];
      if ( fl > 0 ) a *= 1 - fl * 0.5 * ( 1 + Math.sin( t * 46 + pool.seed[ i ] * 37 ) );
      pool.opacity[ i ] = a;

      pool.rot[ i ] += pool.angVel[ i ] * dt;
    }
  }

  /* ---- lifecycle ------------------------------------------------------ */

  clear() {
    this.add.clear();
    this.alpha.clear();
    this.rings.clear();
    this.decals.clear();
    this.damageFlash.clear();
    for ( let i = 0; i < this.trails.length; i++ ) this.trails[ i ].reset();
    return this;
  }

  dispose() {
    this.add.points.parent?.remove( this.add.points );
    this.alpha.points.parent?.remove( this.alpha.points );
    this.add.dispose();
    this.alpha.dispose();
    this.rings.dispose();
    this.decals.dispose();
    this.damageFlash.dispose();
    for ( const t of this.trails ) t.dispose();
    this.trails.length = 0;
  }
}

// Reused emit payload for ambient spawns — keeps the weather loop allocation
// free even at 900 raindrops a second.
const _ambientOpts = { position: new THREE.Vector3(), direction: null, count: 1, scale: 1, color: null };

export { PRESETS };
