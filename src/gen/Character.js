import * as THREE from 'three';
import { createToonMaterial, createOutlineMaterial, computeSmoothNormals, paintGeometry } from '../render/ToonMaterial.js';
import { buildSkeleton, skinGeometry, skinRigid, SKIN_SEGMENTS } from './Rig.js';
import { buildHair, HEAD } from './Hair.js';
import { makeFaceAtlas, makeHeadSkin } from './Face.js';
import {
  profileTube, limb, roundedBox, shapeHead, planarFrontUV, faceCard,
  pleatedSkirt, xform, mirrorX, mergeGeometries,
} from './Geometry.js';

const V = ( x, y, z ) => new THREE.Vector3( x, y, z );

/* ---------------------------------------------------------------------- */
/* Palettes                                                                */
/* ---------------------------------------------------------------------- */

export const PALETTE = {
  skin: 0xffe3d0,
  uniformWhite: 0xf7f9fd,
  uniformNavy: 0x2f3757,
  accentBlue: 0x35a3ea,
  accentCyan: 0x7fd6ff,
  enemyRed: 0xff5d6c,
  cost: 0xffd54a,
  halo: 0x9fe8ff,
  ink: 0x2b2138,
};

/**
 * Student roster. Each entry is a complete visual design — palette, hair
 * style, eye shape, halo type — from which a full character is generated.
 * Nothing here references an asset file; the whole cast is data.
 */
export const STUDENT_PRESETS = {
  hoshi: {
    name: 'HOSHI', callsign: 'Abydos 01',
    skin: 0xffe0cb,
    hair: { color: 0x8fb4e8, accent: 0xc3daf7, style: 'ponytail' },
    eyes: { color: 0x4d9fe0, shape: 'droopy', lash: 0x2b3352 },
    brow: 0x7d9ac9,
    outfit: { shirt: 0xf7f9fd, skirt: 0x3f4a76, jacket: 0x4b5988, ribbon: 0xff5d6c, socks: 0x3f4a72, shoes: 0x333c5c, trim: 0x35a3ea, sockBand: 0x46507a, sole: 0xe8edf5, belt: 0x2b3350 },
    halo: { type: 'ring', color: 0x8fd8ff },
    weapon: 'rifle',
  },
  aoi: {
    name: 'AOI', callsign: 'Abydos 02',
    skin: 0xffe6d4,
    hair: { color: 0xf2d478, accent: 0xfff0b8, style: 'twintail' },
    eyes: { color: 0x36b37e, shape: 'round', lash: 0x453a2c },
    brow: 0xc0a35a,
    outfit: { shirt: 0xf7f9fd, skirt: 0x475283, jacket: 0x5a67a0, ribbon: 0x36b37e, socks: 0xf2f5fa, shoes: 0x2b3148, trim: 0xffd54a, sockBand: 0xdfe6f2, sole: 0xf0f3f8, belt: 0x2f3757 },
    halo: { type: 'wing', color: 0xffe89a },
    weapon: 'smg',
  },
  rei: {
    name: 'REI', callsign: 'Gehenna 07',
    skin: 0xffdcc6,
    hair: { color: 0x8e4a68, accent: 0xd07fa0, style: 'long' },
    eyes: { color: 0xd8465e, shape: 'sharp', lash: 0x3a2030 },
    brow: 0x5e3348,
    outfit: { shirt: 0xf4f0f6, skirt: 0x553650, jacket: 0x6a4462, ribbon: 0xffd54a, socks: 0x3d2a3a, shoes: 0x1f1420, trim: 0xd8465e, sockBand: 0x40283c, sole: 0xe9e2ea, belt: 0x3a2436 },
    halo: { type: 'cross', color: 0xff9ab5 },
    weapon: 'shotgun',
  },
  yuki: {
    name: 'YUKI', callsign: 'Trinity 12',
    skin: 0xfff0e2,
    hair: { color: 0xe8eaf2, accent: 0xffffff, style: 'bob' },
    eyes: { color: 0x7b6ee0, shape: 'cool', lash: 0x3a3552 },
    brow: 0xb9bccd,
    outfit: { shirt: 0xffffff, skirt: 0x43528a, jacket: 0x5566ab, ribbon: 0x7b6ee0, socks: 0xf2f5fa, shoes: 0x2a3050, trim: 0x9fe8ff, sockBand: 0xdde7f5, sole: 0xf2f5fa, belt: 0x2c3558 },
    halo: { type: 'diamond', color: 0xc9c0ff },
    weapon: 'sniper',
  },
};

