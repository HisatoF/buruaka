import * as THREE from 'three';

/**
 * gen/Textures.js — the procedural texture library.
 * ================================================
 *
 * Every surface in the game is painted here at runtime onto a canvas and handed
 * to three as a `CanvasTexture`. There are no image files anywhere in the repo.
 *
 * ART DIRECTION
 * -------------
 * These are *anime background paintings*, not PBR scans. The rules that keep
 * them on-model:
 *
 *   1. Tone count, not detail count. Each texture resolves to three or four
 *      flat values. Continuous fields (fbm, worley) are only ever used to decide
 *      *which* band a pixel lands in — they are quantised before they reach the
 *      canvas. Squint at any of these and you should count the bands.
 *   2. High key, narrow range. Albedo stays roughly in 0.35–0.95 luminance.
 *      Contrast comes from hue, not from crushing to black.
 *   3. Shadows shift violet, lights shift warm. `darken()` multiplies toward a
 *      violet tint rather than toward grey, which is what makes the flat bands
 *      read as painted rather than as a levels adjustment. This matches the
 *      hue-shifted shadow ramp in render/ToonMaterial.js.
 *   4. Line work is drawn, not derived. Cracks, grout, panel lines and blade
 *      strokes are vector strokes on top of the banded base, the way a
 *      background artist would ink them in.
 *
 * TILING
 * ------
 * Anything documented as tileable is seamless *by construction*, never by
 * cross-fading edges:
 *
 *   - Noise is sampled on a torus: the value-noise lattice indices are taken
 *     modulo an integer period, and every octave multiplies that period by an
 *     integer lacunarity, so octave N wraps at exactly the same texture edge as
 *     octave 0. Mirror-blending the borders would have been cheaper but it
 *     doubles up features along the seam, which is instantly visible on a large
 *     ground plane at a grazing angle.
 *   - Vector strokes are drawn nine times through `wrapDraw()`, offset by
 *     ±width/±height. A stroke that leaves the right edge is therefore re-drawn
 *     entering the left edge with the same geometry, so it meets itself exactly.
 *   - Grid features (bricks, slabs, weave, mesh) always use a period that
 *     divides the texture size, and the Sobel normal converter samples with
 *     wrapped coordinates so the derived normal map tiles too.
 *
 * DETERMINISM
 * -----------
 * Everything is driven by `mulberry32` seeded from the options, so the same
 * options always produce the same pixels — which is what makes the texture
 * cache safe and the screenshot harness stable.
 */

/* ====================================================================== */
/* Deterministic randomness                                               */
/* ====================================================================== */

/**
 * Mulberry32 PRNG — 32 bits of state, passes enough of the small-crush battery
 * for texture work and is about as fast as `Math.random`.
 * @param {number} a Seed.
 * @returns {function(): number} Generator producing floats in [0, 1).
 */
function mulberry32( a ) {
  return function () {
    a = ( a + 0x6D2B79F5 ) | 0;
    let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
    t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
    return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
  };
}

/** Integer lattice hash. Decorrelates well enough that value noise built on it
 *  shows no axis-aligned structure at the octave counts used here. */
function hash2( x, y, seed ) {
  let h = Math.imul( x, 374761393 ) ^ Math.imul( y, 668265263 ) ^ Math.imul( seed, 1274126177 );
  h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
  h ^= h >>> 16;
  return ( h >>> 0 ) / 4294967296;
}

/** Positive modulo — plain `%` keeps the sign of the dividend, which would
 *  break the lattice wrap for negative coordinates. */
function wrapi( v, n ) {
  const r = v % n;
  return r < 0 ? r + n : r;
}

const clamp01 = ( v ) => ( v < 0 ? 0 : v > 1 ? 1 : v );
const lerp = ( a, b, t ) => a + ( b - a ) * t;
const smoothstep = ( e0, e1, x ) => {
  const t = clamp01( ( x - e0 ) / ( e1 - e0 || 1e-6 ) );
  return t * t * ( 3 - 2 * t );
};

/**
 * Periodic 2D value noise. `px`/`py` are the lattice periods in cells; the
 * function repeats exactly every `px` units in x and `py` units in y, which is
 * the whole basis of seamless tiling here.
 */
function valueNoise( x, y, px, py, seed ) {
  const xi = Math.floor( x ), yi = Math.floor( y );
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * ( 3 - 2 * fx );
  const uy = fy * fy * ( 3 - 2 * fy );
  const x0 = wrapi( xi, px ), x1 = wrapi( xi + 1, px );
  const y0 = wrapi( yi, py ), y1 = wrapi( yi + 1, py );
  const n00 = hash2( x0, y0, seed ), n10 = hash2( x1, y0, seed );
  const n01 = hash2( x0, y1, seed ), n11 = hash2( x1, y1, seed );
  return lerp( lerp( n00, n10, ux ), lerp( n01, n11, ux ), uy );
}

/**
 * Renders fractal brownian motion into a `Float32Array` scanline buffer.
 *
 * Fields are deliberately generated at a *lower* resolution than the texture
 * (typically 256²) and bilinearly resampled by `sampleField`. Low-frequency
 * blotching carries no information above that rate, and it turns a 16-million
 * hash job at 1024² into a one-million hash job.
 *
 * @returns {Float32Array} `fw * fh` values normalised to [0, 1].
 */
function fbmField( fw, fh, {
  periodX = 4, periodY = 4, octaves = 4, gain = 0.5, lacunarity = 2,
  seed = 1, ridged = false, warp = 0,
} = {} ) {
  const out = new Float32Array( fw * fh );
  let lo = Infinity, hi = -Infinity;

  for ( let y = 0; y < fh; y++ ) {
    const v = y / fh;
    for ( let x = 0; x < fw; x++ ) {
      let u = x / fw, vv = v;

      // Domain warp: displaces the sample point by a low-frequency noise field.
      // The warp field uses the same integer periods, so warping cannot drag a
      // feature across the seam in a way that fails to wrap.
      if ( warp > 0 ) {
        const wx = valueNoise( u * periodX, vv * periodY, periodX, periodY, seed + 977 );
        const wy = valueNoise( u * periodX, vv * periodY, periodX, periodY, seed + 4231 );
        u += ( wx - 0.5 ) * warp;
        vv += ( wy - 0.5 ) * warp;
      }

      let amp = 1, sum = 0, norm = 0, px = periodX, py = periodY;
      for ( let i = 0; i < octaves; i++ ) {
        let n = valueNoise( u * px, vv * py, px, py, seed + i * 1013 );
        if ( ridged ) n = 1 - Math.abs( n * 2 - 1 );
        sum += n * amp;
        norm += amp;
        amp *= gain;
        px *= lacunarity;
        py *= lacunarity;
      }
      const val = sum / norm;
      out[ y * fw + x ] = val;
      if ( val < lo ) lo = val;
      if ( val > hi ) hi = val;
    }
  }

  // Normalise so downstream band thresholds mean the same thing regardless of
  // octave count — otherwise adding an octave silently re-tones the texture.
  const span = hi - lo || 1;
  for ( let i = 0; i < out.length; i++ ) out[ i ] = ( out[ i ] - lo ) / span;
  return out;
}

/**
 * Periodic Worley / cellular noise. Feature points live in a wrapped cell grid
 * and distances are measured on the torus, so the field tiles.
 * @param {'f1'|'f2f1'|'cell'} mode `f1` = distance to nearest point,
 *   `f2f1` = ridge between cells, `cell` = flat random value per cell.
 */
function worleyField( fw, fh, { cellsX = 8, cellsY = 8, seed = 1, mode = 'f1' } = {} ) {
  const out = new Float32Array( fw * fh );
  const px = new Float32Array( cellsX * cellsY );
  const py = new Float32Array( cellsX * cellsY );
  const cv = new Float32Array( cellsX * cellsY );

  for ( let cy = 0; cy < cellsY; cy++ ) {
    for ( let cx = 0; cx < cellsX; cx++ ) {
      const i = cy * cellsX + cx;
      px[ i ] = ( cx + hash2( cx, cy, seed ) ) / cellsX;
      py[ i ] = ( cy + hash2( cx, cy, seed + 7717 ) ) / cellsY;
      cv[ i ] = hash2( cx, cy, seed + 31337 );
    }
  }

  let lo = Infinity, hi = -Infinity;
  for ( let y = 0; y < fh; y++ ) {
    const v = ( y + 0.5 ) / fh;
    const cy0 = Math.floor( v * cellsY );
    for ( let x = 0; x < fw; x++ ) {
      const u = ( x + 0.5 ) / fw;
      const cx0 = Math.floor( u * cellsX );
      let d1 = 4, d2 = 4, best = 0;

      for ( let oy = -1; oy <= 1; oy++ ) {
        for ( let ox = -1; ox <= 1; ox++ ) {
          const i = wrapi( cy0 + oy, cellsY ) * cellsX + wrapi( cx0 + ox, cellsX );
          // Toroidal delta: wrap the offset into [-0.5, 0.5] so a point just
          // past the right edge is the near neighbour of a pixel on the left.
          let dx = px[ i ] - u, dy = py[ i ] - v;
          dx -= Math.round( dx );
          dy -= Math.round( dy );
          const d = dx * dx + dy * dy;
          if ( d < d1 ) { d2 = d1; d1 = d; best = cv[ i ]; }
          else if ( d < d2 ) { d2 = d; }
        }
      }

      const val = mode === 'cell' ? best
        : mode === 'f2f1' ? Math.sqrt( d2 ) - Math.sqrt( d1 )
          : Math.sqrt( d1 );
      out[ y * fw + x ] = val;
      if ( val < lo ) lo = val;
      if ( val > hi ) hi = val;
    }
  }

  if ( mode !== 'cell' ) {
    const span = hi - lo || 1;
    for ( let i = 0; i < out.length; i++ ) out[ i ] = ( out[ i ] - lo ) / span;
  }
  return out;
}

/** Bilinear field lookup with wrapped edges; `u`/`v` are normalised [0,1). */
function sampleField( f, fw, fh, u, v ) {
  const x = u * fw - 0.5, y = v * fh - 0.5;
  const xi = Math.floor( x ), yi = Math.floor( y );
  const fx = x - xi, fy = y - yi;
  const x0 = wrapi( xi, fw ), x1 = wrapi( xi + 1, fw );
  const y0 = wrapi( yi, fh ) * fw, y1 = wrapi( yi + 1, fh ) * fw;
  return lerp(
    lerp( f[ y0 + x0 ], f[ y0 + x1 ], fx ),
    lerp( f[ y1 + x0 ], f[ y1 + x1 ], fx ), fy );
}

