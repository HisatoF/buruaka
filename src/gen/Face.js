import * as THREE from 'three';

/**
 * Anime face system.
 *
 * The face is not baked into the head texture. Eyes, brows and mouth are
 * drawn into small sprite atlases and mapped onto thin, slightly-curved cards
 * that float just in front of the skull. That is how anime games actually do
 * it, and it buys three things a baked face can't:
 *
 *   1. Blinking and expression are a UV offset, not a texture rebuild.
 *   2. Pupils can track a target by nudging the card's UV, which is what makes
 *      a stylised face feel alive.
 *   3. The eye art gets the full resolution of its own atlas cell instead of
 *      whatever slice of a head map it happened to land on.
 *
 * Everything here is drawn with Canvas2D at load time and cached by palette.
 */

/* ---------------------------------------------------------------------- */
/* Canvas helpers                                                          */
/* ---------------------------------------------------------------------- */

function createCanvas( w, h ) {
  if ( typeof OffscreenCanvas !== 'undefined' ) return new OffscreenCanvas( w, h );
  const c = document.createElement( 'canvas' );
  c.width = w; c.height = h;
  return c;
}

function hex( n ) {
  return '#' + n.toString( 16 ).padStart( 6, '0' );
}

/** Mixes two hex ints in sRGB space — good enough for 2D art, and fast. */
function mixHex( a, b, t ) {
  const ar = ( a >> 16 ) & 255, ag = ( a >> 8 ) & 255, ab = a & 255;
  const br = ( b >> 16 ) & 255, bg = ( b >> 8 ) & 255, bb = b & 255;
  return ( ( ar + ( br - ar ) * t ) << 16 ) | ( ( ag + ( bg - ag ) * t ) << 8 ) | ( ab + ( bb - ab ) * t );
}

function shade( color, amount ) {
  return amount < 0 ? mixHex( color, 0x000000, -amount ) : mixHex( color, 0xffffff, amount );
}