/** Hostile "helmet" archetype — same rig, cheaper build, no face cards. */
export const ENEMY_PRESETS = {
  grunt: {
    name: 'GRUNT', hostile: true,
    skin: 0xd8c8bc,
    hair: { color: 0x3a3a44, accent: 0x55555f, style: 'short' },
    eyes: { color: 0xff5d6c, shape: 'sharp', lash: 0x201820 },
    brow: 0x33333a,
    outfit: { shirt: 0x5a6070, skirt: null, jacket: 0x474d5c, ribbon: 0xff5d6c, socks: 0x2c313d, shoes: 0x22262f, trim: 0xff5d6c, trousers: 0x3b414f, sockBand: 0x373d4b, sole: 0x4a505e, belt: 0x2b303b },
    halo: { type: 'ring', color: 0xff7d8c },
    weapon: 'smg',
    faceless: true,
  },
  heavy: {
    name: 'HEAVY', hostile: true,
    skin: 0xd0bfb2,
    hair: { color: 0x2e2e36, accent: 0x44444e, style: 'short' },
    eyes: { color: 0xffb03a, shape: 'sharp', lash: 0x201820 },
    brow: 0x2b2b32,
    outfit: { shirt: 0x6b5f52, skirt: null, jacket: 0x574c42, ribbon: 0xffb03a, socks: 0x33302c, shoes: 0x26241f, trim: 0xffb03a, trousers: 0x453e36, sockBand: 0x3d3931, sole: 0x57524a, belt: 0x332f29 },
    halo: { type: 'ring', color: 0xffc76a },
    weapon: 'shotgun',
    scale: 1.16,
    faceless: true,
  },
};

/* ---------------------------------------------------------------------- */
/* Body construction                                                       */
/* ---------------------------------------------------------------------- */

/**
 * Builds the bare body in bind pose: head, neck, torso, arms, hands, legs.
 * The uniform is layered on top of this, slightly inflated, so the silhouette
 * comes from the clothing rather than from the body poking through it.
 */
function buildBody( design ) {
  const parts = [];
  const skin = design.skin;

  // --- neck ------------------------------------------------------------
  parts.push( paintGeometry( profileTube(
    [ { y: 1.268, rx: 0.055, rz: 0.050 }, { y: 1.322, rx: 0.046, rz: 0.043 }, { y: 1.368, rx: 0.049, rz: 0.046 } ],
    { radial: 14, capTop: false, capBottom: false }
  ), skin ) );

  // --- torso -----------------------------------------------------------
  // Kept as skin because the collar opening and the gap under a short sleeve
  // both expose it; the shirt is a separate, slightly larger shell.
  parts.push( paintGeometry( profileTube( [
    { y: 0.845, rx: 0.118, rz: 0.082 },
    { y: 0.940, rx: 0.100, rz: 0.072 },
    { y: 1.020, rx: 0.096, rz: 0.070 },
    { y: 1.120, rx: 0.116, rz: 0.078, cz: 0.004 },
    { y: 1.200, rx: 0.128, rz: 0.086, cz: 0.008 },
    { y: 1.272, rx: 0.124, rz: 0.078 },
    { y: 1.310, rx: 0.096, rz: 0.062 },
  ], { radial: 20, capTop: true, capBottom: true, capRound: 0.4 } ), skin ) );

  // --- arms ------------------------------------------------------------
  for ( const sx of [ -1, 1 ] ) {
    const shoulder = V( sx * 0.150, 1.262, 0 );
    const elbow = V( sx * 0.262, 1.038, 0 );
    const wrist = V( sx * 0.352, 0.845, 0 );

    parts.push( paintGeometry( limb( shoulder, elbow, [
      { t: 0, r: 0.049 }, { t: 0.25, r: 0.042 }, { t: 0.75, r: 0.034 }, { t: 1, r: 0.031 },
    ], { radial: 14, capTop: false, capBottom: true, capRound: 1 } ), skin ) );

    parts.push( paintGeometry( limb( elbow, wrist, [
      { t: 0, r: 0.032 }, { t: 0.35, r: 0.029 }, { t: 1, r: 0.021 },
    ], { radial: 12, capTop: false, capBottom: true, capRound: 1 } ), skin ) );

    // Hand: a flattened rounded box with a thumb stub. At the distances this
    // game is played at, articulated fingers would be invisible geometry.
    const handDir = wrist.clone().sub( elbow ).normalize();
    const hand = roundedBox( 0.030, 0.086, 0.058, 0.014, 3 );
    const q = new THREE.Quaternion().setFromUnitVectors( V( 0, -1, 0 ), handDir );
    hand.applyMatrix4( new THREE.Matrix4().makeRotationFromQuaternion( q ) );
    hand.translate( wrist.x + handDir.x * 0.038, wrist.y + handDir.y * 0.038, wrist.z + handDir.z * 0.038 );
    parts.push( paintGeometry( hand, skin ) );

    const thumb = roundedBox( 0.020, 0.040, 0.020, 0.009, 2 );
    thumb.rotateZ( sx * -0.7 );
    thumb.applyMatrix4( new THREE.Matrix4().makeRotationFromQuaternion( q ) );
    thumb.translate( wrist.x + handDir.x * 0.022 - sx * 0.020, wrist.y + handDir.y * 0.022, wrist.z + 0.020 );
    parts.push( paintGeometry( thumb, skin ) );
  }

  // --- legs ------------------------------------------------------------
  for ( const sx of [ -1, 1 ] ) {
    const hip = V( sx * 0.076, 0.880, 0 );
    const knee = V( sx * 0.079, 0.478, 0 );
    const ankle = V( sx * 0.081, 0.090, 0 );

    parts.push( paintGeometry( limb( hip, knee, [
      { t: 0, r: 0.085 }, { t: 0.30, r: 0.076 }, { t: 0.72, r: 0.058 }, { t: 1, r: 0.049 },
    ], { radial: 16, capTop: true, capBottom: true, capRound: 0.7 } ), skin ) );

    parts.push( paintGeometry( limb( knee, ankle, [
      { t: 0, r: 0.050 }, { t: 0.22, r: 0.055 }, { t: 0.70, r: 0.036 }, { t: 1, r: 0.028 },
    ], { radial: 14, capTop: false, capBottom: true, capRound: 0.8 } ), skin ) );
  }

  return mergeGeometries( parts );
}

