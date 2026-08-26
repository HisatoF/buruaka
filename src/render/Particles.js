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
  gl_Position = projectionMatrix * mv;

  float dist = max( -mv.z, 0.02 );
  vViewDepth = dist;

  // Perspective attenuation, then a hard clamp so a particle spawned inside
  // the near plane can never rasterise a screen-sized quad and tank fill rate.
  float px = aSize * uSizeScale * uProjScale / dist;
  gl_PointSize = clamp( px, 0.9, uMaxPoint );

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
    a = body * body * 1.05 + exp( -d * d * 7.0 ) * 0.55;

  } else if ( s < 1.5 ) {
    // ---- GLOW: wide halo, no edge ------------------------------------
    float body = clamp( 1.0 - d, 0.0, 1.0 );
    a = pow( body, 2.4 ) * 0.9 + exp( -d * d * 3.0 ) * 0.35;

  } else if ( s < 2.5 ) {
    // ---- RING: hard annulus ------------------------------------------
    float t = max( vParam, 0.012 );          // half thickness, fraction of radius
    float r = 1.0 - t * 1.6;
    float e = abs( d - r );
    a  = smoothstep( t, t * 0.32, e );       // crisp band
    a += smoothstep( t * 3.2, 0.0, e ) * 0.30;  // outer bleed for bloom
    a *= step( d, 1.0 );

  } else if ( s < 3.5 ) {
    // ---- STAR4: the anime flare --------------------------------------
    float dd = max( d, 1e-4 );
    vec2 n = q / dd;
    float onAxis = clamp( 1.0 - min( abs( n.x ), abs( n.y ) ) * 2.0, 0.0, 1.0 );
    float spike  = pow( onAxis, max( vParam, 1.0 ) );
    float arms   = spike * pow( clamp( 1.0 - dd, 0.0, 1.0 ), 0.8 );
    float core   = exp( -dd * dd * 34.0 );
    float halo   = pow( clamp( 1.0 - dd, 0.0, 1.0 ), 3.0 ) * 0.22;
    a = core * 1.25 + arms * 1.0 + halo;
    // The core burns toward white, the arms keep the tint.
    c = mix( vColor, vColor + vec3( 0.9 ), core * 0.75 );

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
    float fill = 1.0 - smoothstep( 0.90, 1.0, hx );
    float rim  = smoothstep( 0.55, 0.92, hx ) * fill;
    a = fill * clamp( vParam, 0.0, 1.0 ) + rim * 1.15;
    c = mix( vColor, vColor + vec3( 0.55 ), rim );

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
        color: 0xfff4cf, colorEnd: 0xffc23d, hdr: 7.5, hdrEnd: 4.0,
        param: [ 7, 10 ], rot: [ -0.35, 0.35 ], fadeIn: 0.10, fadePow: 1.5,
        dirSpeed: [ 0.6, 0.9 ], tint: true,
      },
      { // warm halo behind it so the star sits in a pool of light
        shape: SHAPE.GLOW, count: 1, pool: 'add',
        life: [ 0.10, 0.13 ], size: [ 0.85, 1.0 ], sizeEnd: 1.5, sizePow: 1.9,
        color: 0xffd54a, colorEnd: 0xff8a3d, hdr: 3.2, hdrEnd: 1.2,
        opacity: 0.85, fadeIn: 0.08, fadePow: 2.4, tint: true,
      },
      { // cone of fast sparks
        shape: SHAPE.SPARK, count: 16, pool: 'add',
        life: [ 0.10, 0.24 ], size: [ 0.42, 0.85 ], sizeEnd: 0.35, sizePow: 1.6,
        color: 0xffe9a8, colorEnd: 0xff5d1e, hdr: 4.0, hdrEnd: 2.0,
        dirSpeed: [ 9, 24 ], cone: 0.30, stretch: [ 4.5, 8.0 ],
        drag: 5.5, gravity: 0.35, fadeIn: 0.04, fadePow: 2.6, tint: true,
      },
      { // a few wide strays so the cone is not a perfect fan
        shape: SHAPE.SPARK, count: 5, pool: 'add', minQuality: 1,
        life: [ 0.12, 0.28 ], size: [ 0.30, 0.55 ], sizeEnd: 0.3, sizePow: 1.6,
        color: 0xffd54a, colorEnd: 0xff4a1e, hdr: 3.2, hdrEnd: 1.4,
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
        life: [ 0.055, 0.07 ], size: [ 0.42, 0.55 ], sizeEnd: 1.4, sizePow: 1.9,
        color: 0xfff0d0, hdr: 4.5, param: [ 8, 12 ], rot: [ -0.6, 0.6 ],
        fadeIn: 0.12, fadePow: 1.6 },
      { shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.16, 0.20 ], size: [ 0.20, 0.26 ], sizeEnd: 4.2, sizePow: 3.0,
        color: 0xffe6bd, hdr: 2.4, param: [ 0.16, 0.22 ],
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
        life: [ 0.06, 0.08 ], size: [ 0.62, 0.85 ], sizeEnd: 1.5, sizePow: 1.9,
        color: 0xfffbe8, colorEnd: 0xffd54a, hdr: 9.0, hdrEnd: 5.0,
        param: [ 6, 9 ], rot: [ -0.7, 0.7 ], fadeIn: 0.10, fadePow: 1.5 },
      { shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.14, 0.18 ], size: [ 0.22, 0.3 ], sizeEnd: 4.8, sizePow: 3.2,
        color: 0xffe08a, hdr: 3.2, param: [ 0.12, 0.18 ], fadeIn: 0.05, fadePow: 2.8 },
      { // ricochet sparks: long, hot, gravity-bent, and they bounce
        shape: SHAPE.SPARK, count: 22, pool: 'add',
        life: [ 0.20, 0.48 ], size: [ 0.35, 0.75 ], sizeEnd: 0.4, sizePow: 1.5,
        color: 0xfff3c0, colorEnd: 0xff5a12, hdr: 5.0, hdrEnd: 2.2,
        dirSpeed: [ 5, 17 ], cone: 1.15, stretch: [ 5, 9 ],
        gravity: 1.5, drag: 1.6, restitution: 0.42, friction: 0.72,
        fadeIn: 0.04, fadePow: 2.2, tint: true },
      { shape: SHAPE.SPARK, count: 8, pool: 'add', minQuality: 1,
        life: [ 0.35, 0.7 ], size: [ 0.22, 0.4 ], sizeEnd: 0.25, sizePow: 1.4,
        color: 0xffc46a, colorEnd: 0xff3a08, hdr: 3.0, hdrEnd: 1.2,
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
        color: 0xffffff, colorEnd: 0xd0b0ff, hdr: 6.5, hdrEnd: 3.5,
        param: [ 0.13, 0.19 ], rot: [ -0.5, 0.5 ], fadeIn: 0.12, fadePow: 1.8 },
      { shape: SHAPE.GLOW, count: 1, pool: 'add',
        life: [ 0.18, 0.24 ], size: [ 0.7, 0.9 ], sizeEnd: 2.1, sizePow: 1.1,
        color: 0xb07dff, colorEnd: 0x5b8cff, hdr: 3.0, hdrEnd: 0.9,
        opacity: 0.8, fadeIn: 0.10, fadePow: 2.4, tint: true },
      { // chunky angular shards, not a fog of dots
        shape: SHAPE.SHARD, count: 13, pool: 'add',
        life: [ 0.18, 0.34 ], size: [ 0.18, 0.42 ], sizeEnd: 0.5, sizePow: 1.6,
        color: 0xd7bcff, colorEnd: 0x5b8cff, hdr: 4.0, hdrEnd: 1.8,
        dirSpeed: [ 5, 13 ], cone: 1.25, stretch: [ 2.0, 3.4 ],
        drag: 6.5, gravity: 0.4, fadeIn: 0.05, fadePow: 2.6, tint: true },
      { // motes that peel upward afterwards — reads as "damage number" energy
        shape: SHAPE.DISC, count: 9, pool: 'add', minQuality: 1,
        delay: [ 0.02, 0.10 ], life: [ 0.30, 0.55 ],
        size: [ 0.06, 0.13 ], sizeEnd: 0.2, sizePow: 2,
        color: 0xc9a6ff, colorEnd: 0x6f8dff, hdr: 3.2, hdrEnd: 1.0,
        dirSpeed: [ 1, 3 ], cone: 1.6, upSpeed: [ 1.2, 2.8 ],
        drag: 1.6, turb: 1.2, fadePow: 1.8, tint: true },
    ],
  },

  impactShield: {
    layers: [
      { shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.26, 0.32 ], size: [ 0.35, 0.45 ], sizeEnd: 5.5, sizePow: 3.0,
        color: 0xd8f4ff, colorEnd: 0x7fd6ff, hdr: 5.0, hdrEnd: 2.2,
        param: [ 0.10, 0.15 ], fadeIn: 0.05, fadePow: 2.4, tint: true },
      { shape: SHAPE.STAR4, count: 1, pool: 'add',
        life: [ 0.08, 0.1 ], size: [ 0.7, 0.95 ], sizeEnd: 1.3, sizePow: 1.9,
        color: 0xffffff, colorEnd: 0x7fd6ff, hdr: 6.0, hdrEnd: 3.0,
        param: [ 7, 11 ], rot: [ -0.5, 0.5 ], fadeIn: 0.10, fadePow: 1.6 },
      { // the hex lattice cracking outward
        shape: SHAPE.HEX, count: 14, pool: 'add',
        life: [ 0.22, 0.42 ], size: [ 0.16, 0.34 ], sizeEnd: 0.55, sizePow: 1.5,
        color: 0xbfeaff, colorEnd: 0x35a3ea, hdr: 3.6, hdrEnd: 1.4,
        param: [ 0.20, 0.45 ],
        dirSpeed: [ 2.5, 7.5 ], cone: 1.35, drag: 7.0,
        spin: [ -6, 6 ], fadeIn: 0.06, fadePow: 2.6, tint: true },
      { shape: SHAPE.SPARK, count: 8, pool: 'add', minQuality: 1,
        life: [ 0.12, 0.26 ], size: [ 0.28, 0.5 ], sizeEnd: 0.3, sizePow: 1.5,
        color: 0xe8faff, colorEnd: 0x7fd6ff, hdr: 4.0, hdrEnd: 1.6,
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
  bloodlessHitSpark: {
    layers: [
      { shape: SHAPE.CROSS, count: 1, pool: 'add',
        life: [ 0.11, 0.14 ], size: [ 1.0, 1.25 ], sizeEnd: 1.5, sizePow: 1.9,
        color: 0xffffff, hdr: 8.0, hdrEnd: 5.0, colorEnd: 0xdff4ff,
        param: [ 0.11, 0.15 ], rot: [ -0.25, 0.25 ], fadeIn: 0.10, fadePow: 2.0 },
      { shape: SHAPE.CROSS, count: 1, pool: 'add',
        life: [ 0.08, 0.10 ], size: [ 0.62, 0.8 ], sizeEnd: 1.6, sizePow: 1.9,
        color: 0xd8f4ff, colorEnd: 0x7fd6ff, hdr: 5.0, hdrEnd: 2.0,
        param: [ 0.09, 0.12 ], rot: [ 0.68, 0.90 ], fadeIn: 0.10, fadePow: 2.2, tint: true },
      { shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.13, 0.16 ], size: [ 0.25, 0.32 ], sizeEnd: 4.0, sizePow: 3.0,
        color: 0xffffff, colorEnd: 0xbfe6ff, hdr: 3.0, hdrEnd: 1.0,
        param: [ 0.09, 0.13 ], opacity: 0.9, fadeIn: 0.05, fadePow: 3.0 },
      { shape: SHAPE.SPARK, count: 7, pool: 'add', minQuality: 1,
        life: [ 0.09, 0.16 ], size: [ 0.28, 0.5 ], sizeEnd: 0.25, sizePow: 1.5,
        color: 0xffffff, colorEnd: 0xbfe6ff, hdr: 4.5, hdrEnd: 2.0,
        dirSpeed: [ 7, 15 ], cone: 1.6, stretch: [ 4, 7 ], drag: 9, fadePow: 2.4 },
    ],
  },

  /* ---- explosion ------------------------------------------------------ */

  explosion: {
    layers: [
      { // frame 1: the star
        shape: SHAPE.STAR4, count: 1, pool: 'add',
        life: [ 0.13, 0.16 ], size: [ 2.6, 3.1 ], sizeEnd: 1.45, sizePow: 1.9,
        color: 0xfffbe8, colorEnd: 0xffb03a, hdr: 8.0, hdrEnd: 4.5,
        param: [ 5, 8 ], rot: [ -0.4, 0.4 ], fadeIn: 0.09, fadePow: 1.7 },
      { shape: SHAPE.GLOW, count: 1, pool: 'add',
        life: [ 0.22, 0.30 ], size: [ 1.8, 2.2 ], sizeEnd: 2.2, sizePow: 1.0,
        color: 0xffc46a, hdr: 4.0, hdrEnd: 1.0, colorEnd: 0xff5d1e,
        opacity: 0.9, fadeIn: 0.08, fadePow: 2.4 },
      { // frame 2-3: the hard ring
        shape: SHAPE.RING, count: 1, pool: 'add',
        life: [ 0.32, 0.38 ], size: [ 1.0, 1.2 ], sizeEnd: 7.5, sizePow: 3.2,
        color: 0xffe9b0, colorEnd: 0xff7a3c, hdr: 5.0, hdrEnd: 1.8,
        param: [ 0.07, 0.10 ], fadeIn: 0.05, fadePow: 2.6 },
      { // a second, thinner, whiter ring one frame behind it
        shape: SHAPE.RING, count: 1, pool: 'add',
        delay: [ 0.05, 0.07 ], life: [ 0.26, 0.32 ],
        size: [ 0.8, 1.0 ], sizeEnd: 9.0, sizePow: 3.4,
        color: 0xffffff, colorEnd: 0xffd54a, hdr: 3.5, hdrEnd: 1.2,
        param: [ 0.035, 0.06 ], opacity: 0.9, fadeIn: 0.05, fadePow: 3.0 },
      { // embers
        shape: SHAPE.SPARK, count: 30, pool: 'add',
        life: [ 0.5, 1.15 ], size: [ 0.4, 0.95 ], sizeEnd: 0.3, sizePow: 1.4,
        color: 0xffe08a, colorEnd: 0xff3a10, hdr: 4.5, hdrEnd: 1.6,
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
    shockwave: { radius: 6.5, life: 0.45, color: 0xffd07a, hdr: 3.2, thickness: 0.055 },
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
        color: 0xd6ffef, hdr: 3.0, hdrEnd: 1.2, colorEnd: 0x4ce0a4,
        param: [ 0.07, 0.11 ], fadeIn: 0.10, fadePow: 2.2, tint: true },
      { // rising motes
        shape: SHAPE.DISC, count: 20, pool: 'add',
        delay: [ 0, 0.25 ], life: [ 0.55, 1.0 ],
        size: [ 0.07, 0.16 ], sizeEnd: 0.35, sizePow: 2.0,
        color: 0xb7ffe0, colorEnd: 0x2fc98c, hdr: 3.4, hdrEnd: 1.2,
        opacity: 0.95, fadeIn: 0.18, fadePow: 1.8,
        radius: [ 0.15, 0.95 ], height: [ 0, 0.25 ],
        upSpeed: [ 1.1, 2.6 ], tangentSpeed: [ 0.3, 1.0 ],
        drag: 0.9, turb: 0.9, tint: true },
      { // a handful of "+" sparkles among them
        shape: SHAPE.CROSS, count: 6, pool: 'add', minQuality: 1,
        delay: [ 0.05, 0.35 ], life: [ 0.35, 0.6 ],
        size: [ 0.16, 0.3 ], sizeEnd: 0.7, sizePow: 1.4,
        color: 0xeafff6, colorEnd: 0x4ce0a4, hdr: 4.0, hdrEnd: 1.5,
        param: [ 0.16, 0.24 ], rot: [ -0.15, 0.15 ],
        radius: [ 0.2, 0.9 ], upSpeed: [ 0.9, 2.0 ],
        drag: 1.2, fadeIn: 0.16, fadePow: 2.0, tint: true },
    ],
    shockwave: { radius: 2.6, life: 0.55, color: 0x4ce0a4, hdr: 2.4, thickness: 0.05 },
  },

  // Two beats in one preset: shards spiral inward for ~0.4 s, then the centre
  // detonates. The second beat is scheduled with per-layer `delay`.
  skillCast: {
    layers: [
      { shape: SHAPE.HEX, count: 22, pool: 'add',
        delay: [ 0, 0.10 ], life: [ 0.40, 0.48 ],
        size: [ 0.14, 0.30 ], sizeEnd: 0.35, sizePow: 2.4,
        color: 0xdcf6ff, colorEnd: 0x35a3ea, hdr: 3.6, hdrEnd: 1.6,
        param: [ 0.15, 0.4 ],
        radius: [ 2.2, 3.2 ], height: [ 0.1, 2.2 ],
        radialSpeed: [ -7.5, -5.0 ], tangentSpeed: [ 2.0, 4.5 ], upSpeed: [ -0.6, 0.6 ],
        drag: 0.4, spin: [ -7, 7 ], fadeIn: 0.14, fadePow: 1.6, tint: true },
      { shape: SHAPE.RUNE, count: 8, pool: 'add', minQuality: 1,
        delay: [ 0, 0.12 ], life: [ 0.40, 0.5 ],
        size: [ 0.22, 0.4 ], sizeEnd: 0.4, sizePow: 2.4,
        color: 0xbfeaff, colorEnd: 0x7fd6ff, hdr: 3.0, hdrEnd: 1.4,
        radius: [ 2.4, 3.4 ], height: [ 0.2, 1.8 ],
        radialSpeed: [ -8, -6 ], tangentSpeed: [ 2.5, 5 ],
        drag: 0.4, spin: [ -4, 4 ], fadeIn: 0.16, fadePow: 1.6, tint: true },
      { // the detonation
        shape: SHAPE.STAR4, count: 1, pool: 'add',
        delay: [ 0.44, 0.44 ], life: [ 0.14, 0.17 ],
        size: [ 1.9, 2.3 ], sizeEnd: 1.4, sizePow: 1.9, height: [ 1.0, 1.0 ],
        color: 0xffffff, colorEnd: 0x7fd6ff, hdr: 7.0, hdrEnd: 3.5,
        param: [ 6, 9 ], rot: [ -0.3, 0.3 ], fadeIn: 0.09, fadePow: 1.7, tint: true },
      { shape: SHAPE.RING, count: 1, pool: 'add',
        delay: [ 0.45, 0.45 ], life: [ 0.30, 0.36 ],
        size: [ 0.8, 1.0 ], sizeEnd: 6.5, sizePow: 3.2, height: [ 1.0, 1.0 ],
        color: 0xe8fbff, colorEnd: 0x35a3ea, hdr: 4.5, hdrEnd: 1.8,
        param: [ 0.06, 0.09 ], fadeIn: 0.05, fadePow: 2.6, tint: true },
      { shape: SHAPE.SPARK, count: 24, pool: 'add',
        delay: [ 0.45, 0.50 ], life: [ 0.22, 0.42 ],
        size: [ 0.45, 0.85 ], sizeEnd: 0.3, sizePow: 1.5, height: [ 0.9, 1.1 ],
        color: 0xeafcff, colorEnd: 0x2f8fe0, hdr: 4.5, hdrEnd: 1.6,
        radialSpeed: [ 7, 18 ], upSpeed: [ -1.5, 3.5 ], radius: [ 0, 0.3 ],
        stretch: [ 5, 9 ], drag: 4.0, fadeIn: 0.04, fadePow: 2.4, tint: true },
      { shape: SHAPE.HEX, count: 10, pool: 'add', minQuality: 1,
        delay: [ 0.46, 0.55 ], life: [ 0.3, 0.5 ],
        size: [ 0.16, 0.32 ], sizeEnd: 0.5, sizePow: 1.6, height: [ 0.7, 1.3 ],
        color: 0xbfeaff, colorEnd: 0x35a3ea, hdr: 3.0, hdrEnd: 1.2,
        param: [ 0.2, 0.5 ], radialSpeed: [ 3, 9 ], upSpeed: [ 0.5, 3 ],
        drag: 3.0, spin: [ -8, 8 ], fadePow: 2.2, tint: true },
    ],
    shockwave: { radius: 4.0, life: 0.5, color: 0x7fd6ff, hdr: 3.0, thickness: 0.05, delay: 0.45 },
  },

  // Ambient sparkle around a character's halo. Call it every ~0.2 s.
  haloSpark: {
    layers: [
      { shape: SHAPE.DISC, count: 3, pool: 'add',
        life: [ 0.7, 1.4 ], size: [ 0.030, 0.075 ], sizeEnd: 0.25, sizePow: 2.2,
        color: 0xdff6ff, colorEnd: 0x9fe8ff, hdr: 3.2, hdrEnd: 1.4,
        radius: [ 0.10, 0.30 ], upSpeed: [ 0.10, 0.45 ],
        jitterSpeed: [ 0.05, 0.25 ], drag: 1.1, turb: 0.55,
        fadeIn: 0.22, fadePow: 1.6, flicker: 0.35, tint: true },
      { shape: SHAPE.CROSS, count: 1, pool: 'add', minQuality: 1,
        life: [ 0.35, 0.6 ], size: [ 0.10, 0.19 ], sizeEnd: 0.5, sizePow: 1.5,
        color: 0xffffff, colorEnd: 0x9fe8ff, hdr: 4.0, hdrEnd: 1.5,
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
        color: 0xeafaff, colorEnd: 0x7fd6ff, hdr: 4.5, hdrEnd: 1.5,
        dirSpeed: [ 1.5, 2.5 ], cone: 0.02, stretch: [ 8, 12 ],
        drag: 8, fadeIn: 0.05, fadePow: 2.2, tint: true },
      { shape: SHAPE.GLOW, count: 1, pool: 'add',
        life: [ 0.10, 0.16 ], size: [ 0.16, 0.24 ], sizeEnd: 0.3, sizePow: 2,
        color: 0xbfe6ff, hdr: 2.4, hdrEnd: 0.6, colorEnd: 0x35a3ea,
        opacity: 0.7, jitterSpeed: [ 0, 0.3 ], drag: 4, fadePow: 2.0, tint: true },
    ],
  },

  /* ---- ambience ------------------------------------------------------- */

  rain: {
    ambient: true,
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
    ambient: true,
    layers: [
      { shape: SHAPE.DISC, count: 1, pool: 'add',
        life: [ 1.8, 3.6 ], size: [ 0.028, 0.065 ], sizeEnd: 0.5, sizePow: 2,
        color: 0xffc46a, colorEnd: 0xff5d1e, hdr: 2.8, hdrEnd: 1.0,
        upSpeed: [ 0.25, 0.85 ], jitterSpeed: [ 0.1, 0.5 ],
        drag: 0.5, turb: 0.75, fadeIn: 0.18, fadePow: 1.5, flicker: 0.55, tint: true },
    ],
  },
};
