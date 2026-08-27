import * as THREE from 'three';
import { createToonMaterial, createOutlineMaterial, computeSmoothNormals, paintGeometry } from '../render/ToonMaterial.js';
import { buildSkeleton, skinGeometry, skinRigid, SKIN_SEGMENTS } from './Rig.js';
import { buildHair, HEAD } from './Hair.js';
import { buildWeapon } from './Weapon.js';
import { SpringBoneChain, makeBodyColliders, updateBodyColliders } from '../physics/SpringBone.js';
import { Animator } from '../anim/Animator.js';
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
    brow: 0x5d7bab,
    outfit: { shirt: 0xf7f9fd, skirt: 0x59659e, jacket: 0x5c6ba3, ribbon: 0xff5d6c, socks: 0x525d8e, shoes: 0x3d4670, trim: 0x35a3ea, sockBand: 0x46507a, sole: 0xe8edf5, belt: 0x2b3350 },
    halo: { type: 'ring', color: 0x8fd8ff },
    weapon: 'rifle',
  },
  aoi: {
    name: 'AOI', callsign: 'Abydos 02',
    skin: 0xffe6d4,
    hair: { color: 0xf2d478, accent: 0xfff0b8, style: 'twintail' },
    eyes: { color: 0x36b37e, shape: 'round', lash: 0x453a2c },
    brow: 0x9a7c3e,
    outfit: { shirt: 0xf7f9fd, skirt: 0x616ead, jacket: 0x6c7ab4, ribbon: 0x36b37e, socks: 0xf2f5fa, shoes: 0x363d59, trim: 0xffd54a, sockBand: 0xdfe6f2, sole: 0xf0f3f8, belt: 0x2f3757 },
    halo: { type: 'wing', color: 0xffe89a },
    weapon: 'smg',
  },
  rei: {
    name: 'REI', callsign: 'Gehenna 07',
    skin: 0xffdcc6,
    hair: { color: 0x8e4a68, accent: 0xd07fa0, style: 'long' },
    eyes: { color: 0xd8465e, shape: 'sharp', lash: 0x3a2030 },
    brow: 0x4a2839,
    outfit: { shirt: 0xf4f0f6, skirt: 0x74506c, jacket: 0x835779, ribbon: 0xffd54a, socks: 0x54394f, shoes: 0x2e2030, trim: 0xd8465e, sockBand: 0x40283c, sole: 0xe9e2ea, belt: 0x3a2436 },
    halo: { type: 'cross', color: 0xff9ab5 },
    weapon: 'shotgun',
  },
  yuki: {
    name: 'YUKI', callsign: 'Trinity 12',
    skin: 0xfff0e2,
    hair: { color: 0xe8eaf2, accent: 0xffffff, style: 'bob' },
    eyes: { color: 0x7b6ee0, shape: 'cool', lash: 0x3a3552 },
    brow: 0x8f93a8,
    outfit: { shirt: 0xffffff, skirt: 0x5d6da8, jacket: 0x6779bd, ribbon: 0x7b6ee0, socks: 0xf2f5fa, shoes: 0x353d63, trim: 0x9fe8ff, sockBand: 0xdde7f5, sole: 0xf2f5fa, belt: 0x2c3558 },
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

    // Hand: a closed-fist mass, not a paddle. Articulated fingers would be
    // invisible at this camera distance, but proportion is not — a hand that
    // is three times longer than it is thick reads as a claw no matter how
    // small it gets on screen. The knuckle ridge and the thumb wrap are what
    // make it read as a gripping fist.
    const handDir = wrist.clone().sub( elbow ).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors( V( 0, -1, 0 ), handDir );
    const placeOnHand = ( geo, along, side, fwd ) => {
      geo.applyMatrix4( new THREE.Matrix4().makeRotationFromQuaternion( q ) );
      geo.translate(
        wrist.x + handDir.x * along - sx * side,
        wrist.y + handDir.y * along,
        wrist.z + handDir.z * along + fwd
      );
      return paintGeometry( geo, skin );
    };

    parts.push( placeOnHand( roundedBox( 0.050, 0.062, 0.046, 0.020, 3 ), 0.048, 0, 0.002 ) );
    // Knuckle ridge across the front of the fist.
    parts.push( placeOnHand( roundedBox( 0.050, 0.024, 0.022, 0.010, 2 ), 0.070, 0, 0.014 ) );
    // Thumb wrapped across, rather than sticking out as a separate stub.
    const thumb = roundedBox( 0.022, 0.044, 0.024, 0.010, 2 );
    thumb.rotateX( 0.5 );
    parts.push( placeOnHand( thumb, 0.048, 0.024, 0.020 ) );
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
  // Built from tapered wings rather than rotated boxes: a box rotated about
  // two axes reads as an arrowhead, not as a loop of fabric.
  for ( const sx of [ -1, 1 ] ) {
    const wing = profileTube( [
      { y: 0.000, rx: 0.006, rz: 0.009 },
      { y: 0.020, rx: 0.020, rz: 0.013 },
      { y: 0.046, rx: 0.026, rz: 0.015 },
      { y: 0.062, rx: 0.014, rz: 0.010 },
    ], { radial: 10, capTop: true, capBottom: true, capRound: 0.4 } );
    wing.rotateZ( sx * Math.PI / 2 );
    wing.rotateY( sx * -0.30 );
    wing.translate( sx * 0.012, 1.258, 0.079 );
    parts.push( paintGeometry( wing, o.ribbon ) );

    // Trailing tail, cut to a point.
    const tailPiece = profileTube( [
      { y: 0.000, rx: 0.013, rz: 0.006 },
      { y: 0.034, rx: 0.014, rz: 0.006 },
      { y: 0.062, rx: 0.010, rz: 0.005 },
    ], { radial: 8, capTop: true, capBottom: false } );
    tailPiece.rotateX( Math.PI );
    tailPiece.rotateZ( sx * 0.22 );
    tailPiece.translate( sx * 0.014, 1.252, 0.076 );
    parts.push( paintGeometry( tailPiece, o.ribbon ) );
  }

  const knot = profileTube( [
    { y: 0.000, rx: 0.012, rz: 0.010 },
    { y: 0.010, rx: 0.015, rz: 0.013 },
    { y: 0.022, rx: 0.012, rz: 0.010 },
  ], { radial: 10, capTop: true, capBottom: true, capRound: 0.6 } );
  knot.translate( 0, 1.250, 0.083 );
  parts.push( paintGeometry( knot, o.ribbon ) );

  // --- sleeves ---------------------------------------------------------
  // Returned separately so they can be skinned against the arm chain alone.
  // Solved against the full body they pick up chest and clavicle influence
  // and get stretched into a flat slab the moment the arm swings forward.
  const sleeves = { '-1': [], '1': [] };
  for ( const sx of [ -1, 1 ] ) {
    const shoulder = V( sx * 0.128, 1.288, 0 );
    const cuff = V( sx * 0.224, 1.112, 0 );
    const sleeve = limb( shoulder, cuff, [
      { t: 0, r: 0.064 }, { t: 0.24, r: 0.062 }, { t: 0.64, r: 0.053 }, { t: 1, r: 0.047 },
    ], { radial: 16, capTop: false, capBottom: true, capRound: 0.42 } );
    sleeves[ sx ].push( paintGeometry( sleeve, o.jacket ?? o.shirt ) );

    const trim = limb( cuff, V( sx * 0.234, 1.098, 0 ), [ { t: 0, r: 0.049 }, { t: 1, r: 0.047 } ], { radial: 16, capTop: false, capBottom: false } );
    sleeves[ sx ].push( paintGeometry( trim, o.cuff ?? o.shirt ) );
  }

  // --- lower body ------------------------------------------------------
  if ( o.skirt ) {
    parts.push( paintGeometry( pleatedSkirt( {
      waistY: 0.930, hemY: 0.655,
      waistRX: 0.152, waistRZ: 0.112,
      hemRX: 0.224, hemRZ: 0.178,
      pleats: 22, depth: 0.115,
    } ), o.skirt ) );

    // Waistband.
    parts.push( paintGeometry( profileTube( [
      { y: 0.922, rx: 0.152, rz: 0.112 }, { y: 0.956, rx: 0.150, rz: 0.110 },
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

  return {
    core: mergeGeometries( parts ),
    sleeveL: mergeGeometries( sleeves[ '-1' ] ),
    sleeveR: mergeGeometries( sleeves[ '1' ] ),
  };
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
      thickness: 0.0055,
      vertexTint: true,
      tintMix: 0.45,
    } );
    this.outlineMaterial = outlineMat;

    // --- body + outfit ---------------------------------------------------
    const outfit = buildOutfit( design );
    const bodyGeo = computeSmoothNormals( mergeGeometries( [ buildBody( design ), outfit.core ] ) );
    skinGeometry( bodyGeo, order, { segments: allSegments, falloff: 2.6 } );

    // Sleeves ride the arm chain only, weighted hard toward the upper arm.
    for ( const side of [ 'L', 'R' ] ) {
      const geo = computeSmoothNormals( outfit[ `sleeve${side}` ] );
      skinGeometry( geo, order, {
        segments: allSegments,
        only: [ `shoulder${side}`, `upperArm${side}`, `lowerArm${side}` ],
        bias: { [ `upperArm${side}` ]: 3.2, [ `shoulder${side}` ]: 0.5, [ `lowerArm${side}` ]: 0.7 },
        falloff: 2.2,
      } );
      outfit[ `sleeve${side}Skinned` ] = geo;
    }
    // Characters take no cast shadow at all. `mesh.receiveShadow = false` is
    // not enough: three r185 defines USE_SHADOWMAP purely from the renderer's
    // shadowMap.enabled, with no per-object gate, so a custom ShaderMaterial
    // samples the map regardless — which is why every character was
    // self-shadowing into mottled acne and why the fringe read two values
    // darker than the crown it grows out of. Form comes from the cel ramp
    // here, the way it does in the source material; the shadow map's job is
    // to put characters on the ground, not to shade them.
    const bodyMat = createToonMaterial( {
      color: 0xffffff,
      vertexTint: true,
      shadowStrength: 0,
      specStrength: 0.10,
      specGloss: 22,
      rimStrength: 0.45,
      rimColor: design.rimColor ?? PALETTE.accentCyan,
    } );
    this.bodyMaterial = bodyMat;
    this._addSkinned(
      'body',
      mergeGeometries( [ bodyGeo, outfit.sleeveLSkinned, outfit.sleeveRSkinned ] ),
      bodyMat, outlineMat, skeleton
    );

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
      shadowStrength: 0,
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
      shadowStrength: 0,
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

    // --- weapon -----------------------------------------------------------
    // The socket is parented to the character root rather than to a hand bone:
    // the animator drives the weapon's transform from the aim direction and
    // then IKs both hands onto it, which is the only way to keep a two-handed
    // grip stable across different weapons and target elevations.
    this.weaponSocket = new THREE.Object3D();
    this.weaponSocket.name = 'weaponSocket';
    root.add( this.weaponSocket );

    if ( design.weapon ) {
      this.weapon = buildWeapon( design.weapon, { rimColor: design.rimColor } );
      this.weaponSocket.add( this.weapon.group );
      this.stats = this.weapon.stats;
    }

    // --- secondary motion ---------------------------------------------------
    this.bodyColliders = makeBodyColliders( byName );
    this.springChains = hair.chains.map( ( names ) => {
      const chainBones = names.map( ( n ) => byName[ n ] ).filter( Boolean );
      return new SpringBoneChain( chainBones, {
        stiffness: 0.13,
        damping: 0.12,
        gravity: 0.75,
        drag: 0.03,
        maxAngle: 1.15,
        radius: 0.045,
        colliders: this.bodyColliders,
      } );
    } );

    this.animator = new Animator( this );

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

  /**
   * The head's front surface at a given height, mirroring the maths in
   * {@link shapeHead}.
   *
   * Face cards were previously placed at one fixed Z for every feature, which
   * works at eye level and fails badly at the mouth: the jaw tapers to 60% of
   * its width by the chin, so a card at eye-level Z ends up floating three
   * centimetres in front of the face and reads as sitting on the neck.
   */
  static headSurfaceZ( worldY, radius = 0.118, jawNarrow = 0.60, chin = 0.24 ) {
    const t = THREE.MathUtils.clamp( ( worldY - HEAD.centerY ) / radius, -0.999, 0.999 );
    const ring = radius * Math.sqrt( Math.max( 0, 1 - t * t ) );
    if ( t >= 0 ) return ring;
    const k = 1 - ( 1 - jawNarrow ) * Math.pow( -t, 1.5 );
    return ring * k + chin * radius * Math.pow( -t, 2.4 );
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

    // The head spans y 1.366 (chin) to 1.602 (crown). Anime proportion puts
    // the eyeline a little above the halfway point of that span, not two
    // thirds of the way down it, and keeps the brow-to-eye gap tight.
    // Stacked to clear each other: the fringe now terminates around 1.528, so
    // the brow sits just under it and the eye card's top edge stays clear of
    // both. Bangs cutting a hard opaque edge across an iris is the fastest way
    // to make a stylised face look broken.
    const EYE_Y = 1.470;
    const BROW_Y = 1.514;
    const MOUTH_Y = 1.416;

    // Each card sits a hair proud of the head's own surface at its height.
    const zAt = ( y, lift ) => Character.headSurfaceZ( y ) - lift;

    for ( const sx of [ -1, 1 ] ) {
      cards.eyes.push( mkCard( 0.078, 0.078, sx * 0.047, localY( EYE_Y ), zAt( EYE_Y, 0.012 ), 0.40 ) );
      cards.brows.push( mkCard( 0.062, 0.031, sx * 0.050, localY( BROW_Y ), zAt( BROW_Y, 0.010 ), 0.34 ) );
    }
    cards.mouth = mkCard( 0.046, 0.046, 0, localY( MOUTH_Y ), zAt( MOUTH_Y, 0.008 ), 0.30 );

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

    // Order matters: pose the skeleton, refresh the collider positions from
    // the posed bones, then run the springs against them. Simulating hair
    // against last frame's collider positions makes it lag through the head
    // on fast turns.
    this.animator?.update( dt, elapsed );
    updateBodyColliders( this.bodyColliders );
    for ( const chain of this.springChains ) chain.update( dt );

    if ( this.halo ) {
      // A slow bob and counter-rotation. Static halos read as props.
      this.halo.position.y = HEAD.top - 1.392 + 0.115 + Math.sin( elapsed * 1.7 ) * 0.006;
      this.halo.rotation.y = elapsed * 0.35;
    }
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
    this.weapon?.onResize( w, h, pr );
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
    this.weapon?.dispose();
  }
}

export function buildCharacter( presetOrDesign, opts ) {
  const design = typeof presetOrDesign === 'string'
    ? ( STUDENT_PRESETS[ presetOrDesign ] ?? ENEMY_PRESETS[ presetOrDesign ] )
    : presetOrDesign;
  if ( !design ) throw new Error( `Unknown character preset: ${presetOrDesign}` );
  return new Character( design, opts );
}