/**
 * The uniform: shirt shell, collar, sleeves, ribbon, skirt or trousers,
 * socks and shoes. Each piece is painted with its own colour so the whole
 * outfit still merges into the body's single draw call.
 */
function buildOutfit( design ) {
  const o = design.outfit;
  const parts = [];

  // --- shirt -----------------------------------------------------------
  const shirt = profileTube( [
    { y: 0.862, rx: 0.126, rz: 0.090 },
    { y: 0.945, rx: 0.109, rz: 0.080 },
    { y: 1.030, rx: 0.106, rz: 0.079 },
    { y: 1.125, rx: 0.126, rz: 0.087, cz: 0.004 },
    { y: 1.205, rx: 0.138, rz: 0.095, cz: 0.008 },
    { y: 1.272, rx: 0.140, rz: 0.090 },
    { y: 1.318, rx: 0.106, rz: 0.072 },
  ], { radial: 22, capTop: false, capBottom: false } );
  parts.push( paintGeometry( shirt, o.shirt ) );

  // --- open jacket: two front panels and a back panel ------------------
  if ( o.jacket ) {
    const jacket = profileTube( [
      { y: 0.905, rx: 0.140, rz: 0.100 },
      { y: 1.020, rx: 0.122, rz: 0.092 },
      { y: 1.130, rx: 0.140, rz: 0.099 },
      { y: 1.215, rx: 0.151, rz: 0.107 },
      { y: 1.272, rx: 0.145, rz: 0.096 },
    ], { radial: 26, capTop: false, capBottom: false } );
    // Slice out the front opening so the shirt and ribbon read through it.
    const pos = jacket.attributes.position;
    const keep = [];
    const idx = jacket.getIndex().array;
    for ( let i = 0; i < idx.length; i += 3 ) {
      const a = idx[ i ], b = idx[ i + 1 ], c = idx[ i + 2 ];
      const cx = ( pos.getX( a ) + pos.getX( b ) + pos.getX( c ) ) / 3;
      const cz = ( pos.getZ( a ) + pos.getZ( b ) + pos.getZ( c ) ) / 3;
      if ( !( cz > 0.02 && Math.abs( cx ) < 0.052 ) ) keep.push( a, b, c );
    }
    jacket.setIndex( keep );
    parts.push( paintGeometry( jacket, o.jacket ) );
  }

  // --- collar: two flaps folded back from the neck ---------------------
  for ( const sx of [ -1, 1 ] ) {
    const flap = roundedBox( 0.062, 0.016, 0.070, 0.006, 2 );
    flap.rotateX( -0.55 );
    flap.rotateZ( sx * 0.42 );
    flap.translate( sx * 0.048, 1.290, 0.052 );
    parts.push( paintGeometry( flap, o.shirt ) );
  }

  // --- ribbon ----------------------------------------------------------
  const knot = roundedBox( 0.026, 0.028, 0.022, 0.008, 2 );
  knot.translate( 0, 1.262, 0.082 );
  parts.push( paintGeometry( knot, o.ribbon ) );
  for ( const sx of [ -1, 1 ] ) {
    const loop = roundedBox( 0.055, 0.042, 0.016, 0.010, 2 );
    loop.rotateZ( sx * 0.30 );
    loop.rotateY( sx * -0.28 );
    loop.translate( sx * 0.042, 1.266, 0.076 );
    parts.push( paintGeometry( loop, o.ribbon ) );

    const tailPiece = roundedBox( 0.026, 0.062, 0.012, 0.005, 2 );
    tailPiece.rotateZ( sx * 0.18 );
    tailPiece.translate( sx * 0.017, 1.222, 0.080 );
    parts.push( paintGeometry( tailPiece, o.ribbon ) );
  }

  // --- sleeves ---------------------------------------------------------
  for ( const sx of [ -1, 1 ] ) {
    const shoulder = V( sx * 0.110, 1.300, 0 );
    const cuff = V( sx * 0.216, 1.128, 0 );
    const sleeve = limb( shoulder, cuff, [
      { t: 0, r: 0.086 }, { t: 0.22, r: 0.078 }, { t: 0.62, r: 0.060 }, { t: 1, r: 0.049 },
    ], { radial: 16, capTop: true, capBottom: false, capRound: 0.55 } );
    parts.push( paintGeometry( sleeve, o.jacket ?? o.shirt ) );

    const trim = limb( cuff, V( sx * 0.222, 1.118, 0 ), [ { t: 0, r: 0.051 }, { t: 1, r: 0.049 } ], { radial: 16, capTop: false, capBottom: false } );
    parts.push( paintGeometry( trim, o.cuff ?? o.shirt ) );
  }

  // --- lower body ------------------------------------------------------
  if ( o.skirt ) {
    parts.push( paintGeometry( pleatedSkirt( {
      waistY: 0.905, hemY: 0.660,
      waistRX: 0.132, waistRZ: 0.096,
      hemRX: 0.212, hemRZ: 0.168,
      pleats: 22, depth: 0.115,
    } ), o.skirt ) );

    // Waistband.
    parts.push( paintGeometry( profileTube( [
      { y: 0.898, rx: 0.132, rz: 0.096 }, { y: 0.930, rx: 0.134, rz: 0.098 },
    ], { radial: 22, capTop: false, capBottom: false } ), o.belt ?? o.jacket ?? o.skirt ) );
  } else if ( o.trousers ) {
    for ( const sx of [ -1, 1 ] ) {
      parts.push( paintGeometry( limb( V( sx * 0.076, 0.900, 0 ), V( sx * 0.080, 0.300, 0 ), [
        { t: 0, r: 0.098 }, { t: 0.35, r: 0.086 }, { t: 0.85, r: 0.062 }, { t: 1, r: 0.058 },
      ], { radial: 14, capTop: false, capBottom: false } ), o.trousers ) );
    }
    parts.push( paintGeometry( profileTube( [
      { y: 0.880, rx: 0.126, rz: 0.092 }, { y: 0.930, rx: 0.128, rz: 0.094 },
    ], { radial: 20, capTop: false, capBottom: false } ), o.belt ?? o.jacket ) );
  }

  // --- socks -----------------------------------------------------------
  if ( o.socks ) {
    const top = o.skirt ? 0.590 : 0.300;
    for ( const sx of [ -1, 1 ] ) {
      const a = V( sx * 0.0795, top, 0 );
      const b = V( sx * 0.081, 0.086, 0 );
      parts.push( paintGeometry( limb( a, b, [
        { t: 0, r: 0.063 }, { t: 0.05, r: 0.067 }, { t: 0.30, r: 0.064 }, { t: 0.78, r: 0.045 }, { t: 1, r: 0.037 },
      ], { radial: 14, capTop: false, capBottom: false } ), o.socks ) );

      // The elastic band at the top, a shade brighter — a small detail that
      // does a lot of work at silhouette scale.
      parts.push( paintGeometry( limb( a, V( sx * 0.0795, top - 0.022, 0 ), [
        { t: 0, r: 0.0645 }, { t: 1, r: 0.0685 },
      ], { radial: 14, capTop: false, capBottom: false } ), o.sockBand ?? o.trim ) );
    }
  }

  // --- shoes -----------------------------------------------------------
  for ( const sx of [ -1, 1 ] ) {
    const shoe = roundedBox( 0.072, 0.062, 0.165, 0.024, 3 );
    shoe.translate( sx * 0.081, 0.052, 0.030 );
    parts.push( paintGeometry( shoe, o.shoes ) );

    const sole = roundedBox( 0.076, 0.018, 0.170, 0.008, 2 );
    sole.translate( sx * 0.081, 0.014, 0.030 );
    parts.push( paintGeometry( sole, o.sole ?? 0xf2f4f8 ) );
  }

  return mergeGeometries( parts );
}