/* ====================================================================== */
/* Colour                                                                 */
/* ====================================================================== */

const _col = new THREE.Color();
const _rgb = { r: 0, g: 0, b: 0 };

/**
 * Parses any three-compatible colour (hex int, CSS string, THREE.Color) into
 * sRGB bytes. Routing through THREE.Color means hex literals are interpreted
 * under the renderer's colour management, matching the rest of the codebase.
 * @returns {number[]} `[r, g, b]` in 0–255 (unrounded).
 */
function toRGB( v ) {
  _col.set( v );
  _col.getRGB( _rgb, THREE.SRGBColorSpace );
  return [ _rgb.r * 255, _rgb.g * 255, _rgb.b * 255 ];
}

/** Bytes back to a canvas fill string. */
function css( rgb, alpha = 1 ) {
  const r = Math.round( clamp01( rgb[ 0 ] / 255 ) * 255 );
  const g = Math.round( clamp01( rgb[ 1 ] / 255 ) * 255 );
  const b = Math.round( clamp01( rgb[ 2 ] / 255 ) * 255 );
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** Multiplicative shadow. The tint is violet-leaning, so darkening also cools
 *  and desaturates the hue — the single biggest contributor to the "painted"
 *  read, and it keeps texture shadows consistent with the toon shader's ramp. */
const SHADOW_TINT = [ 0.60, 0.57, 0.78 ];
function darken( rgb, t, tint = SHADOW_TINT ) {
  return [
    rgb[ 0 ] * lerp( 1, tint[ 0 ], t ),
    rgb[ 1 ] * lerp( 1, tint[ 1 ], t ),
    rgb[ 2 ] * lerp( 1, tint[ 2 ], t ),
  ];
}

/** Additive highlight toward a warm white rather than pure white, so lit bands
 *  gain temperature instead of just washing out. */
const LIGHT_TINT = [ 255, 251, 240 ];
function lighten( rgb, t, tint = LIGHT_TINT ) {
  return [
    lerp( rgb[ 0 ], tint[ 0 ], t ),
    lerp( rgb[ 1 ], tint[ 1 ], t ),
    lerp( rgb[ 2 ], tint[ 2 ], t ),
  ];
}

function mixRGB( a, b, t ) {
  return [ lerp( a[ 0 ], b[ 0 ], t ), lerp( a[ 1 ], b[ 1 ], t ), lerp( a[ 2 ], b[ 2 ], t ) ];
}

/** Rotates a colour toward another hue family without changing its value much;
 *  used to give grass clumps and brick courses tonal variety that survives the
 *  squint test better than pure lightness steps. */
function hueShift( rgb, target, t ) {
  const lum = ( rgb[ 0 ] * 0.299 + rgb[ 1 ] * 0.587 + rgb[ 2 ] * 0.114 );
  const tl = ( target[ 0 ] * 0.299 + target[ 1 ] * 0.587 + target[ 2 ] * 0.114 ) || 1;
  const scaled = [ target[ 0 ] * lum / tl, target[ 1 ] * lum / tl, target[ 2 ] * lum / tl ];
  return mixRGB( rgb, scaled, t );
}

/**
 * Hard band selector — the core cel operation. `bands` is an ascending list of
 * `[threshold, rgb]`; a value picks the last band it clears. No interpolation,
 * because interpolation is exactly what turns a painted surface into mush.
 */
function celPick( v, bands ) {
  let out = bands[ 0 ][ 1 ];
  for ( let i = 1; i < bands.length; i++ ) {
    if ( v >= bands[ i ][ 0 ] ) out = bands[ i ][ 1 ]; else break;
  }
  return out;
}

/** Quantise to `steps` discrete levels in [0,1]. */
function quantize( v, steps ) {
  return Math.round( clamp01( v ) * ( steps - 1 ) ) / ( steps - 1 );
}

/* ====================================================================== */
/* Canvas / texture plumbing                                              */
/* ====================================================================== */

/**
 * OffscreenCanvas where available (workers, and it skips DOM allocation), with
 * a plain `<canvas>` fallback for older Safari and any non-window context that
 * still has a document.
 */
function createCanvas( w, h ) {
  if ( typeof OffscreenCanvas !== 'undefined' ) {
    try { return new OffscreenCanvas( w, h ); } catch { /* fall through */ }
  }
  if ( typeof document !== 'undefined' ) {
    const c = document.createElement( 'canvas' );
    c.width = w; c.height = h;
    return c;
  }
  throw new Error( 'Textures: no canvas implementation available' );
}

function ctx2d( canvas ) {
  const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
  if ( !ctx ) throw new Error( 'Textures: 2D context unavailable' );
  return ctx;
}

const DEFAULT_ANISOTROPY = 8;

/**
 * Wraps a canvas as a `CanvasTexture` with the project's standard sampler
 * settings.
 * @param {boolean} srgb `true` for albedo, `false` for normal/roughness/data —
 *   non-colour data must not be gamma-decoded on sample.
 */
function finishTexture( canvas, {
  srgb = true, wrapS = THREE.RepeatWrapping, wrapT = THREE.RepeatWrapping,
  anisotropy = DEFAULT_ANISOTROPY, name = '',
} = {} ) {
  const tex = new THREE.CanvasTexture( canvas );
  tex.wrapS = wrapS;
  tex.wrapT = wrapT;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Draws `fn` nine times on a 3×3 lattice of ±size offsets.
 *
 * Canvas strokes are clipped at the bitmap border, so a crack that runs off the
 * right edge simply stops. Re-drawing the identical geometry shifted by one
 * texture width makes the part that left the right edge re-enter on the left,
 * which is what actually makes vector detail tile. `fn` must be deterministic —
 * pass precomputed geometry, never a live PRNG.
 */
function wrapDraw( ctx, w, h, fn ) {
  for ( let oy = -1; oy <= 1; oy++ ) {
    for ( let ox = -1; ox <= 1; ox++ ) {
      ctx.save();
      ctx.translate( ox * w, oy * h );
      fn( ctx );
      ctx.restore();
    }
  }
}

/* ====================================================================== */
/* Cache                                                                  */
/* ====================================================================== */

const _cache = new Map();

/** Stable cache key: the resolved option object always has the same key order
 *  because it is built by spreading a literal defaults object first. */
function cacheKey( name, o ) {
  let s = name;
  for ( const k in o ) {
    const v = o[ k ];
    s += '|' + k + '=' + ( typeof v === 'number' ? Math.round( v * 1e4 ) / 1e4
      : Array.isArray( v ) ? JSON.stringify( v ) : String( v ) );
  }
  return s;
}

function cached( key, build ) {
  const hit = _cache.get( key );
  if ( hit ) return hit;
  const made = build();
  _cache.set( key, made );
  return made;
}

/**
 * Drops every cached texture and frees its GPU handle. Call on level teardown
 * or when changing quality level, otherwise generated maps live for the whole
 * session (which is usually what you want — regenerating a 1024² asphalt map
 * costs tens of milliseconds).
 */
export function clearTextureCache() {
  for ( const entry of _cache.values() ) {
    if ( entry && entry.isTexture ) { entry.dispose(); continue; }
    if ( entry && typeof entry === 'object' ) {
      for ( const v of Object.values( entry ) ) if ( v && v.isTexture ) v.dispose();
    }
  }
  _cache.clear();
}

/* ====================================================================== */
/* Height -> normal                                                       */
/* ====================================================================== */

/**
 * Sobel height-to-normal converter.
 *
 * Sampling is **wrapped** rather than clamped. A clamped Sobel produces a hard
 * gradient discontinuity in the outermost pixel ring, which shows up on a tiled
 * ground plane as a lit grid of seams that no amount of albedo tiling can hide.
 *
 * Output follows the OpenGL / three tangent-space convention (+Y points up the
 * V axis), so it drops straight into `MeshStandardMaterial.normalMap`.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|ImageData} source Height in the
 *   luminance of the source pixels; alpha is ignored.
 * @param {number} [strength=1] Slope multiplier. ~0.5 for cloth, ~1 for stone,
 *   ~2 for deep grooves.
 * @returns {THREE.CanvasTexture} RGB tangent-space normal map, `NoColorSpace`.
 */
export function makeNormalFromHeight( source, strength = 1 ) {
  let data, w, h;
  if ( source && source.data && source.width ) {
    ( { data, width: w, height: h } = source );
  } else {
    w = source.width; h = source.height;
    data = ctx2d( source ).getImageData( 0, 0, w, h ).data;
  }

  // Pre-flatten to a luminance array; the inner loop reads nine neighbours per
  // pixel and re-deriving luminance each time would triple the arithmetic.
  const hgt = new Float32Array( w * h );
  for ( let i = 0, p = 0; i < hgt.length; i++, p += 4 ) {
    hgt[ i ] = ( data[ p ] * 0.299 + data[ p + 1 ] * 0.587 + data[ p + 2 ] * 0.114 ) / 255;
  }

  const out = new Uint8ClampedArray( w * h * 4 );
  const at = ( x, y ) => hgt[ wrapi( y, h ) * w + wrapi( x, w ) ];

  for ( let y = 0; y < h; y++ ) {
    for ( let x = 0; x < w; x++ ) {
      const tl = at( x - 1, y - 1 ), t = at( x, y - 1 ), tr = at( x + 1, y - 1 );
      const l = at( x - 1, y ), r = at( x + 1, y );
      const bl = at( x - 1, y + 1 ), b = at( x, y + 1 ), br = at( x + 1, y + 1 );

      const gx = ( tr + 2 * r + br ) - ( tl + 2 * l + bl );
      const gy = ( bl + 2 * b + br ) - ( tl + 2 * t + tr );

      // gy is measured down the image; negating it flips into UV space where
      // +V runs up, which is what the green channel must encode.
      let nx = -gx * strength * 2;
      let ny = gy * strength * 2;
      const nz = 1;
      const inv = 1 / Math.hypot( nx, ny, nz );
      nx *= inv; ny *= inv;

      const p = ( y * w + x ) * 4;
      out[ p ] = ( nx * 0.5 + 0.5 ) * 255;
      out[ p + 1 ] = ( ny * 0.5 + 0.5 ) * 255;
      out[ p + 2 ] = ( nz * inv * 0.5 + 0.5 ) * 255;
      out[ p + 3 ] = 255;
    }
  }

  const canvas = createCanvas( w, h );
  ctx2d( canvas ).putImageData( new ImageData( out, w, h ), 0, 0 );
  return finishTexture( canvas, { srgb: false, name: 'normal' } );
}

/* ====================================================================== */
/* Shared drawing helpers                                                 */
/* ====================================================================== */

function newSurface( w, h ) {
  const canvas = createCanvas( w, h );
  const ctx = ctx2d( canvas );
  return { canvas, ctx };
}

function putRGBA( ctx, w, h, buf ) {
  ctx.putImageData( new ImageData( buf, w, h ), 0, 0 );
}

/** Writes a scalar 0..1 buffer into an opaque greyscale RGBA buffer. */
function grayBuffer( w, h, values ) {
  const buf = new Uint8ClampedArray( w * h * 4 );
  for ( let i = 0, p = 0; i < w * h; i++, p += 4 ) {
    const v = values[ i ] * 255;
    buf[ p ] = buf[ p + 1 ] = buf[ p + 2 ] = v;
    buf[ p + 3 ] = 255;
  }
  return buf;
}

/** Closed blob outline from a table of per-angle radii. Used for tar patches,
 *  scorch marks and splats — anything that needs an organic silhouette that is
 *  still a clean single shape rather than a noisy alpha mask. */
function blobPath( ctx, cx, cy, radii ) {
  const n = radii.length;
  ctx.beginPath();
  for ( let i = 0; i <= n; i++ ) {
    const a = ( i / n ) * Math.PI * 2;
    const r = radii[ i % n ];
    const x = cx + Math.cos( a ) * r, y = cy + Math.sin( a ) * r;
    if ( i ) ctx.lineTo( x, y ); else ctx.moveTo( x, y );
  }
  ctx.closePath();
}

/** Radii table whose first and last entries agree, so the blob closes smoothly. */
function blobRadii( rnd, r, wobble, n = 48, lobes = 3 ) {
  const out = new Float32Array( n );
  const ph = rnd() * Math.PI * 2, ph2 = rnd() * Math.PI * 2;
  const k = 1 + Math.floor( rnd() * lobes );
  for ( let i = 0; i < n; i++ ) {
    const a = ( i / n ) * Math.PI * 2;
    out[ i ] = r * ( 1 + Math.sin( a * k + ph ) * wobble * 0.6 + Math.sin( a * ( k + 3 ) + ph2 ) * wobble * 0.4 );
  }
  return out;
}

/** Random-walk polyline. Returns `[[x,y], ...]`; branches are separate lines. */
function crackLines( rnd, size, count, { len = 0.3, jitter = 0.55, branch = 0.5 } = {} ) {
  const lines = [];
  const walk = ( x, y, ang, steps, step ) => {
    const pts = [ [ x, y ] ];
    for ( let i = 0; i < steps; i++ ) {
      ang += ( rnd() - 0.5 ) * jitter;
      x += Math.cos( ang ) * step;
      y += Math.sin( ang ) * step;
      pts.push( [ x, y ] );
      if ( rnd() < branch / steps && steps > 4 ) {
        walk( x, y, ang + ( rnd() < 0.5 ? 1 : -1 ) * ( 0.5 + rnd() * 0.6 ), Math.floor( steps * 0.45 ), step );
      }
    }
    lines.push( pts );
  };
  for ( let i = 0; i < count; i++ ) {
    const steps = 8 + Math.floor( rnd() * 10 );
    walk( rnd() * size, rnd() * size, rnd() * Math.PI * 2, steps, ( size * len ) / steps );
  }
  return lines;
}

function strokePolyline( ctx, pts, width, color, alpha = 1 ) {
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for ( let i = 0; i < pts.length; i++ ) {
    if ( i ) ctx.lineTo( pts[ i ][ 0 ], pts[ i ][ 1 ] ); else ctx.moveTo( pts[ i ][ 0 ], pts[ i ][ 1 ] );
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Sine-perturbed seam that closes on itself: `k` whole cycles across the axis
 *  means the curve leaves the far edge exactly where it entered the near one. */
function seamPoints( size, along, offset, amp, k, phase, steps = 96 ) {
  const pts = [];
  for ( let i = 0; i <= steps; i++ ) {
    const t = i / steps;
    const d = offset + Math.sin( t * Math.PI * 2 * k + phase ) * amp;
    pts.push( along === 'y' ? [ d, t * size ] : [ t * size, d ] );
  }
  return pts;
}

/* ====================================================================== */
/* 1. Asphalt                                                             */
/* ====================================================================== */

const ASPHALT_DEFAULTS = {
  size: 1024, tint: 0x757a86, crackDensity: 0.6, patchiness: 0.55,
  seed: 7, anisotropy: DEFAULT_ANISOTROPY,
};

/**
 * Road surface: banded aggregate tone, tar seams, worn repair patches and a
 * faint polished tyre lane. **Tileable.**
 *
 * @param {object} [options]
 * @param {number} [options.size=1024] Square texture resolution.
 * @param {number|string} [options.tint=0x757a86] Base asphalt colour (cool grey).
 * @param {number} [options.crackDensity=0.6] 0 = pristine, 1 = heavily cracked.
 * @param {number} [options.patchiness=0.55] Strength of the large tonal patching.
 * @param {number} [options.seed=7] PRNG seed.
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture}}
 */
export function makeAsphalt( options = {} ) {
  const o = { ...ASPHALT_DEFAULTS, ...options };
  return cached( cacheKey( 'asphalt', o ), () => buildAsphalt( o ) );
}

function buildAsphalt( o ) {
  const size = o.size | 0;
  const base = toRGB( o.tint );
  const rnd = mulberry32( o.seed );
  const F = 256;

  const patch = fbmField( F, F, { periodX: 3, periodY: 3, octaves: 4, seed: o.seed, warp: 0.09 } );
  const meso = fbmField( F, F, { periodX: 10, periodY: 10, octaves: 3, seed: o.seed + 55 } );

  // Band amplitudes scale off `patchiness` but the *number* of bands never
  // changes — more patchiness must not turn four tones into a gradient.
  const k = clamp01( o.patchiness / 0.55 ) * 1.2;
  const bands = [
    [ 0.00, darken( base, 0.20 * k ) ],
    [ 0.36, darken( base, 0.08 * k ) ],
    [ 0.55, base ],
    [ 0.76, lighten( base, 0.14 * k ) ],
  ];

  const albedo = new Uint8ClampedArray( size * size * 4 );
  const rough = new Float32Array( size * size );
  const height = new Float32Array( size * size );

  for ( let y = 0; y < size; y++ ) {
    const v = y / size;
    for ( let x = 0; x < size; x++ ) {
      const u = x / size;
      const i = y * size + x;

      const p = sampleField( patch, F, F, u, v ) * 0.68 + sampleField( meso, F, F, u, v ) * 0.32;
      let col = celPick( p, bands );

      // Two polished wheel tracks. Kept well inside the tile so the falloff has
      // already reached zero at u=0 and u=1 and the lane cannot seam.
      const lane = Math.max(
        1 - smoothstep( 0.0, 0.115, Math.abs( u - 0.29 ) ),
        1 - smoothstep( 0.0, 0.115, Math.abs( u - 0.71 ) ) );
      if ( lane > 0 ) col = mixRGB( col, lighten( base, 0.10 ), lane * 0.32 );

      // Aggregate: sparse single-pixel chips, suppressed inside the polished
      // lanes where the stone has been worn smooth.
      const g = hash2( x, y, o.seed + 991 );
      const gc = hash2( x >> 1, y >> 1, o.seed + 313 );
      const grainAmt = 1 - lane * 0.65;
      let hgt = 0.5 + ( p - 0.5 ) * 0.12;
      if ( g > 0.9875 ) { col = lighten( col, 0.30 * grainAmt ); hgt += 0.22 * grainAmt; }
      else if ( g < 0.0125 ) { col = darken( col, 0.26 * grainAmt ); hgt -= 0.18 * grainAmt; }
      else if ( gc > 0.994 ) { col = lighten( col, 0.16 * grainAmt ); hgt += 0.12 * grainAmt; }

      const q = i * 4;
      albedo[ q ] = col[ 0 ]; albedo[ q + 1 ] = col[ 1 ]; albedo[ q + 2 ] = col[ 2 ]; albedo[ q + 3 ] = 255;
      rough[ i ] = clamp01( 0.90 - lane * 0.30 - ( p - 0.5 ) * 0.10 );
      height[ i ] = clamp01( hgt );
    }
  }

  const A = newSurface( size, size );
  putRGBA( A.ctx, size, size, albedo );
  const R = newSurface( size, size );
  putRGBA( R.ctx, size, size, grayBuffer( size, size, rough ) );
  const H = newSurface( size, size );
  putRGBA( H.ctx, size, size, grayBuffer( size, size, height ) );

  /* --- vector pass: patches, seams, cracks ---------------------------- */

  const patches = [];
  const nPatch = Math.round( 2 + o.patchiness * 3 );
  for ( let i = 0; i < nPatch; i++ ) {
    patches.push( {
      cx: rnd() * size, cy: rnd() * size,
      radii: blobRadii( rnd, size * ( 0.09 + rnd() * 0.10 ), 0.30, 56, 4 ),
    } );
  }

  const seams = [
    seamPoints( size, 'y', size * ( 0.18 + rnd() * 0.1 ), size * 0.012, 2, rnd() * 6.28 ),
    seamPoints( size, 'x', size * ( 0.62 + rnd() * 0.12 ), size * 0.010, 3, rnd() * 6.28 ),
  ];

  const cracks = crackLines( rnd, size, Math.round( 3 + o.crackDensity * 9 ), { len: 0.34, jitter: 0.6, branch: 0.7 } );

  const paint = ( ctx, pal ) => {
    wrapDraw( ctx, size, size, ( c ) => {
      for ( const p of patches ) {
        blobPath( c, p.cx, p.cy, p.radii );
        c.fillStyle = pal.patch;
        c.globalAlpha = pal.patchAlpha;
        c.fill();
        c.globalAlpha = 1;
        c.strokeStyle = pal.patchEdge;
        c.lineWidth = 2.5;
        c.stroke();
      }
      for ( const s of seams ) {
        strokePolyline( c, s, size * 0.011, pal.seam, 0.85 );
        strokePolyline( c, s, size * 0.004, pal.seamCore, 0.9 );
      }
      for ( const l of cracks ) {
        strokePolyline( c, l, 2.4, pal.crackEdge, 0.5 );
        strokePolyline( c, l, 1.2, pal.crack, 0.85 );
      }
    } );
  };

  paint( A.ctx, {
    patch: css( darken( base, 0.16 ) ), patchAlpha: 0.75, patchEdge: css( darken( base, 0.28 ) ),
    seam: css( darken( base, 0.34 ) ), seamCore: css( darken( base, 0.50 ) ),
    crack: css( darken( base, 0.46 ) ), crackEdge: css( lighten( base, 0.16 ) ),
  } );
  // Fresh tar is the glossiest thing on a road; cracks expose raw stone.
  paint( R.ctx, {
    patch: 'rgb(150,150,150)', patchAlpha: 0.7, patchEdge: 'rgb(180,180,180)',
    seam: 'rgb(105,105,105)', seamCore: 'rgb(80,80,80)',
    crack: 'rgb(245,245,245)', crackEdge: 'rgb(220,220,220)',
  } );
  paint( H.ctx, {
    patch: 'rgb(140,140,140)', patchAlpha: 0.55, patchEdge: 'rgb(120,120,120)',
    seam: 'rgb(96,96,96)', seamCore: 'rgb(70,70,70)',
    crack: 'rgb(40,40,40)', crackEdge: 'rgb(170,170,170)',
  } );

  return {
    map: finishTexture( A.canvas, { srgb: true, anisotropy: o.anisotropy, name: 'asphalt' } ),
    normalMap: makeNormalFromHeight( H.canvas, 0.9 ),
    roughnessMap: finishTexture( R.canvas, { srgb: false, anisotropy: o.anisotropy, name: 'asphalt-rough' } ),
  };
}

/* ====================================================================== */
/* 2. Pavement tiles                                                      */
/* ====================================================================== */

const PAVEMENT_DEFAULTS = {
  size: 1024, tilesX: 8, tilesY: 8, color: 0xd2cfd6, grout: 0x9b98a6,
  bevel: 0.10, seed: 11, anisotropy: DEFAULT_ANISOTROPY,
};

/**
 * Plaza paving slabs: recessed grout joints, a bevelled lip lit from the upper
 * left, and a flat per-slab tone drawn from four variants. **Tileable** — the
 * grid period divides the texture size exactly.
 *
 * @param {object} [options]
 * @param {number} [options.size=1024]
 * @param {number} [options.tilesX=8] Slabs across.
 * @param {number} [options.tilesY=8] Slabs down.
 * @param {number|string} [options.color=0xd2cfd6] Slab base colour.
 * @param {number|string} [options.grout=0x9b98a6] Joint colour.
 * @param {number} [options.bevel=0.10] Bevel width as a fraction of slab width.
 * @param {number} [options.seed=11]
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture}}
 */
export function makePavementTiles( options = {} ) {
  const o = { ...PAVEMENT_DEFAULTS, ...options };
  return cached( cacheKey( 'pavement', o ), () => buildPavement( o ) );
}

function buildPavement( o ) {
  const size = o.size | 0;
  const base = toRGB( o.color );
  const grout = toRGB( o.grout );
  const rnd = mulberry32( o.seed );
  const F = 256;

  const tw = size / o.tilesX, th = size / o.tilesY;
  const groutPx = Math.max( 2, tw * 0.035 );
  const bevelPx = Math.max( 2, tw * o.bevel );

  // Four flat slab tones. Two of them also shift hue slightly (one warmer, one
  // cooler) — hue variety reads as different stone batches where pure lightness
  // variety would just read as dirt.
  const tones = [
    darken( base, 0.10 ),
    hueShift( darken( base, 0.04 ), [ 214, 204, 190 ], 0.35 ),
    base,
    hueShift( lighten( base, 0.07 ), [ 196, 202, 216 ], 0.30 ),
  ];

  const grime = fbmField( F, F, { periodX: 3, periodY: 3, octaves: 3, seed: o.seed + 71, warp: 0.05 } );
  const mottle = fbmField( F, F, { periodX: 24, periodY: 24, octaves: 2, seed: o.seed + 12 } );

  const albedo = new Uint8ClampedArray( size * size * 4 );
  const rough = new Float32Array( size * size );
  const height = new Float32Array( size * size );

  for ( let y = 0; y < size; y++ ) {
    const v = y / size;
    const gy = y / th, cy = Math.floor( gy ), fy = gy - cy;
    for ( let x = 0; x < size; x++ ) {
      const u = x / size;
      const i = y * size + x;
      const gx = x / tw, cx = Math.floor( gx ), fx = gx - cx;

      const dxE = Math.min( fx, 1 - fx ) * tw;
      const dyE = Math.min( fy, 1 - fy ) * th;
      const d = Math.min( dxE, dyE );

      let col, r, hgt;

      if ( d < groutPx ) {
        // Joint. Darkest hard against the slab, opening up toward the middle —
        // that gradient is what sells the slab as sitting proud of the grout.
        const t = smoothstep( 0, 0.75, d / groutPx );
        col = mixRGB( darken( grout, 0.40 ), grout, t );
        col = darken( col, ( sampleField( mottle, F, F, u, v ) - 0.5 ) * 0.18 + 0.05 );
        r = 0.97;
        hgt = 0.18 + t * 0.10;
      } else {
        const tone = tones[ Math.floor( hash2( cx, cy, o.seed ) * tones.length ) % tones.length ];
        col = tone;

        // Two-step mottle inside the slab; quantised so it stays a pattern of
        // patches rather than photographic noise.
        const m = quantize( sampleField( mottle, F, F, u, v ), 3 );
        col = m > 0.66 ? lighten( col, 0.035 ) : m < 0.34 ? darken( col, 0.04 ) : col;

        // Bevel: upper-left lip catches the key, lower-right falls into shade.
        const bt = 1 - smoothstep( groutPx, groutPx + bevelPx, d );
        if ( bt > 0 ) {
          const vertical = dxE < dyE;
          const lit = vertical ? fx < 0.5 : fy < 0.5;
          col = lit ? lighten( col, 0.16 * bt ) : darken( col, 0.20 * bt );
          hgt = 0.55 + ( 1 - bt ) * 0.35;
        } else {
          hgt = 0.90;
        }
        r = 0.72;
      }

      // Large soft grime, two levels only. Enough to break the grid up at a
      // distance without introducing a third texture frequency.
      const gr = sampleField( grime, F, F, u, v );
      if ( gr < 0.34 ) col = darken( col, 0.07 );
      else if ( gr > 0.74 ) col = lighten( col, 0.04 );

      const s = hash2( x, y, o.seed + 5 );
      if ( s > 0.9955 ) col = lighten( col, 0.20 );
      else if ( s < 0.004 ) col = darken( col, 0.16 );

      const q = i * 4;
      albedo[ q ] = col[ 0 ]; albedo[ q + 1 ] = col[ 1 ]; albedo[ q + 2 ] = col[ 2 ]; albedo[ q + 3 ] = 255;
      rough[ i ] = r;
      height[ i ] = hgt;
    }
  }

  const A = newSurface( size, size );
  putRGBA( A.ctx, size, size, albedo );
  const R = newSurface( size, size );
  putRGBA( R.ctx, size, size, grayBuffer( size, size, rough ) );
  const H = newSurface( size, size );
  putRGBA( H.ctx, size, size, grayBuffer( size, size, height ) );

  /* --- vector pass: corner chips and hairline cracks ------------------ */

  const chips = [];
  for ( let i = 0; i < Math.round( o.tilesX * o.tilesY * 0.14 ); i++ ) {
    const cx = Math.floor( rnd() * o.tilesX ), cy = Math.floor( rnd() * o.tilesY );
    const corner = Math.floor( rnd() * 4 );
    const px = ( cx + ( corner & 1 ) ) * tw, py = ( cy + ( corner >> 1 ) ) * th;
    chips.push( { cx: px, cy: py, radii: blobRadii( rnd, tw * ( 0.06 + rnd() * 0.07 ), 0.45, 24, 3 ) } );
  }
  const cracks = crackLines( rnd, size, 3, { len: 0.16, jitter: 0.7, branch: 0.2 } );

  const paint = ( ctx, pal ) => {
    wrapDraw( ctx, size, size, ( c ) => {
      for ( const ch of chips ) {
        blobPath( c, ch.cx, ch.cy, ch.radii );
        c.fillStyle = pal.chip;
        c.fill();
      }
      for ( const l of cracks ) strokePolyline( c, l, 1.3, pal.crack, 0.6 );
    } );
  };

  paint( A.ctx, { chip: css( mixRGB( grout, base, 0.35 ) ), crack: css( darken( base, 0.34 ) ) } );
  paint( R.ctx, { chip: 'rgb(240,240,240)', crack: 'rgb(250,250,250)' } );
  paint( H.ctx, { chip: 'rgb(70,70,70)', crack: 'rgb(40,40,40)' } );

  return {
    map: finishTexture( A.canvas, { srgb: true, anisotropy: o.anisotropy, name: 'pavement' } ),
    normalMap: makeNormalFromHeight( H.canvas, 1.35 ),
    roughnessMap: finishTexture( R.canvas, { srgb: false, anisotropy: o.anisotropy, name: 'pavement-rough' } ),
  };
}

/* ====================================================================== */
/* 3. Concrete                                                            */
/* ====================================================================== */

const CONCRETE_DEFAULTS = {
  size: 1024, color: 0xc9c8d0, stain: 0.5, poreScale: 1, boards: 3,
  seed: 23, anisotropy: DEFAULT_ANISOTROPY,
};

/**
 * Cast-in-place concrete wall: shuttering board seams, form-tie plugs and the
 * vertical rain streaking that always runs from them. **Tileable.**
 *
 * @param {object} [options]
 * @param {number} [options.size=1024]
 * @param {number|string} [options.color=0xc9c8d0] Base concrete colour.
 * @param {number} [options.stain=0.5] Rain-streak and grime strength, 0–1.
 * @param {number} [options.poreScale=1] Multiplier on air-pore density.
 * @param {number} [options.boards=3] Shuttering board courses (must divide evenly).
 * @param {number} [options.seed=23]
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture}}
 */
export function makeConcrete( options = {} ) {
  const o = { ...CONCRETE_DEFAULTS, ...options };
  return cached( cacheKey( 'concrete', o ), () => buildConcrete( o ) );
}

function buildConcrete( o ) {
  const size = o.size | 0;
  const base = toRGB( o.color );
  const rnd = mulberry32( o.seed );
  const F = 256;

  const blotch = fbmField( F, F, { periodX: 3, periodY: 3, octaves: 4, seed: o.seed, warp: 0.12 } );
  const cloud = fbmField( F, F, { periodX: 7, periodY: 7, octaves: 3, seed: o.seed + 91 } );
  const pores = worleyField( 192, 192, {
    cellsX: Math.max( 8, Math.round( 44 * o.poreScale ) ),
    cellsY: Math.max( 8, Math.round( 44 * o.poreScale ) ),
    seed: o.seed + 3, mode: 'f1',
  } );

  const bands = [
    [ 0.00, darken( base, 0.11 ) ],
    [ 0.38, darken( base, 0.045 ) ],
    [ 0.60, base ],
    [ 0.80, lighten( base, 0.07 ) ],
  ];

  const albedo = new Uint8ClampedArray( size * size * 4 );
  const rough = new Float32Array( size * size );
  const height = new Float32Array( size * size );

  for ( let y = 0; y < size; y++ ) {
    const v = y / size;
    for ( let x = 0; x < size; x++ ) {
      const u = x / size;
      const i = y * size + x;

      const b = sampleField( blotch, F, F, u, v ) * 0.6 + sampleField( cloud, F, F, u, v ) * 0.4;
      let col = celPick( b, bands );

      let hgt = 0.72 + ( b - 0.5 ) * 0.10;
      let r = 0.93;

      // Air pockets. Only the deepest part of each Worley cell becomes a pore,
      // which keeps them as discrete little holes instead of a cellular pattern.
      const pv = sampleField( pores, 192, 192, u, v );
      if ( pv < 0.11 ) {
        const t = 1 - pv / 0.11;
        col = darken( col, 0.30 * t );
        hgt -= 0.30 * t;
        r = 0.98;
      }

      const s = hash2( x, y, o.seed + 17 );
      if ( s > 0.9975 ) { col = darken( col, 0.22 ); hgt -= 0.10; }
      else if ( s < 0.0022 ) col = lighten( col, 0.14 );

      const q = i * 4;
      albedo[ q ] = col[ 0 ]; albedo[ q + 1 ] = col[ 1 ]; albedo[ q + 2 ] = col[ 2 ]; albedo[ q + 3 ] = 255;
      rough[ i ] = r;
      height[ i ] = clamp01( hgt );
    }
  }

  const A = newSurface( size, size );
  putRGBA( A.ctx, size, size, albedo );
  const R = newSurface( size, size );
  putRGBA( R.ctx, size, size, grayBuffer( size, size, rough ) );
  const H = newSurface( size, size );
  putRGBA( H.ctx, size, size, grayBuffer( size, size, height ) );

  /* --- vector pass ----------------------------------------------------- */

  const boardH = size / o.boards;
  const seamYs = [];
  for ( let j = 0; j < o.boards; j++ ) seamYs.push( j * boardH );

  const ties = [];
  const tieCols = 4;
  for ( let j = 0; j < o.boards; j++ ) {
    for ( let i = 0; i < tieCols; i++ ) {
      ties.push( { x: ( i + 0.5 ) * ( size / tieCols ), y: j * boardH + boardH * 0.5 } );
    }
  }

  // Streaks only ever start at a seam or a tie and are clipped so their fade
  // completes before the bottom edge — a streak cut off mid-fade would show as
  // a bright line where the tile repeats.
  const streaks = [];
  const nStreak = Math.round( 26 * o.stain );
  for ( let i = 0; i < nStreak; i++ ) {
    const fromTie = rnd() < 0.45 && ties.length > 0;
    const src = fromTie ? ties[ Math.floor( rnd() * ties.length ) ] : null;
    const sx = src ? src.x + ( rnd() - 0.5 ) * 14 : rnd() * size;
    const sy = src ? src.y + 6 : seamYs[ Math.floor( rnd() * seamYs.length ) ];
    const len = Math.min( size * ( 0.10 + rnd() * 0.26 ), size - sy - 4 );
    if ( len < size * 0.05 ) continue;
    streaks.push( { x: sx, y: sy, w: 4 + rnd() * ( fromTie ? 10 : 26 ), len, a: 0.10 + rnd() * 0.16 } );
  }

  const paint = ( ctx, pal ) => {
    wrapDraw( ctx, size, size, ( c ) => {
      // Streaks first so seams and plugs stay crisp on top of them.
      for ( const st of streaks ) {
        const g = c.createLinearGradient( 0, st.y, 0, st.y + st.len );
        g.addColorStop( 0, pal.streak( st.a * 0.6 ) );
        g.addColorStop( 0.25, pal.streak( st.a ) );
        g.addColorStop( 1, pal.streak( 0 ) );
        c.fillStyle = g;
        c.fillRect( st.x - st.w * 0.5, st.y, st.w, st.len );
      }
      for ( const sy of seamYs ) {
        c.fillStyle = pal.seam;
        c.fillRect( 0, sy - 1, size, 3 );
        c.fillStyle = pal.seamLip;
        c.fillRect( 0, sy + 2, size, 2 );
      }
      for ( const t of ties ) {
        const r = size * 0.012;
        c.beginPath(); c.arc( t.x, t.y, r, 0, Math.PI * 2 );
        c.fillStyle = pal.tieRing; c.fill();
        c.beginPath(); c.arc( t.x, t.y, r * 0.66, 0, Math.PI * 2 );
        c.fillStyle = pal.tiePlug; c.fill();
        c.beginPath(); c.arc( t.x, t.y - r * 0.22, r * 0.66, Math.PI * 1.1, Math.PI * 1.9 );
        c.strokeStyle = pal.tieShade; c.lineWidth = 2; c.stroke();
      }
    } );
  };

  const dark = darken( base, 0.30 );
  paint( A.ctx, {
    streak: ( a ) => css( darken( base, 0.34 ), a ),
    seam: css( darken( base, 0.26 ) ), seamLip: css( lighten( base, 0.10 ) ),
    tieRing: css( darken( base, 0.22 ) ), tiePlug: css( lighten( base, 0.05 ) ),
    tieShade: css( dark, 0.5 ),
  } );
  paint( R.ctx, {
    streak: ( a ) => `rgba(120,120,120,${a * 1.4})`,
    seam: 'rgb(250,250,250)', seamLip: 'rgb(235,235,235)',
    tieRing: 'rgb(250,250,250)', tiePlug: 'rgb(215,215,215)', tieShade: 'rgba(255,255,255,0.5)',
  } );
  paint( H.ctx, {
    streak: ( a ) => `rgba(150,150,150,${a * 0.5})`,
    seam: 'rgb(60,60,60)', seamLip: 'rgb(215,215,215)',
    tieRing: 'rgb(90,90,90)', tiePlug: 'rgb(140,140,140)', tieShade: 'rgba(50,50,50,0.6)',
  } );

  return {
    map: finishTexture( A.canvas, { srgb: true, anisotropy: o.anisotropy, name: 'concrete' } ),
    normalMap: makeNormalFromHeight( H.canvas, 1.1 ),
    roughnessMap: finishTexture( R.canvas, { srgb: false, anisotropy: o.anisotropy, name: 'concrete-rough' } ),
  };
}

/* ====================================================================== */
/* 4. Painted metal                                                       */
/* ====================================================================== */

const METAL_DEFAULTS = {
  size: 512, color: 0x4d6fa6, primer: 0xb08a63, wear: 0.4, panelLines: 2,
  seed: 31, anisotropy: DEFAULT_ANISOTROPY,
};

/**
 * Painted steel plate: recessed panel-line grooves with a lit lower lip, rows
 * of rivets, and chipping that biases toward the grooves and rivet heads where
 * paint actually fails. Chips reveal a warm primer coat under the top colour.
 *
 * Panel lines are placed at `i * size / panelLines` starting at zero, so the
 * line on the left edge is the same line as the one on the right — the plate
 * tiles.
 *
 * @param {object} [options]
 * @param {number} [options.size=512]
 * @param {number|string} [options.color=0x4d6fa6] Top-coat colour.
 * @param {number|string} [options.primer=0xb08a63] Colour revealed by chips.
 * @param {number} [options.wear=0.4] 0 = factory fresh, 1 = derelict.
 * @param {number} [options.panelLines=2] Panel divisions per axis.
 * @param {number} [options.seed=31]
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture}}
 */
export function makePaintedMetal( options = {} ) {
  const o = { ...METAL_DEFAULTS, ...options };
  return cached( cacheKey( 'paintedMetal', o ), () => buildPaintedMetal( o ) );
}

function buildPaintedMetal( o ) {
  const size = o.size | 0;
  const base = toRGB( o.color );
  const primer = toRGB( o.primer );
  const rnd = mulberry32( o.seed );
  const F = 128;

  const wash = fbmField( F, F, { periodX: 3, periodY: 3, octaves: 3, seed: o.seed, warp: 0.08 } );
  const grime = fbmField( F, F, { periodX: 8, periodY: 8, octaves: 2, seed: o.seed + 44 } );

  const albedo = new Uint8ClampedArray( size * size * 4 );
  const rough = new Float32Array( size * size );
  const height = new Float32Array( size * size );

  for ( let y = 0; y < size; y++ ) {
    const v = y / size;
    for ( let x = 0; x < size; x++ ) {
      const u = x / size;
      const i = y * size + x;

      // Paint is a manufactured finish: three very close tones, no grain.
      const w = quantize( sampleField( wash, F, F, u, v ) * 0.7 + sampleField( grime, F, F, u, v ) * 0.3, 3 );
      let col = w > 0.66 ? lighten( base, 0.05 ) : w < 0.34 ? darken( base, 0.06 ) : base;

      const q = i * 4;
      albedo[ q ] = col[ 0 ]; albedo[ q + 1 ] = col[ 1 ]; albedo[ q + 2 ] = col[ 2 ]; albedo[ q + 3 ] = 255;
      rough[ i ] = 0.34;
      height[ i ] = 0.78;
    }
  }

  const A = newSurface( size, size );
  putRGBA( A.ctx, size, size, albedo );
  const R = newSurface( size, size );
  putRGBA( R.ctx, size, size, grayBuffer( size, size, rough ) );
  const H = newSurface( size, size );
  putRGBA( H.ctx, size, size, grayBuffer( size, size, height ) );

  /* --- vector pass ----------------------------------------------------- */

  const step = size / o.panelLines;
  const lines = [];
  for ( let i = 0; i < o.panelLines; i++ ) {
    lines.push( { axis: 'x', at: i * step } );
    lines.push( { axis: 'y', at: i * step } );
  }

  const rivetPitch = Math.max( 22, size / 16 );
  const rivets = [];
  for ( const l of lines ) {
    const n = Math.round( size / rivetPitch );
    for ( let i = 0; i < n; i++ ) {
      const t = ( i + 0.5 ) * ( size / n );
      const off = 7;
      rivets.push( l.axis === 'x' ? { x: l.at + off, y: t } : { x: t, y: l.at + off } );
    }
  }

  // Chips cluster on the grooves and rivets because that is where an edge
  // exists for paint to lift from; a uniform scatter reads as dirt, not damage.
  const chips = [];
  const nChip = Math.round( o.wear * 70 );
  for ( let i = 0; i < nChip; i++ ) {
    let cx, cy;
    const roll = rnd();
    if ( roll < 0.45 ) {
      const l = lines[ Math.floor( rnd() * lines.length ) ];
      const t = rnd() * size;
      const j = ( rnd() - 0.5 ) * 18;
      cx = l.axis === 'x' ? l.at + j : t;
      cy = l.axis === 'x' ? t : l.at + j;
    } else if ( roll < 0.7 && rivets.length ) {
      const rv = rivets[ Math.floor( rnd() * rivets.length ) ];
      cx = rv.x + ( rnd() - 0.5 ) * 14;
      cy = rv.y + ( rnd() - 0.5 ) * 14;
    } else {
      cx = rnd() * size; cy = rnd() * size;
    }
    chips.push( { cx, cy, radii: blobRadii( rnd, 2 + rnd() * ( 5 + o.wear * 6 ), 0.55, 20, 3 ) } );
  }

  const scratches = [];
  for ( let i = 0; i < Math.round( o.wear * 18 ); i++ ) {
    const x = rnd() * size, y = rnd() * size;
    const a = rnd() * Math.PI * 2, len = 12 + rnd() * 70;
    scratches.push( [ [ x, y ], [ x + Math.cos( a ) * len, y + Math.sin( a ) * len ] ] );
  }

  const paint = ( ctx, pal ) => {
    wrapDraw( ctx, size, size, ( c ) => {
      for ( const l of lines ) {
        // Groove core, then a bright lip on the lower/right side: the classic
        // two-pixel trick that makes a flat line read as a cut.
        if ( l.axis === 'x' ) {
          c.fillStyle = pal.groove; c.fillRect( l.at - 1.5, 0, 3, size );
          c.fillStyle = pal.lip; c.fillRect( l.at + 1.5, 0, 1.5, size );
        } else {
          c.fillStyle = pal.groove; c.fillRect( 0, l.at - 1.5, size, 3 );
          c.fillStyle = pal.lip; c.fillRect( 0, l.at + 1.5, size, 1.5 );
        }
      }
      for ( const s of scratches ) strokePolyline( c, s, 1, pal.scratch, 0.35 );
      for ( const ch of chips ) {
        blobPath( c, ch.cx, ch.cy, ch.radii );
        c.fillStyle = pal.chip; c.fill();
        c.strokeStyle = pal.chipEdge; c.lineWidth = 1.2; c.stroke();
      }
      const rr = Math.max( 2.6, size / 170 );
      for ( const rv of rivets ) {
        c.beginPath(); c.arc( rv.x, rv.y, rr + 1, 0, Math.PI * 2 );
        c.fillStyle = pal.rivetShade; c.fill();
        c.beginPath(); c.arc( rv.x, rv.y, rr, 0, Math.PI * 2 );
        c.fillStyle = pal.rivet; c.fill();
        c.beginPath(); c.arc( rv.x - rr * 0.22, rv.y - rr * 0.22, rr * 0.55, 0, Math.PI * 2 );
        c.fillStyle = pal.rivetHi; c.fill();
      }
    } );
  };

  paint( A.ctx, {
    groove: css( darken( base, 0.48 ) ), lip: css( lighten( base, 0.22 ) ),
    scratch: css( lighten( base, 0.40 ) ),
    chip: css( primer ), chipEdge: css( darken( base, 0.38 ) ),
    rivetShade: css( darken( base, 0.34 ) ), rivet: css( base ), rivetHi: css( lighten( base, 0.26 ) ),
  } );
  paint( R.ctx, {
    groove: 'rgb(130,130,130)', lip: 'rgb(96,96,96)',
    scratch: 'rgb(180,180,180)',
    chip: 'rgb(225,225,225)', chipEdge: 'rgb(160,160,160)',
    rivetShade: 'rgb(110,110,110)', rivet: 'rgb(86,86,86)', rivetHi: 'rgb(70,70,70)',
  } );
  paint( H.ctx, {
    groove: 'rgb(40,40,40)', lip: 'rgb(215,215,215)',
    scratch: 'rgb(120,120,120)',
    chip: 'rgb(150,150,150)', chipEdge: 'rgb(120,120,120)',
    rivetShade: 'rgb(120,120,120)', rivet: 'rgb(225,225,225)', rivetHi: 'rgb(255,255,255)',
  } );

  return {
    map: finishTexture( A.canvas, { srgb: true, anisotropy: o.anisotropy, name: 'paintedMetal' } ),
    normalMap: makeNormalFromHeight( H.canvas, 1.6 ),
    roughnessMap: finishTexture( R.canvas, { srgb: false, anisotropy: o.anisotropy, name: 'paintedMetal-rough' } ),
  };
}

/* ====================================================================== */
/* 5. Brick                                                               */
/* ====================================================================== */

const BRICK_DEFAULTS = {
  size: 1024, rows: 16, cols: 8, brickColor: 0xb5674f, mortar: 0xdcd6c9,
  variation: 1, seed: 5, anisotropy: DEFAULT_ANISOTROPY,
};

/**
 * Running-bond brick. Every other course is offset by half a brick; with an
 * even `rows` count that offset wraps, so the wall is **tileable**.
 *
 * Bricks are painted as flat tones drawn from a five-entry palette (two hue
 * variants, three value variants) rather than as noise-shaded solids — a brick
 * wall in an anime background is a mosaic of flat chips of colour.
 *
 * @param {object} [options]
 * @param {number} [options.size=1024]
 * @param {number} [options.rows=16] Courses (keep even for the bond to wrap).
 * @param {number} [options.cols=8] Bricks per course.
 * @param {number|string} [options.brickColor=0xb5674f]
 * @param {number|string} [options.mortar=0xdcd6c9]
 * @param {number} [options.variation=1] Spread of the per-brick tone palette.
 * @param {number} [options.seed=5]
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture}}
 */
export function makeBrick( options = {} ) {
  const o = { ...BRICK_DEFAULTS, ...options };
  return cached( cacheKey( 'brick', o ), () => buildBrick( o ) );
}

function buildBrick( o ) {
  const size = o.size | 0;
  const base = toRGB( o.brickColor );
  const mortar = toRGB( o.mortar );
  const rnd = mulberry32( o.seed );
  const F = 256;
  const vr = o.variation;

  const tones = [
    darken( base, 0.22 * vr ),
    hueShift( darken( base, 0.10 * vr ), [ 150, 110, 105 ], 0.45 * vr ),
    base,
    hueShift( lighten( base, 0.10 * vr ), [ 214, 150, 110 ], 0.35 * vr ),
    lighten( base, 0.18 * vr ),
  ];

  const bh = size / o.rows, bw = size / o.cols;
  const jointPx = Math.max( 3, bh * 0.15 );
  const grime = fbmField( F, F, { periodX: 3, periodY: 3, octaves: 3, seed: o.seed + 61, warp: 0.06 } );
  const fine = fbmField( F, F, { periodX: 40, periodY: 40, octaves: 2, seed: o.seed + 7 } );

  const albedo = new Uint8ClampedArray( size * size * 4 );
  const rough = new Float32Array( size * size );
  const height = new Float32Array( size * size );

  for ( let y = 0; y < size; y++ ) {
    const v = y / size;
    const ry = y / bh, row = Math.floor( ry ), fy = ry - row;
    const off = ( row & 1 ) * 0.5;
    for ( let x = 0; x < size; x++ ) {
      const u = x / size;
      const i = y * size + x;
      const cxf = x / bw + off, col0 = Math.floor( cxf ), fx = cxf - col0;

      const dxE = Math.min( fx, 1 - fx ) * bw;
      const dyE = Math.min( fy, 1 - fy ) * bh;
      const d = Math.min( dxE, dyE );

      let col, r, hgt;

      if ( d < jointPx ) {
        const t = smoothstep( 0, 0.8, d / jointPx );
        col = mixRGB( darken( mortar, 0.42 ), mortar, t );
        col = darken( col, ( sampleField( fine, F, F, u, v ) - 0.5 ) * 0.16 + 0.04 );
        r = 0.97;
        hgt = 0.15 + t * 0.14;
      } else {
        col = tones[ Math.floor( hash2( col0, row, o.seed ) * tones.length ) % tones.length ];

        // Flat interior with one subtle secondary step, plus firing specks.
        const f = quantize( sampleField( fine, F, F, u, v ), 3 );
        if ( f > 0.66 ) col = lighten( col, 0.05 );
        else if ( f < 0.34 ) col = darken( col, 0.05 );

        const s = hash2( x, y, o.seed + 29 );
        if ( s > 0.995 ) col = lighten( col, 0.22 );
        else if ( s < 0.005 ) col = darken( col, 0.18 );

        // Arris highlight/shade: 3 px of light on the top edge and shade on the
        // bottom, which is all it takes to make each brick sit proud.
        const bt = 1 - smoothstep( jointPx, jointPx + 4, d );
        if ( bt > 0 ) {
          const vertical = dxE < dyE;
          const lit = vertical ? fx < 0.5 : fy < 0.5;
          col = lit ? lighten( col, 0.13 * bt ) : darken( col, 0.16 * bt );
        }
        r = 0.86;
        hgt = 0.88 - bt2( d, jointPx ) * 0.12;
      }

      const gr = sampleField( grime, F, F, u, v );
      if ( gr < 0.30 ) col = darken( col, 0.09 );
      else if ( gr > 0.78 ) col = lighten( col, 0.05 );

      const q = i * 4;
      albedo[ q ] = col[ 0 ]; albedo[ q + 1 ] = col[ 1 ]; albedo[ q + 2 ] = col[ 2 ]; albedo[ q + 3 ] = 255;
      rough[ i ] = r;
      height[ i ] = hgt;
    }
  }

  const A = newSurface( size, size );
  putRGBA( A.ctx, size, size, albedo );
  const R = newSurface( size, size );
  putRGBA( R.ctx, size, size, grayBuffer( size, size, rough ) );
  const H = newSurface( size, size );
  putRGBA( H.ctx, size, size, grayBuffer( size, size, height ) );

  /* --- vector pass: chipped corners and a couple of stepped cracks ----- */

  const chips = [];
  for ( let i = 0; i < Math.round( o.rows * o.cols * 0.06 ); i++ ) {
    const row = Math.floor( rnd() * o.rows );
    const c0 = Math.floor( rnd() * o.cols );
    const cx = ( c0 + ( rnd() < 0.5 ? 0 : 1 ) - ( row & 1 ) * 0.5 ) * bw;
    const cy = ( row + ( rnd() < 0.5 ? 0 : 1 ) ) * bh;
    chips.push( { cx, cy, radii: blobRadii( rnd, bh * ( 0.14 + rnd() * 0.16 ), 0.5, 20, 3 ) } );
  }
  const cracks = crackLines( rnd, size, 2, { len: 0.20, jitter: 0.9, branch: 0.3 } );

  const paint = ( ctx, pal ) => {
    wrapDraw( ctx, size, size, ( c ) => {
      for ( const ch of chips ) {
        blobPath( c, ch.cx, ch.cy, ch.radii );
        c.fillStyle = pal.chip; c.fill();
      }
      for ( const l of cracks ) strokePolyline( c, l, 1.6, pal.crack, 0.55 );
    } );
  };

  paint( A.ctx, { chip: css( mixRGB( mortar, base, 0.30 ) ), crack: css( darken( base, 0.40 ) ) } );
  paint( R.ctx, { chip: 'rgb(248,248,248)', crack: 'rgb(250,250,250)' } );
  paint( H.ctx, { chip: 'rgb(60,60,60)', crack: 'rgb(35,35,35)' } );

  return {
    map: finishTexture( A.canvas, { srgb: true, anisotropy: o.anisotropy, name: 'brick' } ),
    normalMap: makeNormalFromHeight( H.canvas, 1.5 ),
    roughnessMap: finishTexture( R.canvas, { srgb: false, anisotropy: o.anisotropy, name: 'brick-rough' } ),
  };
}

/** Bevel ramp helper shared by the masonry generators. */
function bt2( d, jointPx ) {
  return 1 - smoothstep( jointPx, jointPx + 4, d );
}

/* ====================================================================== */
/* 6. Fabric twill                                                        */
/* ====================================================================== */

/** Largest divisor of `n` nearest to `target`. Weave, mesh and grid periods
 *  must divide the texture size exactly or the pattern cannot tile. */
function nearestDivisor( n, target ) {
  let best = 1, bd = Infinity;
  for ( let d = 1; d <= n; d++ ) {
    if ( n % d ) continue;
    const diff = Math.abs( d - target );
    if ( diff < bd ) { bd = diff; best = d; }
  }
  return best;
}

const TWILL_DEFAULTS = {
  size: 512, color: 0x2b3350, weaveScale: 2, contrast: 1, seed: 13,
  anisotropy: DEFAULT_ANISOTROPY,
};

/**
 * School-uniform 2/2 twill. Warp threads float over two wefts and each course
 * shifts by one thread, which is what produces the diagonal wale — the pattern
 * is generated from that interlacement rule rather than by drawing diagonal
 * lines, so the ribbing has the correct broken, threaded edge. **Tileable**
 * (the four-thread repeat is snapped to a divisor of `size`).
 *
 * Amplitude is deliberately tiny: a uniform should read as a flat colour with a
 * whisper of structure at close range and as pure flat colour at gameplay
 * distance.
 *
 * @param {object} [options]
 * @param {number} [options.size=512]
 * @param {number|string} [options.color=0x2b3350] Cloth colour.
 * @param {number} [options.weaveScale=2] Pixels per thread.
 * @param {number} [options.contrast=1] Multiplier on the weave shading.
 * @param {number} [options.seed=13]
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture}}
 */
export function makeFabricTwill( options = {} ) {
  const o = { ...TWILL_DEFAULTS, ...options };
  return cached( cacheKey( 'twill', o ), () => buildTwill( o ) );
}

function buildTwill( o ) {
  const size = o.size | 0;
  const base = toRGB( o.color );
  const F = 128;
  // The interlacement repeats every four threads, so the repeat that has to
  // divide the texture is 4 * threadPx.
  const threadPx = Math.max( 1, nearestDivisor( size / 4, o.weaveScale ) );

  const cloth = fbmField( F, F, { periodX: 6, periodY: 6, octaves: 3, seed: o.seed } );

  const albedo = new Uint8ClampedArray( size * size * 4 );
  const height = new Float32Array( size * size );
  const rough = new Float32Array( size * size );

  for ( let y = 0; y < size; y++ ) {
    const v = y / size;
    const ty = Math.floor( y / threadPx );
    const py = y / threadPx - ty;
    for ( let x = 0; x < size; x++ ) {
      const u = x / size;
      const i = y * size + x;
      const tx = Math.floor( x / threadPx );
      const px = x / threadPx - tx;

      const warpOver = wrapi( tx - ty, 4 ) < 2;
      // Cylindrical cross-section of whichever thread is on top.
      const cross = warpOver ? 1 - Math.abs( px - 0.5 ) * 2 : 1 - Math.abs( py - 0.5 ) * 2;
      let s = ( cross - 0.5 ) * 0.9 + ( warpOver ? 0.30 : -0.30 );
      s = quantize( s * 0.5 + 0.5, 5 ) * 2 - 1;

      const amp = 0.085 * o.contrast;
      let col = s >= 0 ? lighten( base, s * amp ) : darken( base, -s * amp * 1.15 );

      // Very slow dye/weight variation so large panels of cloth are not
      // perfectly uniform under a flat toon light.
      const c = quantize( sampleField( cloth, F, F, u, v ), 3 );
      if ( c > 0.66 ) col = lighten( col, 0.018 );
      else if ( c < 0.34 ) col = darken( col, 0.02 );

      const q = i * 4;
      albedo[ q ] = col[ 0 ]; albedo[ q + 1 ] = col[ 1 ]; albedo[ q + 2 ] = col[ 2 ]; albedo[ q + 3 ] = 255;
      height[ i ] = 0.5 + s * 0.45;
      rough[ i ] = 0.90 - s * 0.05;
    }
  }

  const A = newSurface( size, size );
  putRGBA( A.ctx, size, size, albedo );
  const H = newSurface( size, size );
  putRGBA( H.ctx, size, size, grayBuffer( size, size, height ) );
  const R = newSurface( size, size );
  putRGBA( R.ctx, size, size, grayBuffer( size, size, rough ) );

  return {
    map: finishTexture( A.canvas, { srgb: true, anisotropy: o.anisotropy, name: 'twill' } ),
    normalMap: makeNormalFromHeight( H.canvas, 0.45 ),
    roughnessMap: finishTexture( R.canvas, { srgb: false, anisotropy: o.anisotropy, name: 'twill-rough' } ),
  };
}

/* ====================================================================== */
/* 7. Pleated skirt                                                       */
/* ====================================================================== */

const SKIRT_DEFAULTS = {
  width: 1024, height: 512, color: 0x39456b, pleats: 16, shadeStrength: 1,
  trim: 0xf4f6fb, seed: 17, anisotropy: DEFAULT_ANISOTROPY,
};

/**
 * UV-space skirt sheet: `pleats` repeats across U, waistband at the top and hem
 * at the bottom of V.
 *
 * The fold is authored as a hard band profile rather than a smooth gradient.
 * Anime pleats are read as: crease line, shadow face, mid face, lit face, a
 * bright edge where the front face turns over, then straight back into the next
 * crease. Fold depth ramps toward the hem, where the pleats open out.
 *
 * **Tiles horizontally only.** `wrapT` is `ClampToEdge` — repeating vertically
 * would stack a hem on top of a waistband.
 *
 * @param {object} [options]
 * @param {number} [options.width=1024]
 * @param {number} [options.height=512]
 * @param {number|string} [options.color=0x39456b] Skirt colour.
 * @param {number} [options.pleats=16] Pleat count across U.
 * @param {number} [options.shadeStrength=1] Fold contrast multiplier.
 * @param {number|string} [options.trim=0xf4f6fb] Hem stripe colour.
 * @param {number} [options.seed=17]
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture}}
 */
export function makePleatedSkirt( options = {} ) {
  const o = { ...SKIRT_DEFAULTS, ...options };
  return cached( cacheKey( 'skirt', o ), () => buildSkirt( o ) );
}

// [ start of band across the pleat, tonal level in -1..+1 ]
const PLEAT_PROFILE = [
  [ 0.00, -1.00 ],  // crease core
  [ 0.05, -0.66 ],  // shadow face
  [ 0.25, -0.30 ],  // mid face
  [ 0.44, 0.00 ],   // base face
  [ 0.74, 0.20 ],   // face turning to the light
  [ 0.86, 0.55 ],   // bright fold edge
  [ 0.94, -0.40 ],  // drop back into the next crease
];

function pleatLevel( t ) {
  let lv = PLEAT_PROFILE[ 0 ][ 1 ];
  for ( let i = 1; i < PLEAT_PROFILE.length; i++ ) {
    if ( t >= PLEAT_PROFILE[ i ][ 0 ] ) lv = PLEAT_PROFILE[ i ][ 1 ]; else break;
  }
  return lv;
}

function buildSkirt( o ) {
  const W = o.width | 0, H = o.height | 0;
  const base = toRGB( o.color );
  const trim = toRGB( o.trim );
  const F = 128;
  const threadPx = Math.max( 1, nearestDivisor( Math.min( W, H ) / 4, 2 ) );

  const cloth = fbmField( F, F, { periodX: 5, periodY: 3, octaves: 3, seed: o.seed } );
  const pw = W / o.pleats;

  const albedo = new Uint8ClampedArray( W * H * 4 );
  const height = new Float32Array( W * H );
  const rough = new Float32Array( W * H );

  const waist = 0.075, hem = 0.90, edge = 0.975;

  for ( let y = 0; y < H; y++ ) {
    const v = y / H;
    const ty = Math.floor( y / threadPx );
    const py = y / threadPx - ty;

    // Folds are shallow where the fabric is pinched into the waistband and deep
    // where it hangs free.
    const depth = lerp( 0.45, 1.0, smoothstep( waist, 0.75, v ) );

    for ( let x = 0; x < W; x++ ) {
      const u = x / W;
      const i = y * W + x;
      const t = x / pw - Math.floor( x / pw );

      let lv = pleatLevel( t ) * depth * o.shadeStrength;
      let col;

      if ( v < waist ) {
        // Flat waistband: one lighter tone, its own bottom shadow line.
        col = lighten( base, 0.10 );
        if ( v > waist - 0.012 ) col = darken( base, 0.45 );
        lv = 0;
      } else {
        col = lv >= 0 ? lighten( base, lv * 0.30 ) : darken( base, -lv * 0.44 );
        // Ambient occlusion under the waistband seam.
        col = darken( col, 0.22 * ( 1 - smoothstep( waist, waist + 0.06, v ) ) );
      }

      if ( v >= hem && v < edge ) {
        // Hem band: the fabric doubles back, so it sits a step darker and the
        // pleat shading flattens out across it.
        col = mixRGB( col, darken( base, 0.18 ), 0.7 );
        if ( v < hem + 0.010 ) col = mixRGB( trim, base, 0.35 );
      } else if ( v >= edge ) {
        col = darken( base, 0.55 );
      }

      // Twill weave, barely there, using the same interlacement as makeFabricTwill.
      const tx = Math.floor( x / threadPx );
      const px = x / threadPx - tx;
      const warpOver = wrapi( tx - ty, 4 ) < 2;
      const cross = warpOver ? 1 - Math.abs( px - 0.5 ) * 2 : 1 - Math.abs( py - 0.5 ) * 2;
      const ws = ( cross - 0.5 ) * 0.9 + ( warpOver ? 0.3 : -0.3 );
      col = ws >= 0 ? lighten( col, ws * 0.05 ) : darken( col, -ws * 0.055 );

      const c = quantize( sampleField( cloth, F, F, u, v ), 3 );
      if ( c > 0.7 ) col = lighten( col, 0.02 );
      else if ( c < 0.3 ) col = darken( col, 0.022 );

      const q = i * 4;
      albedo[ q ] = col[ 0 ]; albedo[ q + 1 ] = col[ 1 ]; albedo[ q + 2 ] = col[ 2 ]; albedo[ q + 3 ] = 255;
      height[ i ] = clamp01( 0.5 + lv * 0.42 + ws * 0.05 );
      rough[ i ] = 0.88;
    }
  }

  const A = newSurface( W, H );
  putRGBA( A.ctx, W, H, albedo );
  const Hc = newSurface( W, H );
  putRGBA( Hc.ctx, W, H, grayBuffer( W, H, height ) );
  const R = newSurface( W, H );
  putRGBA( R.ctx, W, H, grayBuffer( W, H, rough ) );

  const map = finishTexture( A.canvas, {
    srgb: true, wrapT: THREE.ClampToEdgeWrapping, anisotropy: o.anisotropy, name: 'skirt',
  } );
  const normalMap = makeNormalFromHeight( Hc.canvas, 0.8 );
  normalMap.wrapT = THREE.ClampToEdgeWrapping;
  const roughnessMap = finishTexture( R.canvas, {
    srgb: false, wrapT: THREE.ClampToEdgeWrapping, anisotropy: o.anisotropy, name: 'skirt-rough',
  } );

  return { map, normalMap, roughnessMap };
}

/* ====================================================================== */
/* 8. Grass                                                               */
/* ====================================================================== */

const GRASS_DEFAULTS = {
  size: 1024, base: 0x77b657, blades: 2600, clumping: 1, flowers: 0,
  seed: 3, anisotropy: DEFAULT_ANISOTROPY,
};

/**
 * Stylised anime lawn: a flat mid-green ground painted in four bands, then
 * hand-struck blade marks on top.
 *
 * The blade strokes sample the band field at their own position and pick a
 * colour one step off the *local* tone rather than a global one. Strokes that
 * ignore the underlying patch read as noise scattered over the ground; strokes
 * that follow it read as grass growing out of it. **Tileable.**
 *
 * @param {object} [options]
 * @param {number} [options.size=1024]
 * @param {number|string} [options.base=0x77b657] Mid-green base.
 * @param {number} [options.blades=2600] Blade stroke count.
 * @param {number} [options.clumping=1] Patch contrast multiplier.
 * @param {number} [options.flowers=0] Density of small pale flower dots, 0–1.
 * @param {number} [options.seed=3]
 * @returns {{map: THREE.CanvasTexture, normalMap: THREE.CanvasTexture, roughnessMap: THREE.CanvasTexture}}
 */
export function makeGrass( options = {} ) {
  const o = { ...GRASS_DEFAULTS, ...options };
  return cached( cacheKey( 'grass', o ), () => buildGrass( o ) );
}

function buildGrass( o ) {
  const size = o.size | 0;
  const base = toRGB( o.base );
  const rnd = mulberry32( o.seed );
  const F = 256;
  const k = o.clumping;

  // Tonal steps move in hue as well as value: shadowed grass goes blue-green,
  // sunlit grass goes yellow-green. Pure value steps look like a dirty lawn.
  const tones = [
    hueShift( darken( base, 0.30 * k ), [ 74, 122, 108 ], 0.40 ),
    darken( base, 0.15 * k ),
    base,
    hueShift( lighten( base, 0.15 * k ), [ 206, 219, 108 ], 0.38 ),
  ];

  const patch = fbmField( F, F, { periodX: 3, periodY: 3, octaves: 4, seed: o.seed, warp: 0.18 } );
  const meso = fbmField( F, F, { periodX: 9, periodY: 9, octaves: 3, seed: o.seed + 200 } );
  const field = new Float32Array( F * F );
  for ( let i = 0; i < field.length; i++ ) field[ i ] = patch[ i ] * 0.62 + meso[ i ] * 0.38;

  const bands = [ [ 0.00, 0 ], [ 0.34, 1 ], [ 0.56, 2 ], [ 0.78, 3 ] ];
  const toneAt = ( f ) => tones[ celPick( f, bands ) ];
  const idxAt = ( f ) => celPick( f, bands );

  const albedo = new Uint8ClampedArray( size * size * 4 );
  for ( let y = 0; y < size; y++ ) {
    const v = y / size;
    for ( let x = 0; x < size; x++ ) {
      const u = x / size;
      const f = sampleField( field, F, F, u, v );
      const col = toneAt( f );
      const q = ( y * size + x ) * 4;
      albedo[ q ] = col[ 0 ]; albedo[ q + 1 ] = col[ 1 ]; albedo[ q + 2 ] = col[ 2 ]; albedo[ q + 3 ] = 255;
    }
  }

  const A = newSurface( size, size );
  putRGBA( A.ctx, size, size, albedo );
  const H = newSurface( size, size );
  H.ctx.fillStyle = 'rgb(128,128,128)';
  H.ctx.fillRect( 0, 0, size, size );

  /* --- blade strokes --------------------------------------------------- */

  const strokes = [];
  const scale = size / 1024;
  for ( let i = 0; i < o.blades; i++ ) {
    const x = rnd() * size, y = rnd() * size;
    const f = sampleField( field, F, F, x / size, y / size );
    const idx = idxAt( f );
    // Two thirds shadow strokes, one third highlight: grass reads as dark marks
    // on a light ground far more than the reverse.
    const up = rnd() < 0.34;
    const ti = clamp01( ( idx + ( up ? 1 : -1 ) ) / 3 ) * 3;
    const col = tones[ Math.round( ti ) ];
    const ang = -Math.PI / 2 + ( rnd() - 0.5 ) * 1.5;
    const len = ( 7 + rnd() * 13 ) * scale;
    const bend = ( rnd() - 0.5 ) * 8 * scale;
    strokes.push( {
      x, y,
      cx: x + Math.cos( ang ) * len * 0.5 + bend,
      cy: y + Math.sin( ang ) * len * 0.5,
      ex: x + Math.cos( ang ) * len + bend * 1.6,
      ey: y + Math.sin( ang ) * len,
      w: ( 1.3 + rnd() * 1.5 ) * scale,
      col: css( col ), up,
    } );
  }

  const flowers = [];
  if ( o.flowers > 0 ) {
    for ( let i = 0; i < Math.round( o.flowers * 220 ); i++ ) {
      flowers.push( { x: rnd() * size, y: rnd() * size, r: ( 1.6 + rnd() * 1.8 ) * scale } );
    }
  }

  const paint = ( ctx, pal ) => {
    wrapDraw( ctx, size, size, ( c ) => {
      c.lineCap = 'round';
      for ( const s of strokes ) {
        c.strokeStyle = pal ? ( s.up ? pal.up : pal.down ) : s.col;
        c.lineWidth = s.w;
        c.globalAlpha = pal ? 0.5 : 0.8;
        c.beginPath();
        c.moveTo( s.x, s.y );
        c.quadraticCurveTo( s.cx, s.cy, s.ex, s.ey );
        c.stroke();
      }
      c.globalAlpha = 1;
      for ( const fl of flowers ) {
        c.beginPath(); c.arc( fl.x, fl.y, fl.r, 0, Math.PI * 2 );
        c.fillStyle = pal ? 'rgb(200,200,200)' : 'rgb(248,246,226)';
        c.fill();
      }
    } );
  };

  paint( A.ctx, null );
  paint( H.ctx, { up: 'rgb(200,200,200)', down: 'rgb(70,70,70)' } );

  const R = newSurface( size, size );
  R.ctx.fillStyle = 'rgb(240,240,240)';
  R.ctx.fillRect( 0, 0, size, size );

  return {
    map: finishTexture( A.canvas, { srgb: true, anisotropy: o.anisotropy, name: 'grass' } ),
    normalMap: makeNormalFromHeight( H.canvas, 0.55 ),
    roughnessMap: finishTexture( R.canvas, { srgb: false, anisotropy: o.anisotropy, name: 'grass-rough' } ),
  };
}