function toTexture( canvas, { srgb = true, aniso = 8 } = {} ) {
  const tex = new THREE.CanvasTexture( canvas );
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ---------------------------------------------------------------------- */
/* Eye atlas                                                               */
/* ---------------------------------------------------------------------- */

export const EYE_FRAMES = [
  'open', 'half', 'closed', 'smile', 'wide', 'angry', 'sad', 'dizzy',
];

const EYE_COLS = 4;
const EYE_ROWS = 2;

/**
 * Draws one open eye into the current transform, occupying roughly
 * x ∈ [0,1], y ∈ [0,1] of a unit cell. Everything is expressed in unit
 * coordinates and scaled by the caller so the same routine serves any
 * atlas resolution.
 *
 * @param {CanvasRenderingContext2D} ctx
 */
/**
 * Samples a cubic bezier chain and fills it as a polygon whose half-width
 * varies along the curve.
 *
 * A constant-`lineWidth` stroke is what makes procedural anime line art look
 * procedural: real ink swells where the brush presses and tapers to nothing at
 * the ends. Building the outline by hand is the only way to get that in
 * Canvas2D, and it is the single biggest quality difference in an eye.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<[number,number]>} ctrl  Flat list of points: P0,C0,C1,P1,C2,C3,P2,…
 * @param {(t:number)=>number} widthAt   Half-width in pixels for t ∈ [0,1]
 * @param {string|CanvasGradient} style
 */
function taperedStroke( ctx, ctrl, widthAt, style, samplesPerSeg = 26 ) {
  const segs = ( ctrl.length - 1 ) / 3;
  const pts = [];

  for ( let s = 0; s < segs; s++ ) {
    const [ p0, c0, c1, p1 ] = [ ctrl[ s * 3 ], ctrl[ s * 3 + 1 ], ctrl[ s * 3 + 2 ], ctrl[ s * 3 + 3 ] ];
    const last = s === segs - 1;
    for ( let i = 0; i <= samplesPerSeg; i++ ) {
      if ( i === 0 && s > 0 ) continue;      // avoid duplicating shared knots
      const t = i / samplesPerSeg;
      const mt = 1 - t;
      const x = mt * mt * mt * p0[ 0 ] + 3 * mt * mt * t * c0[ 0 ] + 3 * mt * t * t * c1[ 0 ] + t * t * t * p1[ 0 ];
      const y = mt * mt * mt * p0[ 1 ] + 3 * mt * mt * t * c0[ 1 ] + 3 * mt * t * t * c1[ 1 ] + t * t * t * p1[ 1 ];
      pts.push( [ x, y ] );
      if ( last && i === samplesPerSeg ) break;
    }
  }

  const n = pts.length;
  const left = [], right = [];
  for ( let i = 0; i < n; i++ ) {
    const prev = pts[ Math.max( i - 1, 0 ) ];
    const next = pts[ Math.min( i + 1, n - 1 ) ];
    let dx = next[ 0 ] - prev[ 0 ], dy = next[ 1 ] - prev[ 1 ];
    const len = Math.hypot( dx, dy ) || 1;
    dx /= len; dy /= len;
    const w = widthAt( i / ( n - 1 ) );
    left.push( [ pts[ i ][ 0 ] - dy * w, pts[ i ][ 1 ] + dx * w ] );
    right.push( [ pts[ i ][ 0 ] + dy * w, pts[ i ][ 1 ] - dx * w ] );
  }

  ctx.beginPath();
  ctx.moveTo( left[ 0 ][ 0 ], left[ 0 ][ 1 ] );
  for ( let i = 1; i < n; i++ ) ctx.lineTo( left[ i ][ 0 ], left[ i ][ 1 ] );
  for ( let i = n - 1; i >= 0; i-- ) ctx.lineTo( right[ i ][ 0 ], right[ i ][ 1 ] );
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill();
}

function drawOpenEye( ctx, S, opts ) {
  const {
    irisColor, irisDeep, lashColor, lashTint, scleraColor,
    tilt, roundness, lashWeight, pupilScale, highlight, sparkle,
    openness = 1,
  } = opts;

  /*
   * Proportions matter more than any rendering trick here. An anime eye is
   * roughly 0.8 wide by 0.65 tall in its own cell, and the iris is
   * deliberately TALLER than the opening so it gets cropped top and bottom —
   * that crop is what reads as "drawn" rather than "an eyeball in a socket".
   * The sclera survives only as two small wedges either side of the iris.
   */
  const IN_X = 0.09 * S;                       // inner corner
  const OUT_X = 0.91 * S;                      // outer corner
  const lift = tilt * 0.07 * S;                // outer-corner rise
  const IN_Y = 0.60 * S;
  const OUT_Y = 0.52 * S - lift;

  const topY = ( 0.20 + ( 1 - roundness ) * 0.06 ) * S;
  const topX = ( 0.36 - tilt * 0.03 ) * S;     // where the upper lid peaks
  const botY = ( 0.84 - ( 1 - roundness ) * 0.07 ) * S;
  const botX = 0.50 * S;

  // A closing amount squashes the opening from the top, which is all the
  // `half` frame needs.
  const squash = ( 1 - openness ) * ( botY - topY ) * 0.62;

  const eyePath = () => {
    ctx.beginPath();
    ctx.moveTo( IN_X, IN_Y );
    // upper lid: steep rise, long gentle fall
    ctx.bezierCurveTo(
      IN_X + 0.06 * S, topY + squash + 0.05 * S,
      topX - 0.10 * S, topY + squash,
      topX, topY + squash
    );
    ctx.bezierCurveTo(
      topX + 0.20 * S, topY + squash - 0.005 * S,
      OUT_X - 0.14 * S, OUT_Y - 0.16 * S,
      OUT_X, OUT_Y
    );
    // lower lid: shallow, sagging toward the middle
    ctx.bezierCurveTo(
      OUT_X - 0.13 * S, OUT_Y + 0.16 * S,
      botX + 0.18 * S, botY,
      botX, botY
    );
    ctx.bezierCurveTo(
      botX - 0.20 * S, botY,
      IN_X + 0.05 * S, IN_Y + 0.10 * S,
      IN_X, IN_Y
    );
    ctx.closePath();
  };

  ctx.save();
  eyePath();
  ctx.clip();

  // --- sclera -----------------------------------------------------------
  ctx.fillStyle = hex( scleraColor );
  ctx.fillRect( 0, 0, S, S );

  // Occlusion under the upper lid. Without it the white wedges read as
  // paper cut-outs sitting on top of the iris.
  const aoGrad = ctx.createLinearGradient( 0, topY + squash, 0, topY + squash + ( botY - topY ) * 0.42 );
  aoGrad.addColorStop( 0, 'rgba(120,110,152,0.72)' );
  aoGrad.addColorStop( 0.5, 'rgba(172,166,200,0.20)' );
  aoGrad.addColorStop( 1, 'rgba(255,255,255,0)' );
  ctx.fillStyle = aoGrad;
  ctx.fillRect( 0, 0, S, S );

  // --- iris -------------------------------------------------------------
  const irisCX = 0.490 * S;
  const irisCY = 0.535 * S;
  const irisRX = 0.288 * S;
  const irisRY = 0.345 * S;

  // One vertical gradient does most of the work: saturated and dark where the
  // lid shadows it, opening to a bright rim at the bottom.
  const irisGrad = ctx.createLinearGradient( 0, irisCY - irisRY, 0, irisCY + irisRY );
  irisGrad.addColorStop( 0.00, hex( shade( irisDeep, -0.40 ) ) );
  irisGrad.addColorStop( 0.26, hex( irisDeep ) );
  irisGrad.addColorStop( 0.58, hex( irisColor ) );
  irisGrad.addColorStop( 0.84, hex( shade( irisColor, 0.40 ) ) );
  irisGrad.addColorStop( 1.00, hex( shade( irisColor, 0.66 ) ) );

  ctx.beginPath();
  ctx.ellipse( irisCX, irisCY, irisRX, irisRY, 0, 0, Math.PI * 2 );
  ctx.fillStyle = irisGrad;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.ellipse( irisCX, irisCY, irisRX, irisRY, 0, 0, Math.PI * 2 );
  ctx.clip();

  // Radial striations. Low contrast on purpose — at gameplay distance they
  // only need to keep the fill from looking like flat vector art.
  ctx.globalAlpha = 0.14;
  ctx.strokeStyle = hex( shade( irisDeep, -0.5 ) );
  ctx.lineWidth = Math.max( 1, S * 0.007 );
  for ( let i = 0; i < 30; i++ ) {
    const a = ( i / 30 ) * Math.PI * 2 + 0.2;
    const r0 = 0.34 + ( i % 3 ) * 0.07;
    ctx.beginPath();
    ctx.moveTo( irisCX + Math.cos( a ) * irisRX * r0, irisCY + Math.sin( a ) * irisRY * r0 );
    ctx.lineTo( irisCX + Math.cos( a ) * irisRX, irisCY + Math.sin( a ) * irisRY );
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // The bright caustic crescent low in the iris — light that has passed
  // through the lens and bounced off the far wall. Stylised, but every anime
  // eye has it and its absence is immediately noticeable.
  ctx.globalAlpha = 0.62;
  ctx.beginPath();
  ctx.ellipse( irisCX, irisCY + irisRY * 0.34, irisRX * 0.74, irisRY * 0.56, 0, 0, Math.PI * 2 );
  ctx.lineWidth = S * 0.030;
  ctx.strokeStyle = hex( shade( irisColor, 0.78 ) );
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Heavy limbal ring, biased to the top where the lid shadow falls.
  ctx.beginPath();
  ctx.ellipse( irisCX, irisCY, irisRX, irisRY, 0, 0, Math.PI * 2 );
  ctx.lineWidth = S * 0.034;
  ctx.strokeStyle = hex( shade( irisDeep, -0.62 ) );
  ctx.stroke();
  ctx.restore();

  // --- pupil ------------------------------------------------------------
  ctx.beginPath();
  ctx.ellipse( irisCX, irisCY + irisRY * 0.02, irisRX * 0.30 * pupilScale, irisRY * 0.33 * pupilScale, 0, 0, Math.PI * 2 );
  ctx.fillStyle = hex( shade( irisDeep, -0.78 ) );
  ctx.fill();

  // --- highlights -------------------------------------------------------
  if ( highlight ) {
    // Primary catchlight, upper-left, straddling the pupil edge.
    ctx.beginPath();
    ctx.ellipse( irisCX - irisRX * 0.44, irisCY - irisRY * 0.40, irisRX * 0.25, irisRY * 0.20, -0.35, 0, Math.PI * 2 );
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Secondary, lower-right, softer — this pair is what sells the sphere.
    ctx.globalAlpha = 0.62;
    ctx.beginPath();
    ctx.ellipse( irisCX + irisRX * 0.46, irisCY + irisRY * 0.42, irisRX * 0.13, irisRY * 0.095, 0.3, 0, Math.PI * 2 );
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if ( sparkle ) {
    // A small four-point star glint. It is the difference between a rendered
    // eye and an illustrated one.
    const sx = irisCX + irisRX * 0.28, sy = irisCY - irisRY * 0.56, sr = irisRX * 0.20;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for ( let i = 0; i < 8; i++ ) {
      const a = ( i / 8 ) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? sr : sr * 0.26;
      const px = sx + Math.cos( a ) * r, py = sy + Math.sin( a ) * r * 1.3;
      i === 0 ? ctx.moveTo( px, py ) : ctx.lineTo( px, py );
    }
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore(); // release the eye-opening clip

  // --- lash line --------------------------------------------------------
  // Ink laid over the whole shape. The upper lid is one continuous tapered
  // stroke that starts as a hairline at the inner corner, swells over the
  // peak, and runs out into the corner flick — drawn as a single path so the
  // corner never piles up into a blob the way three overlapping round-capped
  // strokes do.
  const lashGrad = ctx.createLinearGradient( IN_X, 0, OUT_X + 0.1 * S, 0 );
  lashGrad.addColorStop( 0, hex( lashTint ) );
  lashGrad.addColorStop( 0.32, hex( lashColor ) );
  lashGrad.addColorStop( 1, hex( lashColor ) );

  const W = S * lashWeight;
  taperedStroke(
    ctx,
    [
      [ IN_X, IN_Y ],
      [ IN_X + 0.06 * S, topY + squash + 0.05 * S ],
      [ topX - 0.10 * S, topY + squash ],
      [ topX, topY + squash ],

      [ topX + 0.22 * S, topY + squash + 0.004 * S ],
      [ OUT_X - 0.20 * S, OUT_Y - 0.055 * S ],
      [ OUT_X, OUT_Y ],

      [ OUT_X + 0.040 * S, OUT_Y - 0.030 * S ],
      [ OUT_X + 0.066 * S, OUT_Y - 0.072 * S ],
      [ OUT_X + 0.088 * S, OUT_Y - 0.130 * S ],
    ],
    // The path is three cubics, so t = 1/3 is the lid peak and t = 2/3 is the
    // outer corner. Full weight across the lid, then a long run-out through
    // the flick to a needle point.
    ( t ) => {
      if ( t < 0.10 ) return W * ( 0.14 + ( t / 0.10 ) * 0.76 );
      if ( t < 0.50 ) return W * ( 0.90 + Math.sin( ( t - 0.10 ) / 0.40 * Math.PI ) * 0.10 );
      if ( t < 0.667 ) return W * ( 0.90 - ( ( t - 0.50 ) / 0.167 ) * 0.42 );
      return W * 0.48 * Math.pow( 1 - ( t - 0.667 ) / 0.333, 1.25 );
    },
    lashGrad
  );

  // Lower lash: a hairline that fades in past the middle and meets the outer
  // corner. It must stay light — a symmetric lower lid makes the eye read as
  // a cartoon frog rather than an anime character.
  ctx.save();
  ctx.globalAlpha = 0.6;
  taperedStroke(
    ctx,
    [
      [ botX - 0.18 * S, botY - 0.010 * S ],
      [ botX + 0.10 * S, botY - 0.006 * S ],
      [ OUT_X - 0.14 * S, OUT_Y + 0.15 * S ],
      [ OUT_X - 0.020 * S, OUT_Y + 0.020 * S ],
    ],
    ( t ) => W * 0.34 * Math.min( 1, t * 3.2 ),
    hex( lashColor )
  );
  ctx.restore();

  // Crease. Barely there — the brow does most of this job, and a strong
  // crease instantly ages the face out of the target style.
  ctx.save();
  ctx.globalAlpha = 0.20;
  taperedStroke(
    ctx,
    [
      [ topX - 0.04 * S, topY + squash - 0.070 * S ],
      [ topX + 0.14 * S, topY + squash - 0.098 * S ],
      [ OUT_X - 0.18 * S, OUT_Y - 0.135 * S ],
      [ OUT_X - 0.045 * S, OUT_Y - 0.105 * S ],
    ],
    ( t ) => W * 0.20 * Math.sin( t * Math.PI ),
    hex( lashColor )
  );
  ctx.restore();
}

/** A closed / blinking eye: one bowed, tapered ink stroke with a corner flick. */
function drawClosedEye( ctx, S, opts, { bow = 1, happy = false } = {} ) {
  const { lashColor, lashTint, lashWeight, tilt } = opts;
  const IN_X = 0.09 * S, OUT_X = 0.91 * S;
  const IN_Y = 0.56 * S;
  const OUT_Y = 0.50 * S - tilt * 0.07 * S;

  const grad = ctx.createLinearGradient( IN_X, 0, OUT_X + 0.1 * S, 0 );
  grad.addColorStop( 0, hex( lashTint ) );
  grad.addColorStop( 0.30, hex( lashColor ) );
  grad.addColorStop( 1, hex( lashColor ) );

  // `happy` inverts the bow into the classic "^ ^" smiling-eyes shape.
  const depth = happy ? -0.30 * bow : 0.20 * bow;
  const midY = IN_Y + depth * S;
  const W = S * lashWeight;

  taperedStroke(
    ctx,
    [
      [ IN_X, IN_Y ],
      [ IN_X + 0.16 * S, midY ],
      [ OUT_X - 0.22 * S, midY ],
      [ OUT_X, OUT_Y ],

      [ OUT_X + 0.045 * S, OUT_Y - 0.035 * S ],
      [ OUT_X + 0.068 * S, OUT_Y - 0.078 * S ],
      [ OUT_X + 0.082 * S, OUT_Y - 0.125 * S ],
    ],
    ( t ) => {
      if ( t < 0.10 ) return W * ( 0.20 + ( t / 0.10 ) * 0.85 );
      if ( t < 0.68 ) return W * 1.05;
      if ( t < 0.80 ) return W * ( 1.05 - ( ( t - 0.68 ) / 0.12 ) * 0.35 );
      return W * 0.70 * Math.pow( 1 - ( t - 0.80 ) / 0.20, 0.85 );
    },
    grad
  );

  // Three short lashes hanging off the lid. Cheap, and without them the
  // closed frame reads as a bare pen stroke rather than an eye.
  if ( !happy ) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    for ( let i = 0; i < 3; i++ ) {
      const t = 0.40 + i * 0.18;
      const mt = 1 - t;
      const x = mt * mt * IN_X + 2 * mt * t * ( IN_X + 0.42 * S ) + t * t * OUT_X;
      const y = mt * mt * IN_Y + 2 * mt * t * midY + t * t * OUT_Y;
      taperedStroke(
        ctx,
        [ [ x, y ], [ x + 0.006 * S, y - 0.028 * S ], [ x + 0.014 * S, y - 0.055 * S ], [ x + 0.024 * S, y - 0.085 * S ] ],
        ( u ) => W * 0.34 * ( 1 - u ),
        hex( lashColor ),
        10
      );
    }
    ctx.restore();
  }
}

export const EYE_PRESETS = {
  sharp:   { tilt: 0.55, roundness: 0.86, lashWeight: 0.072, pupilScale: 0.92 },
  round:   { tilt: 0.18, roundness: 1.00, lashWeight: 0.066, pupilScale: 1.06 },
  droopy:  { tilt: -0.35, roundness: 0.98, lashWeight: 0.062, pupilScale: 1.02 },
  cool:    { tilt: 0.42, roundness: 0.80, lashWeight: 0.076, pupilScale: 0.86 },
};

/**
 * Builds the 4x2 eye atlas for one character.
 * @returns {{ texture: THREE.Texture, frames: Record<string, {x:number,y:number,w:number,h:number}>, cols:number, rows:number }}
 */
export function makeEyeAtlas( {
  cell = 320,
  irisColor = 0x4fb3e8,
  lashColor = 0x2a2038,
  lashTint = null,
  scleraColor = 0xfdfcff,
  shape = 'round',
  sparkle = true,
} = {} ) {
  const preset = EYE_PRESETS[ shape ] ?? EYE_PRESETS.round;
  const opts = {
    irisColor,
    irisDeep: shade( irisColor, -0.45 ),
    lashColor,
    lashTint: lashTint ?? mixHex( lashColor, irisColor, 0.35 ),
    scleraColor,
    highlight: true,
    sparkle,
    ...preset,
  };

  const canvas = createCanvas( cell * EYE_COLS, cell * EYE_ROWS );
  const ctx = canvas.getContext( '2d' );
  ctx.clearRect( 0, 0, canvas.width, canvas.height );

  const frames = {};
  EYE_FRAMES.forEach( ( name, i ) => {
    const cx = ( i % EYE_COLS ) * cell;
    const cy = Math.floor( i / EYE_COLS ) * cell;
    frames[ name ] = { x: cx / canvas.width, y: 1 - ( cy + cell ) / canvas.height, w: 1 / EYE_COLS, h: 1 / EYE_ROWS };

    ctx.save();
    ctx.translate( cx, cy );

    switch ( name ) {
      case 'open':
        drawOpenEye( ctx, cell, opts );
        break;
      case 'half':
        // Half-lidded is the same path with the opening squashed from above,
        // so the lash always stays welded to the lid instead of floating.
        drawOpenEye( ctx, cell, { ...opts, openness: 0.42 } );
        break;
      case 'closed':
        drawClosedEye( ctx, cell, opts, { bow: 1 } );
        break;
      case 'smile':
        drawClosedEye( ctx, cell, opts, { bow: 1.1, happy: true } );
        break;
      case 'wide':
        drawOpenEye( ctx, cell, { ...opts, pupilScale: opts.pupilScale * 0.70, roundness: 1.15, tilt: opts.tilt * 0.4 } );
        break;
      case 'angry':
        drawOpenEye( ctx, cell, { ...opts, tilt: opts.tilt + 0.55, roundness: opts.roundness * 0.82, pupilScale: opts.pupilScale * 0.8, openness: 0.86 } );
        break;
      case 'sad':
        drawOpenEye( ctx, cell, { ...opts, tilt: opts.tilt - 0.75, roundness: opts.roundness * 1.06, pupilScale: opts.pupilScale * 1.08 } );
        break;
      case 'dizzy':
        drawSpiralEye( ctx, cell, opts );
        break;
    }
    ctx.restore();
  } );

  return { texture: toTexture( canvas ), frames, cols: EYE_COLS, rows: EYE_ROWS };
}

/** The "@_@" knocked-out eye. Used on the downed state. */
function drawSpiralEye( ctx, S, opts ) {
  ctx.strokeStyle = hex( opts.lashColor );
  ctx.lineCap = 'round';
  ctx.lineWidth = S * 0.045;
  ctx.beginPath();
  const cx = 0.52 * S, cy = 0.52 * S;
  for ( let i = 0; i <= 140; i++ ) {
    const t = i / 140;
    const a = t * Math.PI * 5.2;
    const r = t * S * 0.28;
    const x = cx + Math.cos( a ) * r, y = cy + Math.sin( a ) * r;
    i === 0 ? ctx.moveTo( x, y ) : ctx.lineTo( x, y );
  }
  ctx.stroke();
}

/* ---------------------------------------------------------------------- */
/* Brow atlas                                                              */
/* ---------------------------------------------------------------------- */

export const BROW_FRAMES = [ 'neutral', 'angry', 'sad', 'surprised' ];

export function makeBrowAtlas( { cell = 256, color = 0x6b4a3a } = {} ) {
  const canvas = createCanvas( cell * 4, cell );
  const ctx = canvas.getContext( '2d' );
  ctx.clearRect( 0, 0, canvas.width, canvas.height );

  const frames = {};
  BROW_FRAMES.forEach( ( name, i ) => {
    const cx = i * cell;
    frames[ name ] = { x: cx / canvas.width, y: 0, w: 1 / 4, h: 1 };

    ctx.save();
    ctx.translate( cx, 0 );

    // Each brow is a tapered stroke: thick at the inner end, thin at the tail.
    // Building it as a filled path rather than a stroked line is what gives
    // the taper; a lineWidth stroke would read as a uniform sausage.
    const tilts = { neutral: 0.06, angry: 0.34, sad: -0.30, surprised: -0.06 };
    const arcs = { neutral: 0.10, angry: 0.02, sad: 0.06, surprised: 0.24 };
    const tilt = tilts[ name ], arc = arcs[ name ];

    const x0 = 0.14 * cell, x1 = 0.88 * cell;
    const y0 = 0.56 * cell + tilt * cell * 0.5;
    const y1 = 0.50 * cell - tilt * cell * 0.5;
    const t0 = 0.13 * cell, t1 = 0.035 * cell;

    ctx.fillStyle = hex( color );
    ctx.beginPath();
    ctx.moveTo( x0, y0 - t0 * 0.5 );
    ctx.bezierCurveTo(
      x0 + ( x1 - x0 ) * 0.35, y0 - arc * cell - t0 * 0.4,
      x0 + ( x1 - x0 ) * 0.72, y1 - arc * cell * 0.4 - t1,
      x1, y1 - t1 * 0.5
    );
    ctx.lineTo( x1, y1 + t1 * 0.5 );
    ctx.bezierCurveTo(
      x0 + ( x1 - x0 ) * 0.72, y1 - arc * cell * 0.4 + t1 * 1.4,
      x0 + ( x1 - x0 ) * 0.35, y0 - arc * cell + t0 * 0.6,
      x0, y0 + t0 * 0.5
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } );

  return { texture: toTexture( canvas ), frames, cols: 4, rows: 1 };
}

/* ---------------------------------------------------------------------- */
/* Mouth atlas                                                             */
/* ---------------------------------------------------------------------- */

export const MOUTH_FRAMES = [ 'smile', 'neutral', 'open', 'wide', 'small', 'grimace', 'cat', 'oh' ];

export function makeMouthAtlas( { cell = 192, ink = 0x8a4a52, inner = 0x7a2f3c, tongue = 0xe07a86 } = {} ) {
  const canvas = createCanvas( cell * 4, cell * 2 );
  const ctx = canvas.getContext( '2d' );
  ctx.clearRect( 0, 0, canvas.width, canvas.height );

  const frames = {};
  MOUTH_FRAMES.forEach( ( name, i ) => {
    const cx = ( i % 4 ) * cell;
    const cy = Math.floor( i / 4 ) * cell;
    frames[ name ] = { x: cx / canvas.width, y: 1 - ( cy + cell ) / canvas.height, w: 1 / 4, h: 1 / 2 };

    ctx.save();
    ctx.translate( cx, cy );
    ctx.lineCap = 'round';
    ctx.strokeStyle = hex( ink );

    const openMouth = ( w, h, curve ) => {
      ctx.beginPath();
      ctx.moveTo( ( 0.5 - w / 2 ) * cell, 0.42 * cell );
      ctx.quadraticCurveTo( 0.5 * cell, ( 0.42 - curve ) * cell, ( 0.5 + w / 2 ) * cell, 0.42 * cell );
      ctx.quadraticCurveTo( 0.5 * cell, ( 0.42 + h ) * cell, ( 0.5 - w / 2 ) * cell, 0.42 * cell );
      ctx.closePath();
      ctx.fillStyle = hex( inner );
      ctx.fill();
      // Tongue catches a little light at the bottom of the cavity.
      ctx.save();
      ctx.clip();
      ctx.fillStyle = hex( tongue );
      ctx.beginPath();
      ctx.ellipse( 0.5 * cell, ( 0.42 + h ) * cell, w * 0.42 * cell, h * 0.45 * cell, 0, 0, Math.PI * 2 );
      ctx.fill();
      ctx.restore();
    };

    switch ( name ) {
      case 'smile':
        ctx.lineWidth = cell * 0.045;
        ctx.beginPath();
        ctx.moveTo( 0.30 * cell, 0.44 * cell );
        ctx.quadraticCurveTo( 0.50 * cell, 0.60 * cell, 0.70 * cell, 0.44 * cell );
        ctx.stroke();
        break;
      case 'neutral':
        ctx.lineWidth = cell * 0.040;
        ctx.beginPath();
        ctx.moveTo( 0.36 * cell, 0.48 * cell );
        ctx.quadraticCurveTo( 0.50 * cell, 0.52 * cell, 0.64 * cell, 0.48 * cell );
        ctx.stroke();
        break;
      case 'open':  openMouth( 0.30, 0.22, 0.02 ); break;
      case 'wide':  openMouth( 0.42, 0.30, 0.06 ); break;
      case 'small':
        ctx.lineWidth = cell * 0.038;
        ctx.beginPath();
        ctx.moveTo( 0.42 * cell, 0.47 * cell );
        ctx.quadraticCurveTo( 0.50 * cell, 0.54 * cell, 0.58 * cell, 0.47 * cell );
        ctx.stroke();
        break;
      case 'grimace':
        ctx.lineWidth = cell * 0.044;
        ctx.beginPath();
        ctx.moveTo( 0.30 * cell, 0.54 * cell );
        ctx.quadraticCurveTo( 0.50 * cell, 0.40 * cell, 0.70 * cell, 0.54 * cell );
        ctx.stroke();
        break;
      case 'cat':
        // The "w"-shaped cat mouth. Pure anime shorthand, and it reads
        // instantly at gameplay distance.
        ctx.lineWidth = cell * 0.042;
        ctx.beginPath();
        ctx.moveTo( 0.30 * cell, 0.44 * cell );
        ctx.quadraticCurveTo( 0.40 * cell, 0.58 * cell, 0.50 * cell, 0.46 * cell );
        ctx.quadraticCurveTo( 0.60 * cell, 0.58 * cell, 0.70 * cell, 0.44 * cell );
        ctx.stroke();
        break;
      case 'oh':
        ctx.beginPath();
        ctx.ellipse( 0.5 * cell, 0.48 * cell, cell * 0.075, cell * 0.10, 0, 0, Math.PI * 2 );
        ctx.fillStyle = hex( inner );
        ctx.fill();
        break;
    }
    ctx.restore();
  } );

  return { texture: toTexture( canvas ), frames, cols: 4, rows: 2 };
}

/* ---------------------------------------------------------------------- */
/* Head skin texture                                                       */
/* ---------------------------------------------------------------------- */

/**
 * The head's own map: flat skin plus the soft features that never animate —
 * blush, nose shadow, ear shading. Authored in the head's front-planar UV
 * space, so the centre of the texture is the centre of the face and the
 * outer margin wraps around the skull.
 */
export function makeHeadSkin( {
  size = 512,
  skin = 0xffe3d0,
  blush = 0xff9aa2,
  noseShadow = 0xe6a892,
  freckles = false,
  seed = 1,
} = {} ) {
  const canvas = createCanvas( size, size );
  const ctx = canvas.getContext( '2d' );

  ctx.fillStyle = hex( skin );
  ctx.fillRect( 0, 0, size, size );

  // Subtle warmth toward the cheeks and jaw so the head isn't a flat fill
  // once the toon ramp flattens it.
  const warm = ctx.createRadialGradient( size * 0.5, size * 0.66, size * 0.08, size * 0.5, size * 0.64, size * 0.44 );
  warm.addColorStop( 0, 'rgba(255,190,170,0.20)' );
  warm.addColorStop( 1, 'rgba(255,190,170,0)' );
  ctx.fillStyle = warm;
  ctx.fillRect( 0, 0, size, size );

  // Blush: two soft ovals, plus the three diagonal ticks that read as
  // "anime blush" rather than "rosacea".
  for ( const sx of [ -1, 1 ] ) {
    const cx = size * ( 0.5 + sx * 0.185 );
    const cy = size * 0.612;
    const g = ctx.createRadialGradient( cx, cy, 0, cx, cy, size * 0.105 );
    g.addColorStop( 0, hex( blush ) + 'b0' );
    g.addColorStop( 0.55, hex( blush ) + '55' );
    g.addColorStop( 1, hex( blush ) + '00' );
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse( cx, cy, size * 0.105, size * 0.070, 0, 0, Math.PI * 2 );
    ctx.fill();

    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = hex( shade( blush, -0.12 ) );
    ctx.lineWidth = size * 0.0085;
    ctx.lineCap = 'round';
    for ( let i = -1; i <= 1; i++ ) {
      const ox = cx + i * size * 0.030;
      ctx.beginPath();
      ctx.moveTo( ox - size * 0.016, cy + size * 0.018 );
      ctx.lineTo( ox + size * 0.016, cy - size * 0.018 );
      ctx.stroke();
    }
    ctx.restore();
  }

  // Nose: a single short shadow tick. Anything more and the face stops
  // reading as anime.
  ctx.save();
  ctx.globalAlpha = 0.40;
  ctx.strokeStyle = hex( noseShadow );
  ctx.lineWidth = size * 0.010;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo( size * 0.506, size * 0.700 );
  ctx.lineTo( size * 0.492, size * 0.734 );
  ctx.stroke();
  ctx.restore();

  if ( freckles ) {
    let s = seed >>> 0;
    const rnd = () => ( ( s = ( s * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
    ctx.fillStyle = hex( shade( blush, -0.30 ) );
    ctx.globalAlpha = 0.30;
    for ( let i = 0; i < 26; i++ ) {
      const side = rnd() < 0.5 ? -1 : 1;
      const x = size * ( 0.5 + side * ( 0.12 + rnd() * 0.10 ) );
      const y = size * ( 0.590 + ( rnd() - 0.5 ) * 0.055 );
      ctx.beginPath();
      ctx.arc( x, y, size * ( 0.004 + rnd() * 0.003 ), 0, Math.PI * 2 );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  return toTexture( canvas );
}


/* ---------------------------------------------------------------------- */
/* Combined face atlas                                                     */
/* ---------------------------------------------------------------------- */

/**
 * Composites the eye, brow and mouth atlases into a single texture.
 *
 * All six face cards (two eyes, two brows, one mouth, plus a spare slot) then
 * share one material, so a character's entire face is one draw call and
 * changing expression is a UV-offset write rather than a texture swap.
 *
 * Layout on a 1024² sheet:
 *   rows    0– 512  eyes,   4 x 2 cells of 256
 *   rows  512– 640  brows,  4 x 1 cells of 256 x 128
 *   rows  640– 768  mouths, 8 x 1 cells of 128
 *   rows  768–1024  spare (a flat white patch at the far corner)
 *
 * @returns {{ texture: THREE.Texture, frames: Record<string, {x:number,y:number,w:number,h:number}> }}
 *          Frame keys are prefixed: `eye.open`, `brow.angry`, `mouth.cat`.
 */
export function makeFaceAtlas( {
  size = 1024,
  irisColor = 0x4fb3e8,
  lashColor = 0x2a2038,
  scleraColor = 0xfdfcff,
  shape = 'round',
  sparkle = true,
  browColor = 0x6b4a3a,
  mouthInk = 0x8a4a52,
  mouthInner = 0x7a2f3c,
} = {} ) {
  const canvas = createCanvas( size, size );
  const ctx = canvas.getContext( '2d' );
  ctx.clearRect( 0, 0, size, size );

  const frames = {};
  const S = size / 1024; // everything below is authored against a 1024 sheet

  // Sources are rendered oversized and downsampled into the sheet: the ink
  // strokes are thin, and drawing them at final resolution aliases badly.
  const eyes = makeEyeAtlas( { cell: 384, irisColor, lashColor, scleraColor, shape, sparkle } );
  const brows = makeBrowAtlas( { cell: 384, color: browColor } );
  const mouths = makeMouthAtlas( { cell: 256, ink: mouthInk, inner: mouthInner } );

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const eyeCell = 256 * S;
  EYE_FRAMES.forEach( ( name, i ) => {
    const col = i % EYE_COLS, row = Math.floor( i / EYE_COLS );
    const dx = col * eyeCell, dy = row * eyeCell;
    ctx.drawImage( eyes.texture.image, col * 384, row * 384, 384, 384, dx, dy, eyeCell, eyeCell );
    frames[ `eye.${name}` ] = { x: dx / size, y: 1 - ( dy + eyeCell ) / size, w: eyeCell / size, h: eyeCell / size };
  } );

  const browW = 256 * S, browH = 128 * S, browY = 512 * S;
  BROW_FRAMES.forEach( ( name, i ) => {
    const dx = i * browW;
    // The source brow cell is square with the stroke in the middle band, so
    // only that band is copied across.
    ctx.drawImage( brows.texture.image, i * 384, 384 * 0.25, 384, 384 * 0.5, dx, browY, browW, browH );
    frames[ `brow.${name}` ] = { x: dx / size, y: 1 - ( browY + browH ) / size, w: browW / size, h: browH / size };
  } );

  const mouthCell = 128 * S, mouthY = 640 * S;
  MOUTH_FRAMES.forEach( ( name, i ) => {
    const sx = ( i % 4 ) * 256, sy = Math.floor( i / 4 ) * 256;
    const dx = i * mouthCell;
    ctx.drawImage( mouths.texture.image, sx, sy, 256, 256, dx, mouthY, mouthCell, mouthCell );
    frames[ `mouth.${name}` ] = { x: dx / size, y: 1 - ( mouthY + mouthCell ) / size, w: mouthCell / size, h: mouthCell / size };
  } );

  // Dispose the oversized intermediates; only the sheet survives.
  eyes.texture.dispose();
  brows.texture.dispose();
  mouths.texture.dispose();

  const tex = toTexture( canvas );
  // Mipmaps would bleed neighbouring atlas cells into each other at distance,
  // and the face is small on screen exactly when that would show.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return { texture: tex, frames };
}

export { createCanvas, toTexture, hex, mixHex, shade };