/* ---------------------------------------------------------------------- */
/* Halo                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * The halo. It is the single most recognisable element of the genre, it is
 * always emissive, and it is the main thing feeding the bloom pass — so the
 * colour is pushed well above 1.0 rather than being merely bright.
 */
function buildHalo( type, color ) {
  const group = new THREE.Group();
  group.name = 'halo';

  const mat = createToonMaterial( {
    color: 0xffffff,
    emissive: color,
    emissiveIntensity: 1.9,
    ambient: 0,
    shadowStrength: 0,
    flatten: 1,
    rimStrength: 0,
    specStrength: 0,
    transparent: true,
    opacity: 0.94,
    side: THREE.DoubleSide,
  } );
  mat.depthWrite = false;

  const add = ( geo ) => { const m = new THREE.Mesh( geo, mat ); m.castShadow = false; group.add( m ); };

  switch ( type ) {
    case 'wing': {
      add( xform( new THREE.TorusGeometry( 0.090, 0.0055, 8, 44 ), { rotation: [ Math.PI / 2, 0, 0 ] } ) );
      for ( const sx of [ -1, 1 ] ) {
        for ( let i = 0; i < 3; i++ ) {
          const f = new THREE.PlaneGeometry( 0.052 - i * 0.010, 0.014 );
          f.translate( sx * ( 0.100 + i * 0.022 ), 0, -i * 0.014 );
          f.rotateY( sx * 0.2 );
          add( f );
        }
      }
      break;
    }
    case 'cross': {
      add( xform( new THREE.TorusGeometry( 0.084, 0.005, 8, 40 ), { rotation: [ Math.PI / 2, 0, 0 ] } ) );
      const v = new THREE.PlaneGeometry( 0.014, 0.090 );
      v.rotateX( Math.PI / 2 );
      add( v );
      const h = new THREE.PlaneGeometry( 0.090, 0.014 );
      h.rotateX( Math.PI / 2 );
      add( h );
      break;
    }
    case 'diamond': {
      add( xform( new THREE.TorusGeometry( 0.086, 0.007, 4, 4 ), { rotation: [ Math.PI / 2, 0, Math.PI / 4 ] } ) );
      add( xform( new THREE.TorusGeometry( 0.058, 0.005, 4, 4 ), { rotation: [ Math.PI / 2, 0, Math.PI / 4 ] } ) );
      break;
    }
    default: {
      add( xform( new THREE.TorusGeometry( 0.092, 0.0055, 8, 48 ), { rotation: [ Math.PI / 2, 0, 0 ] } ) );
      add( xform( new THREE.TorusGeometry( 0.066, 0.0028, 6, 40 ), { rotation: [ Math.PI / 2, 0, 0 ] } ) );
    }
  }

  return group;
}

