/**
 * BURUAKA — procedural audio.
 *
 * Every sound in the game is synthesised at runtime with the Web Audio API;
 * there is not a single sample file in the repository. The module is split in
 * three:
 *
 *   dsp helpers   — noise buffers, envelopes, sweeps, waveshapers, impulse
 *                   response generation. Pure functions over an AudioContext.
 *   SYNTH         — one function per sound name. Each builds a small graph of
 *                   layers (transient / body / tail) into a per-voice output.
 *   AudioEngine   — bus graph, reverb, 3D panning, voice limiting, ducking,
 *                   plus MusicDirector, the generative score.
 *
 * The constructor accepts an injected context so an OfflineAudioContext can
 * render the whole engine deterministically in tests.
 *
 *   const audio = new AudioEngine();
 *   audio.unlock();                       // from a user gesture
 *   audio.play( 'uiClick' );
 *   audio.playAt( 'rifleShot', muzzleWorldPos, { volume: 0.9 } );
 *   audio.setListener( camera );          // once per frame
 *   audio.music.start( 'combat' );
 *   audio.music.setIntensity( 0.8 );
 */

// ---------------------------------------------------------------------------
// small math / rng
// ---------------------------------------------------------------------------

const clamp = ( v, a, b ) => ( v < a ? a : v > b ? b : v );
const lerp = ( a, b, t ) => a + ( b - a ) * t;

/** Deterministic 32-bit PRNG — lets the render tests reproduce a variation. */
export function mulberry32( seed ) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = ( a + 0x6d2b79f5 ) | 0;
    let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
    t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
    return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
  };
}

/** MIDI note -> Hz. 69 = A4 = 440. */
const mtof = ( m ) => 440 * Math.pow( 2, ( m - 69 ) / 12 );

// Exponential ramps cannot touch zero; this is the practical floor (-80 dB).
const EPS = 1e-4;

// ---------------------------------------------------------------------------
// noise
// ---------------------------------------------------------------------------

const _noiseCache = new WeakMap();
const NOISE_SECONDS = 3;

/**
 * White and pink noise beds, generated once per context and shared by every
 * voice. Sources read from a random offset so two triggers never line up.
 * The mean is removed so the buffers carry no DC.
 */
function noiseBeds( ctx ) {
  let beds = _noiseCache.get( ctx );
  if ( beds ) return beds;

  const rate = ctx.sampleRate;
  const len = Math.floor( rate * NOISE_SECONDS );
  const rng = mulberry32( 0xb00b1e5 );

  const white = ctx.createBuffer( 1, len, rate );
  const pink = ctx.createBuffer( 1, len, rate );
  const w = white.getChannelData( 0 );
  const p = pink.getChannelData( 0 );

  // Paul Kellet's pink filter — cheap and flat enough for sound design.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let sumW = 0, sumP = 0;

  for ( let i = 0; i < len; i++ ) {
    const n = rng() * 2 - 1;
    w[ i ] = n;
    sumW += n;

    b0 = 0.99886 * b0 + n * 0.0555179;
    b1 = 0.99332 * b1 + n * 0.0750759;
    b2 = 0.96900 * b2 + n * 0.1538520;
    b3 = 0.86650 * b3 + n * 0.3104856;
    b4 = 0.55000 * b4 + n * 0.5329522;
    b5 = -0.7616 * b5 - n * 0.0168980;
    const pv = ( b0 + b1 + b2 + b3 + b4 + b5 + b6 + n * 0.5362 ) * 0.16;
    b6 = n * 0.115926;
    p[ i ] = pv;
    sumP += pv;
  }

  const mw = sumW / len, mp = sumP / len;
  let peakP = 0;
  for ( let i = 0; i < len; i++ ) {
    w[ i ] -= mw;
    p[ i ] -= mp;
    const a = Math.abs( p[ i ] );
    if ( a > peakP ) peakP = a;
  }
  if ( peakP > 0 ) for ( let i = 0; i < len; i++ ) p[ i ] /= peakP;

  beds = { white, pink };
  _noiseCache.set( ctx, beds );
  return beds;
}

// ---------------------------------------------------------------------------
// waveshaper curves (grit / saturation)
// ---------------------------------------------------------------------------

const _curveCache = new Map();

/** Symmetric tanh soft clipper — symmetric, so it introduces no DC. */
function shaperCurve( drive ) {
  const key = 'tanh' + drive.toFixed( 2 );
  let c = _curveCache.get( key );
  if ( c ) return c;
  const n = 2048;
  c = new Float32Array( n );
  const k = Math.max( 0.001, drive );
  const norm = Math.tanh( k );
  for ( let i = 0; i < n; i++ ) {
    const x = ( i / ( n - 1 ) ) * 2 - 1;
    c[ i ] = Math.tanh( k * x ) / norm;
  }
  _curveCache.set( key, c );
  return c;
}

/** Foldback-ish curve for aggressive metallic grit. Also symmetric. */
function foldCurve( amount ) {
  const key = 'fold' + amount.toFixed( 2 );
  let c = _curveCache.get( key );
  if ( c ) return c;
  const n = 2048;
  c = new Float32Array( n );
  for ( let i = 0; i < n; i++ ) {
    const x = ( ( i / ( n - 1 ) ) * 2 - 1 ) * amount;
    c[ i ] = Math.sin( x ) * ( 1 / Math.max( 1, amount * 0.6 ) ) + Math.tanh( x ) * 0.5;
  }
  _curveCache.set( key, c );
  return c;
}

// ---------------------------------------------------------------------------
// impulse response
// ---------------------------------------------------------------------------

/**
 * Procedural convolution reverb tail: exponentially decaying noise with
 * progressive high-frequency damping (air absorption) and a handful of
 * discrete early reflections stamped into the head of the buffer.
 */