/* ---------------------------------------------------------------------- */
/* Face rig                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Drives the eye / brow / mouth cards.
 *
 * Blinking is a UV offset on a shared atlas, and pupil tracking is a small
 * positional nudge of the eye card, clamped so the iris never slides off the
 * sclera. Both are cheap enough to run on every character every frame.
 */
class FaceRig {
  constructor( atlas, cards ) {
    this.atlas = atlas;
    this.cards = cards;
    this.expression = 'open';
    this.brow = 'neutral';
    this.mouth = 'smile';

    this._blinkTimer = 1 + Math.random() * 3;
    this._blinkPhase = 0;
    this._gaze = new THREE.Vector2();
    this._gazeTarget = new THREE.Vector2();
    this._override = null;
    this._overrideTime = 0;
  }

  /** Rewrites a card's UVs to point at a named atlas cell. */
  _setFrame( card, key, mirrored ) {
    const f = this.atlas.frames[ key ];
    if ( !f ) return;
    const uv = card.geometry.attributes.uv;
    const base = card.userData.baseUV;
    for ( let i = 0; i < uv.count; i++ ) {
      const u = mirrored ? 1 - base[ i * 2 ] : base[ i * 2 ];
      uv.setXY( i, f.x + u * f.w, f.y + base[ i * 2 + 1 ] * f.h );
    }
    uv.needsUpdate = true;
  }

  setExpression( { eye, brow, mouth, hold = 0 } = {} ) {
    if ( eye ) this.expression = eye;
    if ( brow ) this.brow = brow;
    if ( mouth ) this.mouth = mouth;
    this._overrideTime = hold;
    this._apply();
  }

  _apply() {
    this.cards.eyes.forEach( ( c, i ) => this._setFrame( c, `eye.${this._current ?? this.expression}`, i === 1 ) );
    this.cards.brows.forEach( ( c, i ) => this._setFrame( c, `brow.${this.brow}`, i === 1 ) );
    this._setFrame( this.cards.mouth, `mouth.${this.mouth}`, false );
  }

  /** Aims the pupils at a world-space point. */
  lookAt( worldPoint, headObject ) {
    if ( !worldPoint ) { this._gazeTarget.set( 0, 0 ); return; }
    headObject.worldToLocal( _tmpV.copy( worldPoint ) );
    // Scaled down hard: an anime eye only needs a few millimetres of travel
    // to read as "looking over there", and more slides the iris off the white.
    this._gazeTarget.set(
      THREE.MathUtils.clamp( _tmpV.x * 0.09, -1, 1 ),
      THREE.MathUtils.clamp( _tmpV.y * 0.06, -1, 1 )
    );
  }

  update( dt ) {
    // --- blink ---------------------------------------------------------
    this._blinkTimer -= dt;
    if ( this._blinkTimer <= 0 && this._blinkPhase <= 0 ) {
      this._blinkPhase = 1;
      // Humans blink in bursts, not on a metronome.
      this._blinkTimer = 1.8 + Math.random() * 4.2;
    }

    let frame = this.expression;
    if ( this._blinkPhase > 0 ) {
      this._blinkPhase -= dt * 7.5;
      // Down through half-lidded, closed, and back — 130 ms end to end.
      const p = 1 - this._blinkPhase;
      if ( p < 0.22 || p > 0.78 ) frame = 'half';
      else frame = 'closed';
      if ( this._blinkPhase <= 0 ) this._blinkPhase = 0;
    }

    if ( frame !== this._current ) {
      this._current = frame;
      this.cards.eyes.forEach( ( c, i ) => this._setFrame( c, `eye.${frame}`, i === 1 ) );
    }

    // --- gaze ----------------------------------------------------------
    this._gaze.lerp( this._gazeTarget, 1 - Math.pow( 0.001, dt ) );
    this.cards.eyes.forEach( ( c ) => {
      c.position.x = c.userData.restX + this._gaze.x * 0.006;
      c.position.y = c.userData.restY + this._gaze.y * 0.004;
    } );
  }
}

const _tmpV = new THREE.Vector3();

/* ---------------------------------------------------------------------- */
/* Character                                                               */
/* ---------------------------------------------------------------------- */