export function createImpulseResponse( ctx, opts = {} ) {
  const duration = opts.duration ?? 2.2;
  const decay = opts.decay ?? 2.6;
  const preDelay = opts.preDelay ?? 0.011;
  const damp = opts.damp ?? 0.72;
  const rate = ctx.sampleRate;
  const len = Math.max( 8, Math.floor( rate * duration ) );
  const buf = ctx.createBuffer( 2, len, rate );
  const pd = Math.floor( preDelay * rate );

  for ( let ch = 0; ch < 2; ch++ ) {
    const d = buf.getChannelData( ch );
    const rng = mulberry32( 0x51f7 + ch * 7919 );
    let lp = 0, dc = 0;

    for ( let i = pd; i < len; i++ ) {
      const t = ( i - pd ) / ( len - pd );
      // Two stacked decays: a fast one for the dense onset, a slow tail.
      const env = Math.pow( 1 - t, decay ) * ( 0.72 * Math.exp( -t * 5.5 ) + 0.28 );
      const n = rng() * 2 - 1;
      // Progressive one-pole lowpass: the tail gets darker as it decays.
      const cut = clamp( 0.62 * ( 1 - t * damp ), 0.03, 0.95 );
      lp += cut * ( n - lp );
      let s = lp;
      dc += 0.0012 * ( s - dc );            // DC blocker
      d[ i ] = ( s - dc ) * env;
    }

    // Early reflections: a sparse, slightly asymmetric tap pattern per ear.
    const taps = [ 0.0091, 0.0143, 0.0197, 0.0264, 0.0331, 0.0428, 0.0551, 0.0693 ];
    for ( let k = 0; k < taps.length; k++ ) {
      const jitter = 1 + ( rng() - 0.5 ) * 0.22;
      const idx = Math.floor( taps[ k ] * jitter * rate );
      if ( idx >= len ) continue;
      const g = ( 0.55 / ( 1 + k * 0.75 ) ) * ( rng() > 0.5 ? 1 : -1 );
      // Smear each tap over a few samples so it reads as a reflection, not a tick.
      for ( let s = 0; s < 6; s++ ) {
        if ( idx + s < len ) d[ idx + s ] += g * Math.exp( -s * 0.7 ) * ( rng() * 2 - 1 );
      }
    }
  }

  // Normalise so swapping IR settings never changes the send level.
  let peak = 0;
  for ( let ch = 0; ch < 2; ch++ ) {
    const d = buf.getChannelData( ch );
    for ( let i = 0; i < len; i++ ) peak = Math.max( peak, Math.abs( d[ i ] ) );
  }
  if ( peak > 0 ) {
    const g = 0.42 / peak;
    for ( let ch = 0; ch < 2; ch++ ) {
      const d = buf.getChannelData( ch );
      for ( let i = 0; i < len; i++ ) d[ i ] *= g;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// voice builder — the tiny DSL every sound is written in
// ---------------------------------------------------------------------------

/**
 * A Patch collects the nodes for one triggered sound. Sources are registered
 * as they are created so the engine knows when the voice dies and can recycle
 * or disconnect everything exactly once.
 */
class Patch {
  constructor( ctx, out, t0, rng ) {
    this.ctx = ctx;
    this.out = out;              // per-voice gain owned by the engine
    this.t = t0;                 // start time in context seconds
    this.rng = rng;
    this.sources = [];
    this.end = t0;               // latest scheduled stop time
  }

  // -- random helpers ------------------------------------------------------
  rand( a = 0, b = 1 ) { return a + this.rng() * ( b - a ); }
  /** Random multiplier centred on 1, +/- `cents` in pitch terms. */
  detune( cents ) { return Math.pow( 2, this.rand( -cents, cents ) / 1200 ); }
  pick( arr ) { return arr[ Math.floor( this.rng() * arr.length ) % arr.length ]; }
  chance( p ) { return this.rng() < p; }

  // -- node factories ------------------------------------------------------
  gain( v = 1 ) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  filter( type, freq, q = 1 ) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = clamp( freq, 10, Math.min( 20000, this.ctx.sampleRate * 0.48 ) );
    f.Q.value = q;
    return f;
  }

  shaper( drive = 2, fold = false ) {
    const s = this.ctx.createWaveShaper();
    s.curve = fold ? foldCurve( drive ) : shaperCurve( drive );
    s.oversample = '2x';
    return s;
  }

  delay( time, max = 1 ) {
    const d = this.ctx.createDelay( max );
    d.delayTime.value = clamp( time, 0, max );
    return d;
  }

  /** Oscillator, started at `at` and stopped at `at + dur`. */
  osc( type, freq, at = this.t, dur = 0.3 ) {
    const o = this.ctx.createOscillator();
    if ( typeof type === 'string' ) o.type = type;
    else o.setPeriodicWave( type );
    o.frequency.value = clamp( freq, 0.01, 20000 );
    this.start( o, at, at + dur );
    return o;
  }

  /** Noise source reading from a random offset of the shared bed. */
  noise( at = this.t, dur = 0.3, kind = 'white', rate = 1 ) {
    const beds = noiseBeds( this.ctx );
    const src = this.ctx.createBufferSource();
    src.buffer = kind === 'pink' ? beds.pink : beds.white;
    src.playbackRate.value = clamp( rate, 0.05, 8 );
    src.loop = true;
    const offset = this.rng() * ( NOISE_SECONDS - 0.5 );
    src.start( at, offset );
    src.stop( at + dur );
    this.sources.push( src );
    this.end = Math.max( this.end, at + dur );
    return src;
  }

  start( node, at, stop ) {
    node.start( at );
    if ( stop !== undefined ) node.stop( stop );
    this.sources.push( node );
    this.end = Math.max( this.end, stop ?? at );
    return node;
  }

  /** Connect a chain of nodes and return the tail. */
  chain( ...nodes ) {
    for ( let i = 0; i < nodes.length - 1; i++ ) nodes[ i ].connect( nodes[ i + 1 ] );
    return nodes[ nodes.length - 1 ];
  }

  // -- envelopes -----------------------------------------------------------

  /**
   * Percussive envelope: silence -> peak over `atk` -> exponential fall over
   * `dec`, always finished with a short linear glide to true zero so the voice
   * can never end on a discontinuity (that is what makes a click).
   */
  hit( param, at, peak, atk = 0.002, dec = 0.2, curve = 1 ) {
    const p = Math.max( peak, 2 * EPS );
    param.setValueAtTime( EPS, at );
    if ( atk > 0.0005 ) param.exponentialRampToValueAtTime( p, at + atk );
    else param.linearRampToValueAtTime( p, at + Math.max( atk, 1 / this.ctx.sampleRate * 8 ) );
    const a = at + Math.max( atk, 0.0002 );
    if ( curve === 1 ) {
      param.exponentialRampToValueAtTime( EPS, a + dec );
    } else {
      // Multi-segment fall for a less "electronic", more natural decay.
      const steps = 4;
      for ( let i = 1; i <= steps; i++ ) {
        const t = i / steps;
        const v = Math.max( EPS, p * Math.pow( 1 - t, curve ) );
        param.exponentialRampToValueAtTime( v, a + dec * t );
      }
    }
    const endT = a + dec + 0.006;
    param.linearRampToValueAtTime( 0, endT );
    this.end = Math.max( this.end, endT );
    return endT;
  }

  /** Full ADSR for sustained layers (pads, vocals, sweeps). */
  adsr( param, at, peak, a = 0.01, d = 0.08, s = 0.6, hold = 0.2, r = 0.2 ) {
    const p = Math.max( peak, 2 * EPS );
    const sv = Math.max( p * s, EPS );
    param.setValueAtTime( EPS, at );
    param.exponentialRampToValueAtTime( p, at + Math.max( a, 0.0015 ) );
    param.exponentialRampToValueAtTime( sv, at + a + d );
    param.setValueAtTime( sv, at + a + d + hold );
    param.exponentialRampToValueAtTime( EPS, at + a + d + hold + r );
    const endT = at + a + d + hold + r + 0.008;
    param.linearRampToValueAtTime( 0, endT );
    this.end = Math.max( this.end, endT );
    return endT;
  }

  /** Bell-shaped amplitude (whooshes, fly-bys). */
  swell( param, at, peak, dur, skew = 0.35 ) {
    const p = Math.max( peak, 2 * EPS );
    param.setValueAtTime( EPS, at );
    param.exponentialRampToValueAtTime( p, at + dur * skew );
    param.exponentialRampToValueAtTime( EPS, at + dur );
    param.linearRampToValueAtTime( 0, at + dur + 0.006 );
    this.end = Math.max( this.end, at + dur + 0.006 );
    return at + dur + 0.006;
  }

  /** Exponential frequency sweep with a linear tail so it can reach 0-ish. */
  sweep( param, at, f0, f1, dur, exp = true ) {
    param.setValueAtTime( Math.max( f0, 0.01 ), at );
    if ( exp && f1 > 0.01 ) param.exponentialRampToValueAtTime( Math.max( f1, 0.01 ), at + dur );
    else param.linearRampToValueAtTime( Math.max( f1, 0.01 ), at + dur );
    return param;
  }

  /** Low-frequency modulator patched onto an AudioParam. */
  lfo( param, at, dur, rate, depth, type = 'sine' ) {
    const o = this.osc( type, rate, at, dur );
    const g = this.gain( depth );
    o.connect( g ).connect( param );
    return o;
  }
}

/**
 * A 2-operator FM voice — the workhorse for bells, leads and skill chimes.
 * Returns the carrier's output node (already enveloped).
 */
function fmVoice( p, at, freq, opts = {} ) {
  const ratio = opts.ratio ?? 2;
  const index = opts.index ?? 400;
  const dur = opts.dur ?? 0.5;
  const atk = opts.atk ?? 0.004;
  const dec = opts.dec ?? dur;
  const peak = opts.peak ?? 0.5;
  const curve = opts.curve ?? 1;

  const carrier = p.osc( opts.carrierType ?? 'sine', freq, at, dur + 0.05 );
  const mod = p.osc( opts.modType ?? 'sine', freq * ratio, at, dur + 0.05 );
  const modGain = p.gain( index );
  // Modulation index falls faster than amplitude: bright attack, pure tail.
  p.hit( modGain.gain, at, index, 0.001, dec * ( opts.indexDecay ?? 0.42 ) );
  mod.connect( modGain ).connect( carrier.frequency );

  const amp = p.gain( 0 );
  p.hit( amp.gain, at, peak, atk, dec, curve );
  carrier.connect( amp );
  return amp;
}

// ---------------------------------------------------------------------------
// SYNTH — one builder per sound. Every one is layered transient/body/tail,
// every one randomises pitch and timbre so repeats never sound cloned.
// ---------------------------------------------------------------------------

const SYNTH = {};

// --- shared gun-shot recipe ------------------------------------------------
/**
 * All firearms share the same anatomy: a sub-millisecond crack, a distorted
 * mid body whose bandpass falls as the muzzle blast expands, a low thump, a
 * diffuse tail, and a small mechanical click from the action cycling.
 */
function gunShot( p, cfg ) {
  const t = p.t;
  const pitch = p.detune( cfg.varyCents ?? 130 );
  const out = p.out;

  // 1. crack — the part that reads as "loud" on small speakers
  const crack = p.noise( t, 0.03, 'white', p.rand( 0.92, 1.14 ) );
  const crackHP = p.filter( 'highpass', cfg.crackHz * pitch, 0.7 );
  const crackBP = p.filter( 'bandpass', cfg.crackHz * 1.5 * pitch, 0.9 );
  const crackG = p.gain( 0 );
  p.hit( crackG.gain, t, cfg.crackAmp, 0.0004, cfg.crackDec );
  p.chain( crack, crackHP, crackBP, p.shaper( 4, false ), crackG ).connect( out );

  // 2. body — bandpass falling from the blast frequency to the chest thump
  const body = p.noise( t, cfg.bodyDec + 0.1, 'white', p.rand( 0.85, 1.2 ) );
  const bodyBP = p.filter( 'bandpass', cfg.bodyHz * pitch, cfg.bodyQ ?? 1.1 );
  p.sweep( bodyBP.frequency, t, cfg.bodyHz * pitch, cfg.bodyHz * 0.19 * pitch, cfg.bodyDec * 0.85 );
  const bodyDrive = p.shaper( cfg.drive ?? 2.4 );
  const bodyG = p.gain( 0 );
  p.hit( bodyG.gain, t, cfg.bodyAmp, 0.0015, cfg.bodyDec, 2 );
  p.chain( body, bodyBP, bodyDrive, bodyG ).connect( out );

  // 3. thump — the sub that makes it feel like a weapon rather than a hiss
  const thump = p.osc( 'sine', cfg.subHz * pitch, t, cfg.subDec + 0.05 );
  p.sweep( thump.frequency, t, cfg.subHz * 1.9 * pitch, cfg.subHz * 0.55 * pitch, cfg.subDec * 0.7 );
  const thumpG = p.gain( 0 );
  p.hit( thumpG.gain, t, cfg.subAmp, 0.002, cfg.subDec );
  p.chain( thump, thumpG ).connect( out );

  // 4. tail — dark diffuse wash; the reverb send does the rest
  if ( cfg.tailAmp > 0 ) {
    const tail = p.noise( t + 0.004, cfg.tailDec + 0.08, 'pink', p.rand( 0.8, 1.05 ) );
    const tailLP = p.filter( 'lowpass', 1900 * pitch, 0.9 );
    p.sweep( tailLP.frequency, t, 2400 * pitch, 420, cfg.tailDec );
    const tailG = p.gain( 0 );
    p.hit( tailG.gain, t + 0.004, cfg.tailAmp, 0.02, cfg.tailDec, 2.2 );
    p.chain( tail, tailLP, tailG ).connect( out );
  }

  // 5. action — bolt/slide cycling a beat behind the shot
  if ( cfg.mechAmp > 0 ) {
    const mt = t + p.rand( 0.028, 0.046 );
    const mech = p.noise( mt, 0.05, 'white', p.rand( 0.9, 1.3 ) );
    const mechBP = p.filter( 'bandpass', p.rand( 2600, 4200 ), 7 );
    const mechG = p.gain( 0 );
    p.hit( mechG.gain, mt, cfg.mechAmp, 0.001, 0.035 );
    p.chain( mech, mechBP, mechG ).connect( out );
  }
}

SYNTH.rifleShot = ( p ) => gunShot( p, {
  crackHz: 2700, crackAmp: 0.85, crackDec: 0.016,
  bodyHz: 1500, bodyAmp: 0.72, bodyDec: 0.15, bodyQ: 1.0, drive: 2.8,
  subHz: 96, subAmp: 0.5, subDec: 0.1,
  tailAmp: 0.2, tailDec: 0.3,
  mechAmp: 0.1, varyCents: 140,
} );

SYNTH.smgShot = ( p ) => gunShot( p, {
  crackHz: 3400, crackAmp: 0.78, crackDec: 0.011,
  bodyHz: 2000, bodyAmp: 0.56, bodyDec: 0.085, bodyQ: 1.3, drive: 2.2,
  subHz: 118, subAmp: 0.3, subDec: 0.06,
  tailAmp: 0.11, tailDec: 0.17,
  mechAmp: 0.13, varyCents: 190,
} );

SYNTH.pistolShot = ( p ) => gunShot( p, {
  crackHz: 3000, crackAmp: 0.8, crackDec: 0.014,
  bodyHz: 1750, bodyAmp: 0.6, bodyDec: 0.11, bodyQ: 1.2, drive: 2.4,
  subHz: 105, subAmp: 0.38, subDec: 0.08,
  tailAmp: 0.14, tailDec: 0.22,
  mechAmp: 0.16, varyCents: 160,
} );

SYNTH.shotgunBlast = ( p ) => {
  gunShot( p, {
    crackHz: 2100, crackAmp: 0.8, crackDec: 0.022,
    bodyHz: 1050, bodyAmp: 0.85, bodyDec: 0.3, bodyQ: 0.8, drive: 3.4,
    subHz: 74, subAmp: 0.62, subDec: 0.22,
    tailAmp: 0.3, tailDec: 0.5,
    mechAmp: 0, varyCents: 110,
  } );
  // Pump action, well after the blast.
  const t = p.t + p.rand( 0.19, 0.23 );
  for ( let i = 0; i < 2; i++ ) {
    const st = t + i * p.rand( 0.075, 0.1 );
    const n = p.noise( st, 0.07, 'white', p.rand( 0.8, 1.2 ) );
    const bp = p.filter( 'bandpass', p.rand( 1500, 2900 ), 5 );
    const g = p.gain( 0 );
    p.hit( g.gain, st, i ? 0.16 : 0.11, 0.002, 0.05, 2 );
    p.chain( n, bp, g ).connect( p.out );
  }
};

SYNTH.sniperShot = ( p ) => {
  gunShot( p, {
    crackHz: 3100, crackAmp: 0.95, crackDec: 0.02,
    bodyHz: 1650, bodyAmp: 0.8, bodyDec: 0.24, bodyQ: 0.95, drive: 3.6,
    subHz: 82, subAmp: 0.6, subDec: 0.18,
    tailAmp: 0.16, tailDec: 0.45,
    mechAmp: 0, varyCents: 90,
  } );
  const t = p.t;
  // The signature: a long slapback rolling off into the distance.
  const tail = p.noise( t + 0.02, 1.5, 'pink', p.rand( 0.7, 0.95 ) );
  const tLP = p.filter( 'lowpass', 2400, 0.8 );
  p.sweep( tLP.frequency, t, 2600, 220, 1.4 );
  const tHP = p.filter( 'highpass', 130, 0.7 );
  const tailG = p.gain( 0 );
  p.hit( tailG.gain, t + 0.02, 0.3, 0.05, 1.35, 2.6 );
  const echo = p.delay( 0.13, 0.6 );
  const fb = p.gain( 0.42 );
  const echoLP = p.filter( 'lowpass', 1400, 0.7 );
  const chainTail = p.chain( tail, tLP, tHP, tailG );
  chainTail.connect( p.out );
  chainTail.connect( echo );
  echo.connect( echoLP ).connect( fb ).connect( echo );
  echoLP.connect( p.out );
  // Supersonic crack whip-cracking away from the shooter.
  const whip = p.osc( 'sawtooth', 900, t + 0.012, 0.2 );
  p.sweep( whip.frequency, t + 0.012, 1500, 180, 0.18 );
  const whipF = p.filter( 'bandpass', 1200, 3 );
  p.sweep( whipF.frequency, t + 0.012, 2000, 300, 0.18 );
  const whipG = p.gain( 0 );
  p.hit( whipG.gain, t + 0.012, 0.16, 0.004, 0.17, 2 );
  p.chain( whip, whipF, whipG ).connect( p.out );
};

SYNTH.reload = ( p ) => {
  const out = p.out;
  const stage = ( at, cfg ) => {
    // Metallic mechanism click: a filtered noise burst plus 2 ringing partials.
    const n = p.noise( at, cfg.dur + 0.02, 'white', p.rand( 0.85, 1.25 ) );
    const bp = p.filter( 'bandpass', cfg.hz * p.detune( 200 ), cfg.q ?? 4 );
    const g = p.gain( 0 );
    p.hit( g.gain, at, cfg.amp, cfg.atk ?? 0.001, cfg.dur, cfg.curve ?? 1 );
    p.chain( n, bp, p.shaper( 1.6 ), g ).connect( out );

    if ( cfg.ring ) {
      for ( let i = 0; i < 2; i++ ) {
        const f = cfg.ring * ( i ? p.rand( 1.9, 2.4 ) : 1 ) * p.detune( 150 );
        const o = p.osc( 'triangle', f, at, cfg.ringDur ?? 0.12 );
        const og = p.gain( 0 );
        p.hit( og.gain, at, cfg.ringAmp * ( i ? 0.4 : 1 ), 0.001, cfg.ringDur ?? 0.12 );
        p.chain( o, og ).connect( out );
      }
    }
    if ( cfg.thud ) {
      const o = p.osc( 'sine', cfg.thud, at, 0.12 );
      p.sweep( o.frequency, at, cfg.thud * 1.7, cfg.thud * 0.6, 0.07 );
      const og = p.gain( 0 );
      p.hit( og.gain, at, cfg.thudAmp ?? 0.3, 0.002, 0.1 );
      p.chain( o, og ).connect( out );
    }
  };

  const t = p.t;
  // magazine release
  stage( t + p.rand( 0, 0.01 ), { hz: 3200, amp: 0.42, dur: 0.035, q: 6, ring: 2400, ringAmp: 0.1, ringDur: 0.07 } );
  // magazine dropping free — a loose rattle
  const dropT = t + p.rand( 0.1, 0.14 );
  for ( let i = 0; i < 3; i++ ) {
    stage( dropT + i * p.rand( 0.02, 0.05 ), { hz: p.rand( 1400, 2600 ), amp: 0.14 - i * 0.03, dur: 0.05, q: 3 } );
  }
  // fresh magazine seated: the big satisfying one
  const inT = t + p.rand( 0.45, 0.52 );
  stage( inT, { hz: 1700, amp: 0.5, dur: 0.09, q: 2.2, curve: 2, ring: 900, ringAmp: 0.16, ringDur: 0.16, thud: 120, thudAmp: 0.36 } );
  // bolt: draw then snap
  const boltT = t + p.rand( 0.72, 0.78 );
  const rasp = p.noise( boltT, 0.09, 'white', p.rand( 0.5, 0.7 ) );
  const raspBP = p.filter( 'bandpass', 1600, 2.4 );
  p.sweep( raspBP.frequency, boltT, 1200, 2600, 0.09 );
  const raspG = p.gain( 0 );
  p.swell( raspG.gain, boltT, 0.13, 0.09, 0.6 );
  p.chain( rasp, raspBP, raspG ).connect( out );
  stage( boltT + 0.095, { hz: 3600, amp: 0.45, dur: 0.05, q: 5.5, ring: 3100, ringAmp: 0.13, ringDur: 0.1, thud: 160, thudAmp: 0.2 } );
};

SYNTH.bulletWhizBy = ( p, o = {} ) => {
  const t = p.t;
  const dur = clamp( o.duration ?? p.rand( 0.16, 0.26 ), 0.08, 0.6 );
  const f0 = p.rand( 2100, 3400 );
  // Doppler: the pass-by drops roughly a fifth as it goes by the ear.
  const bp = p.filter( 'bandpass', f0, p.rand( 5, 9 ) );
  p.sweep( bp.frequency, t, f0 * 1.35, f0 * 0.42, dur );
  const n = p.noise( t, dur + 0.05, 'white', p.rand( 0.9, 1.1 ) );
  const g = p.gain( 0 );
  p.swell( g.gain, t, 0.55, dur, 0.3 );
  p.chain( n, bp, g ).connect( p.out );

  // A thin sine riding the band gives it the "zip" pitch you can actually hear.
  const zip = p.osc( 'sine', f0, t, dur + 0.02 );
  p.sweep( zip.frequency, t, f0 * 1.3, f0 * 0.45, dur );
  const zg = p.gain( 0 );
  p.swell( zg.gain, t, 0.12, dur, 0.3 );
  p.chain( zip, zg ).connect( p.out );

  // Low air displacement.
  const air = p.noise( t, dur + 0.05, 'pink', 1 );
  const lp = p.filter( 'lowpass', 700, 1 );
  const ag = p.gain( 0 );
  p.swell( ag.gain, t, 0.16, dur * 1.2, 0.35 );
  p.chain( air, lp, ag ).connect( p.out );
};

// --- impacts ---------------------------------------------------------------

SYNTH.impactConcrete = ( p ) => {
  const t = p.t;
  const pitch = p.detune( 300 );
  const crack = p.noise( t, 0.04, 'white', p.rand( 0.9, 1.2 ) );
  const hp = p.filter( 'highpass', 1800 * pitch, 0.8 );
  const cg = p.gain( 0 );
  p.hit( cg.gain, t, 0.7, 0.0006, 0.028 );
  p.chain( crack, hp, p.shaper( 2.2 ), cg ).connect( p.out );

  const body = p.noise( t, 0.2, 'white', p.rand( 0.8, 1.1 ) );
  const bp = p.filter( 'bandpass', 900 * pitch, 1.4 );
  p.sweep( bp.frequency, t, 1400 * pitch, 380 * pitch, 0.14 );
  const bg = p.gain( 0 );
  p.hit( bg.gain, t, 0.55, 0.001, 0.14, 2 );
  p.chain( body, bp, bg ).connect( p.out );

  const thud = p.osc( 'sine', 150 * pitch, t, 0.12 );
  p.sweep( thud.frequency, t, 210 * pitch, 80, 0.08 );
  const tg = p.gain( 0 );
  p.hit( tg.gain, t, 0.34, 0.002, 0.09 );
  p.chain( thud, tg ).connect( p.out );

  // Grit: a few loose pebbles skittering off.
  const bits = 2 + Math.floor( p.rand( 0, 3 ) );
  for ( let i = 0; i < bits; i++ ) {
    const bt = t + p.rand( 0.03, 0.22 );
    const n = p.noise( bt, 0.03, 'white', p.rand( 1, 1.6 ) );
    const f = p.filter( 'bandpass', p.rand( 2200, 6000 ), 8 );
    const g = p.gain( 0 );
    p.hit( g.gain, bt, p.rand( 0.05, 0.12 ), 0.0008, 0.022 );
    p.chain( n, f, g ).connect( p.out );
  }
};

SYNTH.impactMetal = ( p ) => {
  const t = p.t;
  const base = p.rand( 380, 620 );
  const clank = p.noise( t, 0.05, 'white', p.rand( 0.9, 1.3 ) );
  const hp = p.filter( 'highpass', 2600, 0.8 );
  const cg = p.gain( 0 );
  p.hit( cg.gain, t, 0.65, 0.0005, 0.03 );
  p.chain( clank, hp, p.shaper( 3 ), cg ).connect( p.out );

  // Inharmonic partials: what separates metal from a tuned bell.
  const ratios = [ 1, 1.71, 2.43, 3.19, 4.61, 6.07 ];
  for ( let i = 0; i < ratios.length; i++ ) {
    const f = base * ratios[ i ] * p.detune( 60 );
    if ( f > 16000 ) continue;
    const dec = 0.55 / ( 1 + i * 0.55 ) * p.rand( 0.8, 1.25 );
    const o = p.osc( i > 3 ? 'triangle' : 'sine', f, t, dec + 0.05 );
    const g = p.gain( 0 );
    p.hit( g.gain, t, 0.3 / ( 1 + i * 0.75 ), 0.0015, dec, 1 );
    p.chain( o, g ).connect( p.out );
  }

  // Ring modulated shimmer for the "sheet metal" character.
  const ring = p.noise( t, 0.25, 'white', 1 );
  const rbp = p.filter( 'bandpass', base * 4, 12 );
  p.sweep( rbp.frequency, t, base * 5.5, base * 2.4, 0.22 );
  const rg = p.gain( 0 );
  p.hit( rg.gain, t, 0.2, 0.002, 0.2, 2 );
  p.chain( ring, rbp, rg ).connect( p.out );
};

SYNTH.impactBody = ( p ) => {
  const t = p.t;
  const pitch = p.detune( 250 );
  // Wet slap transient — mid noise, no top end, that is what makes it flesh.
  const slap = p.noise( t, 0.07, 'white', p.rand( 0.8, 1.1 ) );
  const bp = p.filter( 'bandpass', 800 * pitch, 1.1 );
  p.sweep( bp.frequency, t, 1300 * pitch, 260 * pitch, 0.06 );
  const lp = p.filter( 'lowpass', 3200, 0.7 );
  const sg = p.gain( 0 );
  p.hit( sg.gain, t, 0.6, 0.0012, 0.055, 2 );
  p.chain( slap, bp, lp, sg ).connect( p.out );

  // Dull thud body.
  const thud = p.osc( 'sine', 120 * pitch, t, 0.2 );
  p.sweep( thud.frequency, t, 190 * pitch, 62, 0.11 );
  const tg = p.gain( 0 );
  p.hit( tg.gain, t, 0.52, 0.003, 0.16, 2 );
  p.chain( thud, tg ).connect( p.out );

  // Short squelchy resonance falling away.
  const res = p.noise( t + 0.005, 0.14, 'pink', 1 );
  const rf = p.filter( 'lowpass', 900, 6 );
  p.sweep( rf.frequency, t + 0.005, 1100, 260, 0.12 );
  const rg = p.gain( 0 );
  p.hit( rg.gain, t + 0.005, 0.24, 0.004, 0.12, 2 );
  p.chain( res, rf, rg ).connect( p.out );
};

SYNTH.shieldBreak = ( p ) => {
  const t = p.t;
  // Glass-crystal cluster: a bright chord with fast, unequal decays.
  const root = p.rand( 1150, 1400 );
  const ratios = [ 1, 1.26, 1.5, 2, 2.52, 3.0, 4.0 ];
  for ( let i = 0; i < ratios.length; i++ ) {
    const f = root * ratios[ i ] * p.detune( 45 );
    if ( f > 17000 ) continue;
    const dec = p.rand( 0.25, 0.85 ) / ( 1 + i * 0.22 );
    const amp = fmVoice( p, t + p.rand( 0, 0.02 ), f, {
      ratio: 3.4, index: f * 1.3, dur: dec + 0.1, atk: 0.002, dec, peak: 0.2 / ( 1 + i * 0.55 ),
    } );
    amp.connect( p.out );
  }
  // Shatter: a burst of high noise gated into shards.
  const sh = p.noise( t, 0.5, 'white', p.rand( 0.95, 1.1 ) );
  const shf = p.filter( 'highpass', 2600, 0.8 );
  const shg = p.gain( 0 );
  p.hit( shg.gain, t, 0.4, 0.001, 0.42, 3 );
  p.lfo( shg.gain, t, 0.45, 34, 0.1, 'square' );
  p.chain( sh, shf, shg ).connect( p.out );
  // The "pop" of the field collapsing.
  const pop = p.osc( 'sine', 300, t, 0.25 );
  p.sweep( pop.frequency, t, 900, 90, 0.2 );
  const pg = p.gain( 0 );
  p.hit( pg.gain, t, 0.34, 0.002, 0.2 );
  p.chain( pop, pg ).connect( p.out );
};

SYNTH.explosion = ( p, o = {} ) => {
  const t = p.t;
  const size = clamp( o.size ?? 1, 0.4, 2 );
  const pitch = p.detune( 160 ) / Math.sqrt( size );

  // 1. transient click — the ignition
  const click = p.noise( t, 0.02, 'white', 1.2 );
  const chp = p.filter( 'highpass', 3000, 0.7 );
  const cg = p.gain( 0 );
  p.hit( cg.gain, t, 0.62, 0.0004, 0.014 );
  p.chain( click, chp, p.shaper( 5 ), cg ).connect( p.out );

  // 2. body — wide-band blast, heavily saturated, filter collapsing downward
  const bodyDur = 0.75 * size;
  const body = p.noise( t, bodyDur + 0.2, 'white', p.rand( 0.85, 1.05 ) );
  const bLP = p.filter( 'lowpass', 1200, 1.4 );
  p.sweep( bLP.frequency, t, 2600 * pitch, 110, bodyDur );
  const bHP = p.filter( 'highpass', 45, 0.6 );
  const bg = p.gain( 0 );
  p.hit( bg.gain, t, 0.9, 0.004, bodyDur, 2.4 );
  p.chain( body, bLP, bHP, p.shaper( 4.5 ), bg ).connect( p.out );

  // 3. sub — the pressure wave; keep it clean and low
  const subDur = 0.95 * size;
  const sub = p.osc( 'sine', 60, t, subDur + 0.1 );
  p.sweep( sub.frequency, t, 82 * pitch, 26, subDur * 0.8 );
  const sg = p.gain( 0 );
  p.hit( sg.gain, t + 0.004, 0.75, 0.012, subDur, 2 );
  p.chain( sub, sg ).connect( p.out );

  // A second sub an octave up keeps it audible on laptop speakers.
  const sub2 = p.osc( 'triangle', 120, t, subDur * 0.6 );
  p.sweep( sub2.frequency, t, 160 * pitch, 58, subDur * 0.5 );
  const s2g = p.gain( 0 );
  p.hit( s2g.gain, t + 0.004, 0.26, 0.008, subDur * 0.55, 2 );
  p.chain( sub2, s2g ).connect( p.out );

  // 4. debris tail — gated noise plus discrete chunks landing
  const tailDur = 1.5 * size;
  const tail = p.noise( t + 0.06, tailDur, 'pink', p.rand( 0.7, 1 ) );
  const tbp = p.filter( 'bandpass', 900, 0.8 );
  p.sweep( tbp.frequency, t + 0.06, 1500, 320, tailDur );
  const tg = p.gain( 0 );
  p.hit( tg.gain, t + 0.06, 0.3, 0.05, tailDur, 3 );
  p.lfo( tg.gain, t + 0.06, tailDur, 11, 0.07, 'triangle' );
  p.chain( tail, tbp, tg ).connect( p.out );

  const chunks = 4 + Math.floor( p.rand( 0, 4 ) );
  for ( let i = 0; i < chunks; i++ ) {
    const ct = t + p.rand( 0.18, 0.9 ) * size;
    const n = p.noise( ct, 0.06, 'white', p.rand( 0.7, 1.3 ) );
    const f = p.filter( 'bandpass', p.rand( 400, 1800 ), p.rand( 3, 9 ) );
    const g = p.gain( 0 );
    p.hit( g.gain, ct, p.rand( 0.06, 0.16 ), 0.001, p.rand( 0.04, 0.09 ), 2 );
    p.chain( n, f, g ).connect( p.out );
  }
};

SYNTH.criticalHit = ( p ) => {
  const t = p.t;
  const base = 1450 * p.detune( 120 );
  // Bright bell stack — the "ding" that says the hit mattered.
  [ 1, 1.5, 2.02, 3.01 ].forEach( ( r, i ) => {
    const amp = fmVoice( p, t + i * 0.004, base * r, {
      ratio: i === 0 ? 2.01 : 3.5, index: base * r * 1.1,
      dur: 0.5 - i * 0.08, atk: 0.001, dec: 0.44 - i * 0.08,
      peak: 0.3 / ( 1 + i * 0.8 ), indexDecay: 0.3,
    } );
    amp.connect( p.out );
  } );
  // Metal slash transient.
  const sl = p.noise( t, 0.12, 'white', p.rand( 0.9, 1.2 ) );
  const bp = p.filter( 'bandpass', 3800, 3 );
  p.sweep( bp.frequency, t, 2200, 7000, 0.09 );
  const sg = p.gain( 0 );
  p.hit( sg.gain, t, 0.42, 0.001, 0.1, 2 );
  p.chain( sl, bp, p.shaper( 2.5 ), sg ).connect( p.out );
  // Punch underneath so it lands with weight, not just sparkle.
  const th = p.osc( 'sine', 180, t, 0.16 );
  p.sweep( th.frequency, t, 260, 70, 0.1 );
  const tg = p.gain( 0 );
  p.hit( tg.gain, t, 0.36, 0.002, 0.13 );
  p.chain( th, tg ).connect( p.out );
  // Rising sparkle tail.
  const sp = p.osc( 'sine', 3000, t + 0.02, 0.3 );
  p.sweep( sp.frequency, t + 0.02, 2600, 6400, 0.26 );
  const spg = p.gain( 0 );
  p.swell( spg.gain, t + 0.02, 0.08, 0.28, 0.4 );
  p.chain( sp, spg ).connect( p.out );
};

SYNTH.blockedHit = ( p ) => {
  const t = p.t;
  const base = p.rand( 240, 340 );
  // Damped clank: metal partials that die almost immediately.
  [ 1, 1.63, 2.31, 3.4 ].forEach( ( r, i ) => {
    const o = p.osc( 'triangle', base * r * p.detune( 70 ), t, 0.2 );
    const g = p.gain( 0 );
    p.hit( g.gain, t, 0.26 / ( 1 + i ), 0.001, 0.13 / ( 1 + i * 0.5 ), 2 );
    p.chain( o, g ).connect( p.out );
  } );
  const n = p.noise( t, 0.1, 'white', p.rand( 0.85, 1.15 ) );
  const bp = p.filter( 'bandpass', 1400, 1.6 );
  p.sweep( bp.frequency, t, 2400, 700, 0.07 );
  const ng = p.gain( 0 );
  p.hit( ng.gain, t, 0.5, 0.0008, 0.07, 2 );
  p.chain( n, bp, p.shaper( 2.8 ), ng ).connect( p.out );
  const th = p.osc( 'sine', 110, t, 0.14 );
  p.sweep( th.frequency, t, 170, 66, 0.08 );
  const tg = p.gain( 0 );
  p.hit( tg.gain, t, 0.4, 0.002, 0.11 );
  p.chain( th, tg ).connect( p.out );
};

// --- characters ------------------------------------------------------------

/** Footsteps carry a "variation index" so consecutive steps differ audibly. */
function footstep( p, cfg ) {
  const t = p.t;
  const v = Math.floor( p.rand( 0, 4 ) );          // pick one of 4 shoe timbres
  const pitch = p.detune( 500 ) * ( 1 + v * 0.06 );
  const heavy = cfg.heavy ?? 1;

  // heel — sharp, short
  const heel = p.noise( t, 0.07, 'white', p.rand( 0.8, 1.35 ) );
  const hbp = p.filter( 'bandpass', cfg.heelHz * pitch, cfg.heelQ );
  p.sweep( hbp.frequency, t, cfg.heelHz * 1.5 * pitch, cfg.heelHz * 0.55 * pitch, 0.05 );
  const hg = p.gain( 0 );
  p.hit( hg.gain, t, cfg.heelAmp * heavy * p.rand( 0.82, 1.18 ), 0.0012, cfg.heelDec * p.rand( 0.8, 1.25 ), 2 );
  p.chain( heel, hbp, hg ).connect( p.out );

  // sole/body — the mass of the step
  if ( cfg.bodyAmp > 0 ) {
    const bt = t + p.rand( 0.006, 0.022 );
    const b = p.noise( bt, cfg.bodyDec + 0.05, cfg.bodyKind ?? 'pink', p.rand( 0.7, 1.1 ) );
    const blp = p.filter( 'lowpass', cfg.bodyHz * pitch, 1.1 );
    const bg = p.gain( 0 );
    p.hit( bg.gain, bt, cfg.bodyAmp * heavy * p.rand( 0.8, 1.2 ), 0.004, cfg.bodyDec, 2 );
    p.chain( b, blp, bg ).connect( p.out );
  }

  // low thump — only concrete/wood has one
  if ( cfg.subAmp > 0 ) {
    const o = p.osc( 'sine', cfg.subHz * pitch, t, 0.12 );
    p.sweep( o.frequency, t, cfg.subHz * 1.6 * pitch, cfg.subHz * 0.6, 0.06 );
    const g = p.gain( 0 );
    p.hit( g.gain, t, cfg.subAmp * heavy, 0.003, 0.085 );
    p.chain( o, g ).connect( p.out );
  }

  // grains — grit, gravel or grass blades
  const grains = cfg.grains ?? 0;
  for ( let i = 0; i < grains; i++ ) {
    const gt = t + p.rand( 0, cfg.grainSpread ?? 0.06 );
    const n = p.noise( gt, 0.03, 'white', p.rand( 0.9, 1.6 ) );
    const f = p.filter( 'bandpass', p.rand( cfg.grainLo, cfg.grainHi ), p.rand( 4, 10 ) );
    const g = p.gain( 0 );
    p.hit( g.gain, gt, p.rand( 0.03, 0.1 ) * heavy, 0.001, p.rand( 0.012, 0.035 ), 2 );
    p.chain( n, f, g ).connect( p.out );
  }
}

SYNTH.footstepConcrete = ( p, o = {} ) => footstep( p, {
  heelHz: 1900, heelQ: 1.4, heelAmp: 0.5, heelDec: 0.045,
  bodyHz: 620, bodyAmp: 0.34, bodyDec: 0.09,
  subHz: 92, subAmp: 0.22,
  grains: 2, grainLo: 2400, grainHi: 7000, grainSpread: 0.05,
  heavy: o.heavy ?? 1,
} );

SYNTH.footstepGrass = ( p, o = {} ) => footstep( p, {
  heelHz: 3400, heelQ: 0.9, heelAmp: 0.3, heelDec: 0.06,
  bodyHz: 1800, bodyAmp: 0.22, bodyDec: 0.11, bodyKind: 'white',
  subHz: 80, subAmp: 0.07,
  grains: 5, grainLo: 3000, grainHi: 11000, grainSpread: 0.1,
  heavy: o.heavy ?? 1,
} );

SYNTH.dashWhoosh = ( p ) => {
  const t = p.t;
  const dur = p.rand( 0.34, 0.44 );
  // Body of air: bandpass sweeping up then back down as she passes.
  const n = p.noise( t, dur + 0.1, 'white', p.rand( 0.9, 1.15 ) );
  const bp = p.filter( 'bandpass', 400, 1.5 );
  bp.frequency.setValueAtTime( 320, t );
  bp.frequency.exponentialRampToValueAtTime( p.rand( 1800, 2600 ), t + dur * 0.42 );
  bp.frequency.exponentialRampToValueAtTime( 380, t + dur );
  const g = p.gain( 0 );
  p.swell( g.gain, t, 0.6, dur, 0.4 );
  p.chain( n, bp, g ).connect( p.out );

  // Low rush underneath for weight.
  const lo = p.noise( t, dur + 0.1, 'pink', 1 );
  const lp = p.filter( 'lowpass', 520, 1.2 );
  p.sweep( lp.frequency, t, 300, 900, dur * 0.5 );
  const lg = p.gain( 0 );
  p.swell( lg.gain, t, 0.34, dur * 1.05, 0.45 );
  p.chain( lo, lp, lg ).connect( p.out );

  // A thin doppler tone gives the movement direction.
  const tone = p.osc( 'sine', 700, t, dur );
  p.sweep( tone.frequency, t, 520, 1500, dur * 0.45 );
  tone.frequency.exponentialRampToValueAtTime( 460, t + dur );
  const tg = p.gain( 0 );
  p.swell( tg.gain, t, 0.07, dur, 0.4 );
  p.chain( tone, tg ).connect( p.out );

  // Cloth snap at the start — the skirt/coat catching the air.
  const snap = p.noise( t, 0.05, 'white', p.rand( 1, 1.4 ) );
  const shp = p.filter( 'highpass', 2600, 0.8 );
  const sg = p.gain( 0 );
  p.hit( sg.gain, t, 0.22, 0.002, 0.04, 2 );
  p.chain( snap, shp, sg ).connect( p.out );
};

SYNTH.landThud = ( p, o = {} ) => {
  const t = p.t;
  const w = clamp( o.weight ?? 1, 0.4, 2 );
  const sub = p.osc( 'sine', 90, t, 0.34 );
  p.sweep( sub.frequency, t, 145 / w, 42, 0.14 );
  const sg = p.gain( 0 );
  p.hit( sg.gain, t, 0.8, 0.004, 0.26, 2 );
  p.chain( sub, sg ).connect( p.out );

  const body = p.noise( t, 0.24, 'pink', p.rand( 0.8, 1.05 ) );
  const lp = p.filter( 'lowpass', 900, 1.2 );
  p.sweep( lp.frequency, t, 1500, 260, 0.16 );
  const bg = p.gain( 0 );
  p.hit( bg.gain, t, 0.46, 0.002, 0.18, 2 );
  p.chain( body, lp, p.shaper( 2 ), bg ).connect( p.out );

  const scuff = p.noise( t + 0.01, 0.12, 'white', p.rand( 0.9, 1.3 ) );
  const bp = p.filter( 'bandpass', 2600, 1.8 );
  p.sweep( bp.frequency, t + 0.01, 3800, 1200, 0.1 );
  const cg = p.gain( 0 );
  p.hit( cg.gain, t + 0.01, 0.24, 0.002, 0.1, 2 );
  p.chain( scuff, bp, cg ).connect( p.out );

  // Gear rattle on landing.
  for ( let i = 0; i < 3; i++ ) {
    const rt = t + p.rand( 0.02, 0.12 );
    const n = p.noise( rt, 0.03, 'white', p.rand( 1, 1.5 ) );
    const f = p.filter( 'bandpass', p.rand( 2600, 5200 ), 8 );
    const g = p.gain( 0 );
    p.hit( g.gain, rt, p.rand( 0.04, 0.09 ), 0.001, 0.025 );
    p.chain( n, f, g ).connect( p.out );
  }
};

/**
 * Vocal stand-in. A glottal-ish source through three formant bandpasses plus a
 * breath layer — it reads as a human effort sound without being speech.
 */
function vocal( p, cfg ) {
  const t = p.t;
  const f0 = cfg.f0 * p.detune( 180 );
  const dur = cfg.dur;

  const src = p.osc( cfg.wave ?? 'sawtooth', f0, t, dur + 0.06 );
  src.frequency.setValueAtTime( f0 * cfg.pitchUp, t );
  src.frequency.exponentialRampToValueAtTime( f0, t + dur * 0.18 );
  src.frequency.exponentialRampToValueAtTime( f0 * cfg.pitchEnd, t + dur );
  // Vibrato — small and slightly irregular, otherwise it sounds like a synth.
  p.lfo( src.frequency, t, dur, p.rand( 4.5, 6.5 ), f0 * 0.022 );

  const glottal = p.gain( 0 );
  p.adsr( glottal.gain, t, cfg.amp, cfg.atk, cfg.dur * 0.18, 0.55, cfg.hold, cfg.rel );
  src.connect( glottal );

  // Formants: F1/F2/F3 slide, which is what makes it a vowel not a buzz.
  const fmts = cfg.formants;
  for ( let i = 0; i < fmts.length; i++ ) {
    const [ hz, q, g ] = fmts[ i ];
    const bp = p.filter( 'bandpass', hz, q );
    p.sweep( bp.frequency, t, hz * cfg.formantUp, hz * cfg.formantEnd, dur );
    const fg = p.gain( g );
    glottal.connect( bp ).connect( fg ).connect( p.out );
  }

  // Breath.
  const br = p.noise( t, dur + 0.05, 'white', 1 );
  const bbp = p.filter( 'bandpass', fmts[ 1 ][ 0 ] * 1.4, 1.1 );
  const bg = p.gain( 0 );
  p.adsr( bg.gain, t, cfg.breath, cfg.atk * 1.5, dur * 0.2, 0.4, cfg.hold, cfg.rel * 1.3 );
  p.chain( br, bbp, bg ).connect( p.out );

  // Keep it from ever sounding harsh/digital.
  return dur;
}

SYNTH.hurtGrunt = ( p, o = {} ) => {
  const bright = o.bright ?? p.rand( 0.9, 1.15 );
  vocal( p, {
    f0: p.rand( 235, 300 ) * bright,
    dur: p.rand( 0.22, 0.3 ),
    wave: 'sawtooth',
    pitchUp: 1.16, pitchEnd: 0.8,
    atk: 0.012, hold: 0.05, rel: 0.11,
    amp: 0.24, breath: 0.1,
    formantUp: 1.1, formantEnd: 0.86,
    formants: [ [ 700, 7, 1.0 ], [ 1180, 8, 0.6 ], [ 2750, 9, 0.24 ] ],
  } );
  // Impact bump under the voice so it reads as "hit", not "sang".
  const th = p.osc( 'sine', 130, p.t, 0.12 );
  p.sweep( th.frequency, p.t, 190, 70, 0.08 );
  const g = p.gain( 0 );
  p.hit( g.gain, p.t, 0.22, 0.003, 0.1 );
  p.chain( th, g ).connect( p.out );
};

SYNTH.downed = ( p ) => {
  const t = p.t;
  vocal( p, {
    f0: p.rand( 245, 285 ),
    dur: p.rand( 0.75, 0.95 ),
    wave: 'sawtooth',
    pitchUp: 1.22, pitchEnd: 0.52,
    atk: 0.02, hold: 0.28, rel: 0.34,
    amp: 0.22, breath: 0.13,
    formantUp: 1.14, formantEnd: 0.62,
    formants: [ [ 660, 6, 1.0 ], [ 1120, 7, 0.62 ], [ 2600, 8, 0.2 ] ],
  } );
  // Collapse: knees, then body.
  [ [ 0.42, 0.3, 105 ], [ 0.62, 0.55, 72 ] ].forEach( ( [ dt, amp, hz ] ) => {
    const at = t + dt + p.rand( -0.03, 0.03 );
    const o = p.osc( 'sine', hz, at, 0.3 );
    p.sweep( o.frequency, at, hz * 1.6, hz * 0.5, 0.14 );
    const g = p.gain( 0 );
    p.hit( g.gain, at, amp, 0.004, 0.24, 2 );
    p.chain( o, g ).connect( p.out );
    const n = p.noise( at, 0.2, 'pink', p.rand( 0.8, 1 ) );
    const lp = p.filter( 'lowpass', 800, 1 );
    p.sweep( lp.frequency, at, 1400, 300, 0.15 );
    const ng = p.gain( 0 );
    p.hit( ng.gain, at, amp * 0.5, 0.004, 0.16, 2 );
    p.chain( n, lp, ng ).connect( p.out );
  } );
  // World going muffled — a soft descending shimmer.
  const sh = p.osc( 'sine', 1400, t + 0.1, 0.9 );
  p.sweep( sh.frequency, t + 0.1, 1500, 380, 0.85 );
  const sg = p.gain( 0 );
  p.swell( sg.gain, t + 0.1, 0.07, 0.9, 0.2 );
  p.chain( sh, sg ).connect( p.out );
};

// --- skills / UI -----------------------------------------------------------

SYNTH.skillReady = ( p ) => {
  const t = p.t;
  const root = 880 * p.detune( 25 );
  // Two-note rising bell (fifth), FM for a glassy attack.
  [ [ 0, 1 ], [ 0.085, 1.5 ] ].forEach( ( [ dt, r ], i ) => {
    const amp = fmVoice( p, t + dt, root * r, {
      ratio: 3.01, index: root * r * 0.9, dur: 0.7, atk: 0.002,
      dec: 0.6 - i * 0.1, peak: 0.28, indexDecay: 0.25,
    } );
    amp.connect( p.out );
    // Octave shimmer.
    const sh = fmVoice( p, t + dt, root * r * 2, {
      ratio: 2.0, index: root * r, dur: 0.4, atk: 0.003, dec: 0.34, peak: 0.09,
    } );
    sh.connect( p.out );
  } );
  // Airy lift.
  const air = p.noise( t, 0.35, 'white', 1 );
  const bp = p.filter( 'bandpass', 4000, 2.5 );
  p.sweep( bp.frequency, t, 2400, 8000, 0.3 );
  const ag = p.gain( 0 );
  p.swell( ag.gain, t, 0.08, 0.32, 0.5 );
  p.chain( air, bp, ag ).connect( p.out );
};

SYNTH.skillCast = ( p ) => {
  const t = p.t;
  const dur = 0.6;
  // 1. riser — resonant lowpass climbing over a detuned saw pair
  for ( let i = 0; i < 2; i++ ) {
    const o = p.osc( 'sawtooth', 180, t, dur + 0.1 );
    p.sweep( o.frequency, t, 150 * ( i ? 1.007 : 0.993 ), 900, dur * 0.95 );
    const lp = p.filter( 'lowpass', 400, 9 );
    p.sweep( lp.frequency, t, 320, 6500, dur * 0.95 );
    const g = p.gain( 0 );
    p.swell( g.gain, t, 0.2, dur, 0.72 );
    p.chain( o, lp, g ).connect( p.out );
  }
  // 2. noise riser
  const n = p.noise( t, dur + 0.1, 'white', 1 );
  const bp = p.filter( 'bandpass', 800, 3 );
  p.sweep( bp.frequency, t, 700, 9000, dur );
  const ng = p.gain( 0 );
  p.swell( ng.gain, t, 0.18, dur, 0.8 );
  p.chain( n, bp, ng ).connect( p.out );
  // 3. shimmer — a cluster of high partials fading in
  const base = 1320 * p.detune( 20 );
  [ 1, 1.5, 2, 2.5, 3 ].forEach( ( r, i ) => {
    const o = p.osc( 'sine', base * r, t + dur * 0.35, dur * 0.75 );
    const g = p.gain( 0 );
    p.swell( g.gain, t + dur * 0.35, 0.06 / ( 1 + i * 0.4 ), dur * 0.7, 0.6 );
    p.lfo( g.gain, t + dur * 0.35, dur * 0.7, p.rand( 6, 11 ), 0.02 );
    p.chain( o, g ).connect( p.out );
  } );
  // 4. the release — a bell hit at the top of the sweep
  const bt = t + dur * 0.92;
  [ 1, 1.5, 2.02 ].forEach( ( r, i ) => {
    const amp = fmVoice( p, bt, 660 * r, {
      ratio: 2.01, index: 900 * r, dur: 0.9, atk: 0.002, dec: 0.8, peak: 0.24 / ( 1 + i * 0.7 ),
    } );
    amp.connect( p.out );
  } );
  const boom = p.osc( 'sine', 90, bt, 0.4 );
  p.sweep( boom.frequency, bt, 160, 52, 0.24 );
  const bg = p.gain( 0 );
  p.hit( bg.gain, bt, 0.42, 0.004, 0.32, 2 );
  p.chain( boom, bg ).connect( p.out );
};

SYNTH.healPulse = ( p ) => {
  const t = p.t;
  const root = 523.25 * p.detune( 12 );          // C5 major triad, warm
  const ratios = [ 1, 1.26, 1.5, 2 ];
  ratios.forEach( ( r, i ) => {
    for ( let d = 0; d < 2; d++ ) {
      const o = p.osc( 'triangle', root * r * ( d ? 1.004 : 0.996 ), t, 1.0 );
      const lp = p.filter( 'lowpass', 2600, 1 );
      p.sweep( lp.frequency, t, 900, 4200, 0.5 );
      const g = p.gain( 0 );
      p.adsr( g.gain, t + i * 0.03, 0.12 / ( 1 + i * 0.5 ), 0.09, 0.15, 0.65, 0.24, 0.38 );
      p.lfo( g.gain, t, 0.9, 5.2 + i, 0.012 );
      p.chain( o, lp, g ).connect( p.out );
    }
  } );
  // Rising sparkle motes.
  for ( let i = 0; i < 5; i++ ) {
    const st = t + 0.05 + i * p.rand( 0.05, 0.1 );
    const f = root * p.pick( [ 2, 2.52, 3, 4, 5.04 ] ) * p.detune( 30 );
    const o = p.osc( 'sine', f, st, 0.4 );
    p.sweep( o.frequency, st, f * 0.94, f * 1.12, 0.35 );
    const g = p.gain( 0 );
    p.swell( g.gain, st, 0.055, 0.36, 0.3 );
    p.chain( o, g ).connect( p.out );
  }
  // Soft breath of air blooming outward.
  const n = p.noise( t, 0.8, 'pink', 1 );
  const bp = p.filter( 'bandpass', 1600, 1.2 );
  p.sweep( bp.frequency, t, 900, 3600, 0.6 );
  const ng = p.gain( 0 );
  p.swell( ng.gain, t, 0.07, 0.75, 0.35 );
  p.chain( n, bp, ng ).connect( p.out );
};

/** Small, clean UI blip. */
function blip( p, cfg ) {
  const t = p.t;
  const f = cfg.hz * p.detune( cfg.vary ?? 15 );
  const o = p.osc( cfg.wave ?? 'sine', f, t, cfg.dur + 0.05 );
  if ( cfg.glide ) p.sweep( o.frequency, t, f * cfg.glide, f, cfg.dur * 0.6 );
  const g = p.gain( 0 );
  p.hit( g.gain, t, cfg.amp, cfg.atk ?? 0.003, cfg.dur, cfg.curve ?? 1 );
  const lp = p.filter( 'lowpass', cfg.lp ?? 6000, 0.8 );
  p.chain( o, lp, g ).connect( p.out );
  if ( cfg.partial ) {
    const o2 = p.osc( 'sine', f * cfg.partial, t, cfg.dur * 0.6 );
    const g2 = p.gain( 0 );
    p.hit( g2.gain, t, cfg.amp * 0.3, 0.002, cfg.dur * 0.5 );
    p.chain( o2, g2 ).connect( p.out );
  }
  if ( cfg.tick ) {
    const n = p.noise( t, 0.02, 'white', 1 );
    const hp = p.filter( 'highpass', 4000, 0.8 );
    const ng = p.gain( 0 );
    p.hit( ng.gain, t, cfg.tick, 0.0006, 0.012 );
    p.chain( n, hp, ng ).connect( p.out );
  }
}

SYNTH.uiHover = ( p ) => blip( p, { hz: 1480, dur: 0.055, amp: 0.16, wave: 'sine', partial: 2.0, lp: 7000, vary: 30 } );

SYNTH.uiClick = ( p ) => {
  blip( p, { hz: 1050, dur: 0.075, amp: 0.34, wave: 'triangle', glide: 1.25, partial: 3.02, tick: 0.16, vary: 20 } );
  const t = p.t;
  const amp = fmVoice( p, t, 2100, { ratio: 2.01, index: 1400, dur: 0.16, atk: 0.001, dec: 0.14, peak: 0.12 } );
  amp.connect( p.out );
};

SYNTH.uiBack = ( p ) => {
  const t = p.t;
  [ [ 0, 880 ], [ 0.055, 587.33 ] ].forEach( ( [ dt, hz ], i ) => {
    const o = p.osc( 'triangle', hz * p.detune( 12 ), t + dt, 0.22 );
    const g = p.gain( 0 );
    p.hit( g.gain, t + dt, 0.24 - i * 0.05, 0.003, 0.16, 2 );
    const lp = p.filter( 'lowpass', 4200, 0.9 );
    p.chain( o, lp, g ).connect( p.out );
  } );
};

SYNTH.uiError = ( p ) => {
  const t = p.t;
  // A minor second against the root: dissonant but small, not a buzzer.
  [ 320, 339 ].forEach( ( hz, i ) => {
    const o = p.osc( 'square', hz * p.detune( 10 ), t, 0.3 );
    const lp = p.filter( 'lowpass', 1900, 1.4 );
    const g = p.gain( 0 );
    // Two short pulses.
    g.gain.setValueAtTime( EPS, t );
    g.gain.exponentialRampToValueAtTime( 0.2 - i * 0.05, t + 0.006 );
    g.gain.exponentialRampToValueAtTime( 0.02, t + 0.09 );
    g.gain.exponentialRampToValueAtTime( 0.18 - i * 0.05, t + 0.12 );
    g.gain.exponentialRampToValueAtTime( EPS, t + 0.26 );
    g.gain.linearRampToValueAtTime( 0, t + 0.27 );
    p.chain( o, lp, g ).connect( p.out );
  } );
  const sub = p.osc( 'sine', 150, t, 0.2 );
  p.sweep( sub.frequency, t, 190, 110, 0.16 );
  const sg = p.gain( 0 );
  p.hit( sg.gain, t, 0.2, 0.004, 0.16, 2 );
  p.chain( sub, sg ).connect( p.out );
};

SYNTH.costPipFill = ( p, o = {} ) => {
  const step = clamp( o.index ?? 0, 0, 9 );
  const t = p.t;
  // Pentatonic ladder so filling the bar plays a little run.
  const scale = [ 0, 2, 4, 7, 9, 12, 14, 16, 19, 21 ];
  const f = mtof( 74 + scale[ step % scale.length ] ) * p.detune( 8 );
  const amp = fmVoice( p, t, f, { ratio: 2.01, index: f * 0.7, dur: 0.3, atk: 0.002, dec: 0.26, peak: 0.22 } );
  amp.connect( p.out );
  const o2 = p.osc( 'sine', f * 2, t, 0.16 );
  const g2 = p.gain( 0 );
  p.hit( g2.gain, t, 0.06, 0.002, 0.14 );
  p.chain( o2, g2 ).connect( p.out );
  const n = p.noise( t, 0.05, 'white', 1 );
  const hp = p.filter( 'highpass', 5000, 0.8 );
  const ng = p.gain( 0 );
  p.hit( ng.gain, t, 0.08, 0.001, 0.035 );
  p.chain( n, hp, ng ).connect( p.out );
};

SYNTH.waveIncoming = ( p ) => {
  const t = p.t;
  // Cute klaxon: a rocking major sixth on a soft PWM-ish voice, not a siren.
  const notes = [ 0, 0.34, 0.68 ];
  notes.forEach( ( dt, i ) => {
    const hi = i % 2 === 0;
    const f = ( hi ? 987.77 : 739.99 ) * p.detune( 8 );      // B5 / F#5
    for ( let d = 0; d < 2; d++ ) {
      const o = p.osc( d ? 'triangle' : 'square', f * ( d ? 1.005 : 1 ), t + dt, 0.34 );
      const lp = p.filter( 'lowpass', 3000, 1.6 );
      p.sweep( lp.frequency, t + dt, 2200, 3600, 0.12 );
      const g = p.gain( 0 );
      p.adsr( g.gain, t + dt, d ? 0.16 : 0.1, 0.012, 0.05, 0.7, 0.13, 0.12 );
      p.lfo( o.frequency, t + dt, 0.3, 5.5, f * 0.012 );
      p.chain( o, lp, g ).connect( p.out );
    }
    // Bell doubling keeps it bright and toy-like.
    const amp = fmVoice( p, t + dt, f * 2, { ratio: 2.01, index: f, dur: 0.3, atk: 0.002, dec: 0.26, peak: 0.07 } );
    amp.connect( p.out );
  } );
  // Soft pulsing low bed for urgency without grimness.
  const bed = p.osc( 'sine', 110, t, 1.0 );
  const bg = p.gain( 0 );
  p.swell( bg.gain, t, 0.18, 1.0, 0.25 );
  p.lfo( bg.gain, t, 1.0, 6, 0.05 );
  p.chain( bed, bg ).connect( p.out );
};

SYNTH.missionComplete = ( p ) => {
  const t = p.t;
  // D major fanfare: arpeggio up, then the tonic chord with a sparkle wash.
  const arp = [ 62, 66, 69, 74, 78, 81, 86 ];
  arp.forEach( ( m, i ) => {
    const at = t + i * 0.085;
    const f = mtof( m ) * p.detune( 6 );
    const amp = fmVoice( p, at, f, {
      ratio: 2.005, index: f * 1.1, dur: 0.55, atk: 0.003, dec: 0.42, peak: 0.16, indexDecay: 0.3,
    } );
    amp.connect( p.out );
    const sq = p.osc( 'square', f * 0.5, at, 0.2 );
    const lp = p.filter( 'lowpass', 2600, 1.2 );
    const g = p.gain( 0 );
    p.hit( g.gain, at, 0.07, 0.004, 0.16, 2 );
    p.chain( sq, lp, g ).connect( p.out );
  } );
  // Final chord.
  const ct = t + arp.length * 0.085 + 0.03;
  [ 62, 66, 69, 74, 81 ].forEach( ( m, i ) => {
    const f = mtof( m ) * p.detune( 5 );
    const amp = fmVoice( p, ct, f, {
      ratio: 2.01, index: f * 0.8, dur: 1.5, atk: 0.004, dec: 1.3, peak: 0.15 / ( 1 + i * 0.25 ), indexDecay: 0.25,
    } );
    amp.connect( p.out );
    for ( let d = 0; d < 2; d++ ) {
      const o = p.osc( 'triangle', f * ( d ? 1.006 : 0.994 ), ct, 1.4 );
      const g = p.gain( 0 );
      p.adsr( g.gain, ct, 0.07 / ( 1 + i * 0.3 ), 0.02, 0.2, 0.55, 0.5, 0.55 );
      p.chain( o, g ).connect( p.out );
    }
  } );
  // Bass root and a cymbal-ish swell.
  const bass = p.osc( 'triangle', mtof( 38 ), ct, 1.2 );
  const bg = p.gain( 0 );
  p.hit( bg.gain, ct, 0.28, 0.006, 1.0, 2 );
  p.chain( bass, bg ).connect( p.out );
  const cym = p.noise( ct - 0.05, 1.0, 'white', 1 );
  const chp = p.filter( 'highpass', 5000, 0.7 );
  const cg = p.gain( 0 );
  p.hit( cg.gain, ct - 0.05, 0.14, 0.02, 0.9, 3 );
  p.chain( cym, chp, cg ).connect( p.out );
};

SYNTH.missionFailed = ( p ) => {
  const t = p.t;
  // Descending minor: B minor -> G -> E dim-ish, slow and soft, not comedic.
  const chords = [ [ 59, 62, 66 ], [ 55, 59, 62 ], [ 52, 55, 59 ] ];
  chords.forEach( ( ch, ci ) => {
    const at = t + ci * 0.55;
    ch.forEach( ( m, i ) => {
      const f = mtof( m ) * p.detune( 8 );
      for ( let d = 0; d < 2; d++ ) {
        const o = p.osc( d ? 'sawtooth' : 'triangle', f * ( d ? 1.005 : 0.995 ), at, 1.1 );
        const lp = p.filter( 'lowpass', 1500, 1.1 );
        p.sweep( lp.frequency, at, 1900 - ci * 400, 700 - ci * 150, 0.9 );
        const g = p.gain( 0 );
        p.adsr( g.gain, at, ( d ? 0.05 : 0.09 ) / ( 1 + i * 0.3 ), 0.05, 0.2, 0.6, 0.2, 0.5 );
        p.chain( o, lp, g ).connect( p.out );
      }
    } );
    const bass = p.osc( 'sine', mtof( ch[ 0 ] - 24 ), at, 0.9 );
    const bg = p.gain( 0 );
    p.hit( bg.gain, at, 0.3, 0.01, 0.75, 2 );
    p.chain( bass, bg ).connect( p.out );
  } );
  // Power-down: a slow filtered fall at the end.
  const et = t + 1.5;
  const o = p.osc( 'sawtooth', 220, et, 1.1 );
  p.sweep( o.frequency, et, 230, 58, 1.0 );
  const lp = p.filter( 'lowpass', 1200, 4 );
  p.sweep( lp.frequency, et, 1400, 200, 1.0 );
  const g = p.gain( 0 );
  p.hit( g.gain, et, 0.2, 0.02, 0.95, 2 );
  p.chain( o, lp, g ).connect( p.out );
};

SYNTH.rankStamp = ( p ) => {
  const t = p.t;
  // Paper/ink slap.
  const slap = p.noise( t, 0.09, 'white', p.rand( 0.9, 1.1 ) );
  const bp = p.filter( 'bandpass', 1500, 1.1 );
  p.sweep( bp.frequency, t, 2600, 600, 0.06 );
  const sg = p.gain( 0 );
  p.hit( sg.gain, t, 0.62, 0.0008, 0.07, 2 );
  p.chain( slap, bp, p.shaper( 2.6 ), sg ).connect( p.out );
  // Weight.
  const th = p.osc( 'sine', 100, t, 0.3 );
  p.sweep( th.frequency, t, 170, 48, 0.12 );
  const tg = p.gain( 0 );
  p.hit( tg.gain, t, 0.66, 0.003, 0.22, 2 );
  p.chain( th, tg ).connect( p.out );
  // Bright confirmation chime a beat later.
  const ct = t + 0.09;
  [ 1, 1.5, 2.0 ].forEach( ( r, i ) => {
    const amp = fmVoice( p, ct, 1046.5 * r, {
      ratio: 2.01, index: 1500 * r, dur: 0.9 - i * 0.15, atk: 0.002,
      dec: 0.8 - i * 0.15, peak: 0.17 / ( 1 + i * 0.7 ), indexDecay: 0.22,
    } );
    amp.connect( p.out );
  } );
  // Air.
  const air = p.noise( t, 0.3, 'white', 1 );
  const hp = p.filter( 'highpass', 6000, 0.7 );
  const ag = p.gain( 0 );
  p.hit( ag.gain, t, 0.1, 0.004, 0.26, 3 );
  p.chain( air, hp, ag ).connect( p.out );
};