export class Character {
  /**
   * @param {object} design  One of {@link STUDENT_PRESETS} / {@link ENEMY_PRESETS}, or a compatible object.
   * @param {object} [opts]
   * @param {number} [opts.quality=2]
   * @param {boolean} [opts.outlines=true]
   */
  constructor( design, opts = {} ) {
    this.design = design;
    this.quality = opts.quality ?? 2;
    this.meshes = [];
    this.springChains = [];

    const root = new THREE.Group();
    root.name = design.name ?? 'character';
    this.root = root;

    // --- head geometry, shared by the skin mesh and the hair shell ------
    const headGeo = shapeHead( 0.118, { jawNarrow: 0.60, chin: 0.24 } );
    headGeo.translate( 0, HEAD.centerY, 0 );

    // --- hair, which contributes extra bones -----------------------------
    const hair = buildHair( design.hair.style, headGeo, design.hair.opts );

    const { root: boneRoot, bones, byName, skeleton, order } = buildSkeleton( hair.boneDefs );
    this.skeleton = skeleton;
    this.bones = byName;
    root.add( boneRoot );

    const allSegments = [ ...SKIN_SEGMENTS, ...hair.segments ];

    // --- materials -------------------------------------------------------
    const outlineMat = createOutlineMaterial( {
      color: design.outlineColor ?? PALETTE.ink,
      thickness: 0.0030,
      vertexTint: true,
      tintMix: 0.8,
    } );
    this.outlineMaterial = outlineMat;

    // --- body + outfit ---------------------------------------------------
    const bodyGeo = computeSmoothNormals( mergeGeometries( [ buildBody( design ), buildOutfit( design ) ] ) );
    skinGeometry( bodyGeo, order, { segments: allSegments, falloff: 2.6 } );
    const bodyMat = createToonMaterial( {
      color: 0xffffff,
      vertexTint: true,
      specStrength: 0.16,
      specGloss: 30,
      rimStrength: 0.45,
      rimColor: design.rimColor ?? PALETTE.accentCyan,
    } );
    this.bodyMaterial = bodyMat;
    this._addSkinned( 'body', bodyGeo, bodyMat, outlineMat, skeleton );

    // --- head ------------------------------------------------------------
    const headSkinTex = makeHeadSkin( {
      size: 512,
      skin: design.skin,
      blush: design.blush ?? 0xff9aa2,
      freckles: !!design.freckles,
    } );
    planarFrontUV( headGeo, { width: 0.285, height: 0.300, centerY: HEAD.centerY, arcCorrect: 0.30 } );
    computeSmoothNormals( headGeo );
    skinRigid( headGeo, order, 'head' );
    const headMat = createToonMaterial( {
      color: 0xffffff,
      map: headSkinTex,
      // Faces stay lit. Letting the cel ramp fall across a face is what makes
      // a stylised character look like a 3D dummy instead of a drawing.
      flatten: 0.82,
      specStrength: 0.05,
      rimStrength: 0.5,
      rimColor: design.rimColor ?? PALETTE.accentCyan,
    } );
    this.headMaterial = headMat;
    this._addSkinned( 'head', headGeo, headMat, outlineMat, skeleton );

    // --- hair ------------------------------------------------------------
    const hairGeos = [];
    const hs = computeSmoothNormals( hair.staticGeometry );
    paintGeometry( hs, design.hair.color );
    skinRigid( hs, order, 'head' );
    hairGeos.push( hs );

    if ( hair.dynamicGeometry ) {
      const hd = computeSmoothNormals( hair.dynamicGeometry );
      paintGeometry( hd, design.hair.color );
      skinGeometry( hd, order, { segments: hair.segments, falloff: 2.0 } );
      hairGeos.push( hd );
    }

    const hairMat = createToonMaterial( {
      color: 0xffffff,
      vertexTint: true,
      // A tight, banded highlight running around the head is the signature of
      // anime hair; `specBand` folds a horizontal mask over the specular so it
      // forms a ring rather than a blob.
      specStrength: 0.30,
      specGloss: 34,
      specStep: 0.30,
      specSoft: 0.16,
      specBand: 2,               // band over object-space Y
      specBandPos: 1.552,        // just above the eye line, where art puts it
      specBandWidth: 0.026,
      specBandRepeat: 0.062,
      specColor: design.hair.accent ?? 0xffffff,
      rimStrength: 0.62,
      rimColor: design.rimColor ?? PALETTE.accentCyan,
      shadowTint: 0xc0b8dc,
      midTint: 0xdfd9ee,
      ambient: 0.44,
      shadowStep: 0.44,
      shadowSoft: 0.030,
    } );
    this.hairMaterial = hairMat;
    this._addSkinned( 'hair', mergeGeometries( hairGeos ), hairMat, outlineMat, skeleton );

    // --- face -------------------------------------------------------------
    if ( !design.faceless ) {
      this._buildFace( design, byName.head );
    }

    // --- halo -------------------------------------------------------------
    const halo = buildHalo( design.halo?.type, design.halo?.color ?? PALETTE.halo );
    halo.position.set( 0, HEAD.top - 1.392 + 0.115, -0.010 );
    byName.head.add( halo );
    this.halo = halo;

    // --- spring chains ----------------------------------------------------
    this.hairChains = hair.chains.map( ( names ) => names.map( ( n ) => byName[ n ] ).filter( Boolean ) );

    if ( design.scale && design.scale !== 1 ) root.scale.setScalar( design.scale );

    this.height = HEAD.top * ( design.scale ?? 1 );
  }

  _addSkinned( name, geometry, material, outlineMaterial, skeleton ) {
    const mesh = new THREE.SkinnedMesh( geometry, material );
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // skinned bounds go stale as the pose changes
    mesh.bind( skeleton, new THREE.Matrix4() );
    this.root.add( mesh );
    this.meshes.push( mesh );

    if ( outlineMaterial ) {
      const outline = new THREE.SkinnedMesh( geometry, outlineMaterial );
      outline.name = `${name}_outline`;
      outline.castShadow = false;
      outline.receiveShadow = false;
      outline.frustumCulled = false;
      outline.bind( skeleton, new THREE.Matrix4() );
      this.root.add( outline );
      mesh.userData.outline = outline;
    }
    return mesh;
  }

  _buildFace( design, headBone ) {
    const atlas = makeFaceAtlas( {
      irisColor: design.eyes.color,
      lashColor: design.eyes.lash ?? 0x2a2038,
      shape: design.eyes.shape,
      browColor: design.brow,
    } );
    this.faceAtlas = atlas;

    const mat = createToonMaterial( {
      color: 0xffffff,
      map: atlas.texture,
      transparent: true,
      alphaTest: 0.22,
      // Face features are ink on a drawing — they must not receive shading.
      flatten: 1,
      ambient: 0,
      shadowStrength: 0,
      rimStrength: 0,
      specStrength: 0,
    } );
    mat.depthWrite = true;
    this.faceMaterial = mat;

    // Bone-local Y: the head bone sits at 1.392, features are placed against
    // measured anime proportions on a head spanning 1.340–1.605.
    const localY = ( worldY ) => worldY - 1.392;

    const cards = { eyes: [], brows: [], mouth: null };
    const group = new THREE.Group();
    group.name = 'face';

    const mkCard = ( w, h, x, y, z, curve ) => {
      const geo = faceCard( w, h, curve );
      const uv = geo.attributes.uv;
      const base = new Float32Array( uv.count * 2 );
      for ( let i = 0; i < uv.count; i++ ) { base[ i * 2 ] = uv.getX( i ); base[ i * 2 + 1 ] = uv.getY( i ); }
      const mesh = new THREE.Mesh( geo, mat );
      mesh.userData.baseUV = base;
      mesh.position.set( x, y, z );
      mesh.userData.restX = x;
      mesh.userData.restY = y;
      mesh.castShadow = false;
      mesh.renderOrder = 4;
      group.add( mesh );
      return mesh;
    };

    for ( const sx of [ -1, 1 ] ) {
      cards.eyes.push( mkCard( 0.082, 0.082, sx * 0.049, localY( 1.450 ), 0.101, 0.40 ) );
      cards.brows.push( mkCard( 0.066, 0.033, sx * 0.051, localY( 1.505 ), 0.104, 0.34 ) );
    }
    cards.mouth = mkCard( 0.050, 0.050, 0, localY( 1.396 ), 0.105, 0.30 );

    headBone.add( group );
    this.faceGroup = group;
    this.faceRig = new FaceRig( atlas, cards );
    this.faceRig.setExpression( { eye: 'open', brow: 'neutral', mouth: 'smile' } );
  }

  /** @param {THREE.Vector3|null} worldPoint */
  lookAt( worldPoint ) {
    this.faceRig?.lookAt( worldPoint, this.bones.head );
  }

  setExpression( spec ) {
    this.faceRig?.setExpression( spec );
  }

  update( dt, elapsed ) {
    this.faceRig?.update( dt );
    if ( this.halo ) {
      // A slow bob and counter-rotation. Static halos read as props.
      this.halo.position.y = HEAD.top - 1.392 + 0.115 + Math.sin( elapsed * 1.7 ) * 0.006;
      this.halo.rotation.y = elapsed * 0.35;
    }
    for ( const chain of this.springChains ) chain.update?.( dt );
  }

  setQuality( level ) {
    this.quality = level;
    for ( const m of this.meshes ) {
      const outline = m.userData.outline;
      if ( outline ) outline.visible = level >= 1;
      m.castShadow = level >= 1;
    }
  }

  onResize( w, h, pr ) {
    this.outlineMaterial.uniforms.uResolution.value.set( w * pr, h * pr );
  }

  dispose() {
    for ( const m of this.meshes ) {
      m.geometry.dispose();
      m.userData.outline?.geometry?.dispose?.();
    }
    this.bodyMaterial.dispose();
    this.headMaterial.dispose();
    this.hairMaterial.dispose();
    this.faceMaterial?.dispose();
    this.faceAtlas?.texture?.dispose();
    this.outlineMaterial.dispose();
  }
}

export function buildCharacter( presetOrDesign, opts ) {
  const design = typeof presetOrDesign === 'string'
    ? ( STUDENT_PRESETS[ presetOrDesign ] ?? ENEMY_PRESETS[ presetOrDesign ] )
    : presetOrDesign;
  if ( !design ) throw new Error( `Unknown character preset: ${presetOrDesign}` );
  return new Character( design, opts );
}
