import * as THREE from 'three';
import { createToonMaterial, createOutlineMaterial, computeSmoothNormals, paintGeometry } from '../render/ToonMaterial.js';
import { roundedBox, profileTube, mergeGeometries, xform } from './Geometry.js';
import { makeAsphalt, makePavementTiles, makeConcrete, makeBrick, makePaintedMetal, makeGrass } from './Textures.js';

/**
 * The arena: a walled city block in the Kivotos idiom — pale concrete
 * buildings with bright trim, a paved plaza, planters, barriers and shipping
 * containers laid out as cover.
 *
 * The layout is authored as data rather than random: a shooter's arena is a
 * readability problem first, so sightlines, flanking routes and the ratio of
 * open ground to hard cover are all deliberate. Cover pieces register
 * themselves with the physics world as they are built, so geometry and
 * collision can never drift apart.
 */

const V = ( x, y, z ) => new THREE.Vector3( x, y, z );

export const ARENA = {
  halfWidth: 26,
  halfDepth: 30,
  wallHeight: 9,
};

/** Colour set kept separate from the geometry so a whole map can be reskinned. */
export const LEVEL_COLORS = {
  ground: 0xc4ccd9,
  road: 0x8b93a3,
  kerb: 0xe6ebf2,
  grass: 0x86b877,
  buildingA: 0xeef1f7,
  buildingB: 0xdae2ee,
  buildingC: 0xf4e6d8,
  trim: 0x4a8fd0,
  trimWarm: 0xf0a03c,
  roof: 0x44507a,
  window: 0x8fd0f0,
  crate: 0xd2a463,
  container: 0x3f8fa8,
  containerAlt: 0xc25550,
  barrier: 0xe8e4dc,
  barrierStripe: 0xffc23d,
  planter: 0xb4a08c,
  foliage: 0x5f9c5a,
  foliageLight: 0x86c47a,
  metal: 0x6e7789,
  pole: 0x556070,
};

/* ---------------------------------------------------------------------- */
/* Prop builders                                                           */
/* ---------------------------------------------------------------------- */

function crate( size = 1.0 ) {
  const parts = [];
  parts.push( paintGeometry( roundedBox( size, size, size, size * 0.04, 2 ), LEVEL_COLORS.crate ) );
  // Corner banding, which is what makes a box read as a crate at a glance.
  const t = size * 0.095;
  for ( const sy of [ -1, 1 ] ) {
    parts.push( paintGeometry( xform( roundedBox( size * 1.04, t, size * 1.04, t * 0.3, 1 ),
      { position: [ 0, sy * ( size * 0.5 - t * 0.55 ), 0 ] } ), LEVEL_COLORS.metal ) );
  }
  // Vertical corner posts, so the crate has a frame instead of a stripe.
  for ( const sx of [ -1, 1 ] ) for ( const sz of [ -1, 1 ] ) {
    parts.push( paintGeometry( xform( roundedBox( t, size * 1.02, t, t * 0.3, 1 ),
      { position: [ sx * size * 0.5, 0, sz * size * 0.5 ] } ), LEVEL_COLORS.metal ) );
  }
  // A stencilled panel on two faces breaks up the flat orange.
  for ( const sz of [ -1, 1 ] ) {
    parts.push( paintGeometry( xform( roundedBox( size * 0.44, size * 0.30, 0.012, 0.01, 1 ),
      { position: [ 0, size * 0.05, sz * ( size * 0.5 + 0.006 ) ] } ), 0xf0dcc0 ) );
  }
  return mergeGeometries( parts );
}

function container( length = 6, height = 2.6, width = 2.4, color ) {
  const parts = [];
  parts.push( paintGeometry( roundedBox( width, height, length, 0.05, 2 ), color ) );

  // Corrugation: thin ribs down the long sides. Cheap, and it kills the
  // "untextured box" read instantly.
  const ribs = Math.floor( length / 0.42 );
  for ( let i = 0; i < ribs; i++ ) {
    const z = -length / 2 + 0.30 + i * ( ( length - 0.6 ) / ( ribs - 1 || 1 ) );
    parts.push( paintGeometry( xform( roundedBox( width + 0.05, height * 0.82, 0.07, 0.02, 1 ),
      { position: [ 0, 0, z ] } ), color ) );
  }
  // Frame rails top and bottom.
  for ( const sy of [ -1, 1 ] ) {
    parts.push( paintGeometry( xform( roundedBox( width + 0.09, 0.16, length + 0.09, 0.04, 1 ),
      { position: [ 0, sy * ( height / 2 - 0.08 ), 0 ] } ), LEVEL_COLORS.metal ) );
  }
  return mergeGeometries( parts );
}

function jerseyBarrier( length = 2.4 ) {
  const parts = [];

  // Built from three stacked slabs rather than a lathe: a 4-segment lathe
  // collapses into a flat sheet once the cross-section is this elongated,
  // and the stepped profile is what actually reads as a road barrier.
  const tiers = [
    { y: 0.09, w: 0.44, h: 0.18 },
    { y: 0.32, w: 0.34, h: 0.30 },
    { y: 0.62, w: 0.26, h: 0.30 },
    { y: 0.80, w: 0.30, h: 0.09 },
  ];
  for ( const t of tiers ) {
    const g = roundedBox( t.w, t.h, length, 0.025, 1 );
    g.translate( 0, t.y, 0 );
    parts.push( paintGeometry( g, LEVEL_COLORS.barrier ) );
  }

  // Hazard chevrons on the upper face.
  const bands = Math.max( 2, Math.round( length / 0.75 ) );
  for ( let i = 0; i < bands; i++ ) {
    const z = ( ( i + 0.5 ) / bands - 0.5 ) * ( length - 0.25 );
    const g = roundedBox( 0.28, 0.16, 0.20, 0.02, 1 );
    g.translate( 0, 0.66, z );
    parts.push( paintGeometry( g, LEVEL_COLORS.barrierStripe ) );
  }
  return mergeGeometries( parts );
}

function planter( w = 2.2, d = 1.2, h = 0.62 ) {
  const parts = [];
  parts.push( paintGeometry( roundedBox( w, h, d, 0.05, 2 ), LEVEL_COLORS.planter ) );
  parts.push( paintGeometry( xform( roundedBox( w + 0.09, 0.10, d + 0.09, 0.03, 1 ),
    { position: [ 0, h / 2, 0 ] } ), LEVEL_COLORS.kerb ) );

  // Foliage as clustered spheres — anime foliage is blobby, not leafy.
  let seed = 7;
  const rnd = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
  const blobs = Math.max( 3, Math.round( w * 2.5 ) );
  for ( let i = 0; i < blobs; i++ ) {
    const r = 0.28 + rnd() * 0.20;
    const g = new THREE.SphereGeometry( r, 10, 8 );
    g.scale( 1, 0.78, 1 );
    g.translate(
      ( rnd() - 0.5 ) * ( w - r * 1.6 ),
      h / 2 + r * 0.55,
      ( rnd() - 0.5 ) * ( d - r * 1.4 )
    );
    parts.push( paintGeometry( g, rnd() > 0.45 ? LEVEL_COLORS.foliage : LEVEL_COLORS.foliageLight ) );
  }
  return mergeGeometries( parts );
}

function lamppost( height = 5.2 ) {
  const parts = [];
  parts.push( paintGeometry( xform( profileTube( [
    { y: 0, rx: 0.14 }, { y: 0.22, rx: 0.11 }, { y: 0.3, rx: 0.065 }, { y: height, rx: 0.052 },
  ], { radial: 10, capTop: true, capBottom: false } ), {} ), LEVEL_COLORS.pole ) );

  const arm = roundedBox( 0.07, 0.07, 0.95, 0.02, 1 );
  arm.translate( 0, height - 0.1, 0.42 );
  parts.push( paintGeometry( arm, LEVEL_COLORS.pole ) );

  const head = roundedBox( 0.26, 0.13, 0.52, 0.05, 2 );
  head.translate( 0, height - 0.19, 0.82 );
  parts.push( paintGeometry( head, LEVEL_COLORS.metal ) );
  return mergeGeometries( parts );
}

/**
 * A modular building block. Only the outward faces matter — the arena is
 * viewed from inside — so these are simple masses with a strong trim band,
 * a parapet, and window grids that read as pattern rather than as glass.
 */
function building( w, h, d, { bodyColor, trimColor, floors = 3, windowColor } ) {
  const parts = [];
  parts.push( paintGeometry( roundedBox( w, h, d, 0.06, 2 ), bodyColor ) );

  // Ground-floor band and parapet.
  parts.push( paintGeometry( xform( roundedBox( w + 0.10, 0.55, d + 0.10, 0.04, 1 ),
    { position: [ 0, -h / 2 + 0.30, 0 ] } ), trimColor ) );
  parts.push( paintGeometry( xform( roundedBox( w + 0.24, 0.42, d + 0.24, 0.05, 1 ),
    { position: [ 0, h / 2 - 0.05, 0 ] } ), LEVEL_COLORS.roof ) );
  parts.push( paintGeometry( xform( roundedBox( w + 0.06, 0.16, d + 0.06, 0.03, 1 ),
    { position: [ 0, h / 2 - 0.34, 0 ] } ), trimColor ) );

  // Window grid on all four faces.
  const floorH = ( h - 1.6 ) / floors;
  const cols = Math.max( 2, Math.floor( w / 1.5 ) );
  const colsD = Math.max( 2, Math.floor( d / 1.5 ) );

  for ( let f = 0; f < floors; f++ ) {
    const y = -h / 2 + 1.15 + f * floorH + floorH * 0.5;
    for ( let c = 0; c < cols; c++ ) {
      const x = ( ( c + 0.5 ) / cols - 0.5 ) * ( w - 0.7 );
      for ( const sz of [ -1, 1 ] ) {
        const win = roundedBox( Math.min( 0.95, w / cols - 0.35 ), floorH * 0.52, 0.10, 0.03, 1 );
        win.translate( x, y, sz * ( d / 2 + 0.01 ) );
        parts.push( paintGeometry( win, windowColor ) );
      }
    }
    for ( let c = 0; c < colsD; c++ ) {
      const z = ( ( c + 0.5 ) / colsD - 0.5 ) * ( d - 0.7 );
      for ( const sx of [ -1, 1 ] ) {
        const win = roundedBox( 0.10, floorH * 0.52, Math.min( 0.95, d / colsD - 0.35 ), 0.03, 1 );
        win.translate( sx * ( w / 2 + 0.01 ), y, z );
        parts.push( paintGeometry( win, windowColor ) );
      }
    }
  }
  return mergeGeometries( parts );
}

/* ---------------------------------------------------------------------- */
/* Layout                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Cover layout.
 *
 * Read as a map: the squad deploys at +Z, hostiles push from -Z. The centre
 * line is deliberately open so both sides have a contested lane, with heavy
 * cover on the flanks to reward movement over camping.
 */
const COVER_LAYOUT = [
  // --- centre lane, low cover, contested ---
  { kind: 'barrier', x: -3.5, z: 2, ry: 0, len: 2.8 },
  { kind: 'barrier', x: 3.5, z: 2, ry: 0, len: 2.8 },
  { kind: 'crate', x: 0, z: -1, size: 1.2 },
  { kind: 'crate', x: 0.9, z: -1.9, size: 0.9 },
  { kind: 'crate', x: -0.8, z: -2.0, size: 1.0 },

  // --- left flank ---
  { kind: 'container', x: -11, z: -3, ry: 0.12, len: 6.5, color: LEVEL_COLORS.container },
  { kind: 'container', x: -13.5, z: 5, ry: Math.PI / 2 - 0.1, len: 5.5, color: LEVEL_COLORS.containerAlt },
  { kind: 'planter', x: -7.5, z: 8, ry: 0, w: 3.0 },
  { kind: 'crate', x: -8.6, z: -8, size: 1.3 },
  { kind: 'crate', x: -7.4, z: -8.6, size: 1.0 },
  { kind: 'barrier', x: -16, z: -9, ry: 0.3, len: 3.2 },

  // --- right flank ---
  { kind: 'container', x: 11.5, z: -4, ry: -0.08, len: 6.5, color: LEVEL_COLORS.containerAlt },
  { kind: 'container', x: 14, z: 6, ry: Math.PI / 2 + 0.12, len: 5.5, color: LEVEL_COLORS.container },
  { kind: 'planter', x: 7.5, z: 8.5, ry: 0, w: 3.0 },
  { kind: 'crate', x: 8.4, z: -7.5, size: 1.3 },
  { kind: 'crate', x: 9.6, z: -8.4, size: 1.0 },
  { kind: 'barrier', x: 16, z: -9, ry: -0.3, len: 3.2 },

  // --- mid band, the contested ground ---
  { kind: 'container', x: -4.6, z: -8.5, ry: Math.PI / 2 - 0.22, len: 5.0, color: LEVEL_COLORS.container },
  { kind: 'container', x: 5.0, z: -9.5, ry: Math.PI / 2 + 0.18, len: 5.0, color: LEVEL_COLORS.containerAlt },
  { kind: 'crate', x: -2.4, z: -5.4, size: 1.2 },
  { kind: 'crate', x: -3.3, z: -6.2, size: 0.95 },
  { kind: 'crate', x: 2.6, z: -5.8, size: 1.25 },
  { kind: 'barrier', x: -1.2, z: 5.5, ry: 0.5, len: 2.6 },
  { kind: 'barrier', x: 1.4, z: 5.8, ry: -0.5, len: 2.6 },
  { kind: 'planter', x: -4.8, z: 1.5, ry: Math.PI / 2, w: 2.4, d: 1.1 },
  { kind: 'planter', x: 4.8, z: 1.5, ry: Math.PI / 2, w: 2.4, d: 1.1 },

  // --- hostile side, staging cover ---
  { kind: 'barrier', x: -5, z: -14, ry: 0.1, len: 3.0 },
  { kind: 'barrier', x: 5, z: -14, ry: -0.1, len: 3.0 },
  { kind: 'crate', x: 0, z: -16, size: 1.4 },
  { kind: 'planter', x: -12, z: -16, ry: 0, w: 2.6 },
  { kind: 'planter', x: 12, z: -16, ry: 0, w: 2.6 },

  // --- deploy side ---
  { kind: 'planter', x: 0, z: 21, ry: 0, w: 4.0 },
  { kind: 'barrier', x: -9, z: 13, ry: 0, len: 3.0 },
  { kind: 'barrier', x: 9, z: 13, ry: 0, len: 3.0 },
];

const BUILDING_LAYOUT = [
  { x: -33, z: -14, w: 14, h: 16, d: 18, floors: 4, body: 'buildingA' },
  { x: -33, z: 10, w: 14, h: 12, d: 20, floors: 3, body: 'buildingB' },
  { x: 33, z: -12, w: 14, h: 14, d: 20, floors: 4, body: 'buildingC' },
  { x: 33, z: 12, w: 14, h: 18, d: 16, floors: 5, body: 'buildingA' },
  { x: -14, z: -40, w: 20, h: 15, d: 14, floors: 4, body: 'buildingB' },
  { x: 14, z: -40, w: 20, h: 13, d: 14, floors: 3, body: 'buildingC' },
  { x: -12, z: 40, w: 18, h: 12, d: 14, floors: 3, body: 'buildingC' },
  { x: 12, z: 40, w: 18, h: 16, d: 14, floors: 4, body: 'buildingA' },
];

/* ---------------------------------------------------------------------- */
/* Level                                                                   */
/* ---------------------------------------------------------------------- */

export class Level {
  /**
   * @param {import('../physics/World.js').PhysicsWorld} physics
   * @param {object} [opts]
   */
  constructor( physics, opts = {} ) {
    this.physics = physics;
    this.group = new THREE.Group();
    this.group.name = 'level';
    this.coverPoints = [];
    this.spawns = { squad: [], hostile: [] };
    this._materials = [];
    this._geometries = [];

    this.outlineMaterial = createOutlineMaterial( {
      color: 0x39405c, thickness: 0.0024, vertexTint: true, tintMix: 0.55,
    } );

    this._buildGround( opts.quality ?? 2 );
    this._buildProps();
    this._buildBuildings();
    this._buildBoundary();
    this._buildSpawns();
  }

  _toonProps( extra = {} ) {
    return {
      color: 0xffffff,
      vertexTint: true,
      // Architecture wants a wider, softer terminator than a character does,
      // or every façade turns into a hard two-tone poster.
      shadowStep: 0.46,
      shadowSoft: 0.075,
      midSoft: 0.10,
      shadowTint: 0xa9a2c6,
      midTint: 0xd4cfe6,
      ambient: 0.46,
      specStrength: 0.06,
      rimStrength: 0.22,
      rimColor: 0xcfe9ff,
      ...extra,
    };
  }

  _add( geometry, material, { cast = true, receive = true, outline = true } = {} ) {
    const geo = computeSmoothNormals( geometry );
    const mesh = new THREE.Mesh( geo, material );
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    this.group.add( mesh );
    this._geometries.push( geo );

    if ( outline ) {
      const o = new THREE.Mesh( geo, this.outlineMaterial );
      o.castShadow = false;
      o.receiveShadow = false;
      this.group.add( o );
      mesh.userData.outline = o;
    }
    return mesh;
  }

  _buildGround( quality ) {
    const texSize = quality >= 2 ? 1024 : 512;

    const plaza = makePavementTiles( { size: texSize, tilesX: 6, tilesY: 6 } );
    // Concrete, not asphalt. A real road surface is far darker than a pale
    // plaza, and at this camera height the value gap read as a pit cut through
    // the middle of the arena rather than as a street.
    const paving = makeConcrete( { size: texSize } );

    const groundMat = createToonMaterial( this._toonProps( {
      map: plaza.map,
      normalMap: plaza.normalMap,
      normalScale: 0.7,
      uvScale: [ 14, 16 ],
      color: 0xffffff,
      vertexTint: false,
      specStrength: 0.03,
      rimStrength: 0,
    } ) );
    this._materials.push( groundMat );

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry( ARENA.halfWidth * 2 + 60, ARENA.halfDepth * 2 + 60 ),
      groundMat
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.group.add( ground );
    this.physics.addPlane( 0 );

    // A road strip crossing the arena, which breaks up the plaza and gives
    // the eye a line to follow.
    const roadMat = createToonMaterial( this._toonProps( {
      map: paving.map,
      normalMap: paving.normalMap,
      normalScale: 0.5,
      color: 0xd8dde6,
      uvScale: [ 2.6, 16 ],
      vertexTint: false,
      specStrength: 0.02,
      rimStrength: 0,
    } ) );
    this._materials.push( roadMat );

    const road = new THREE.Mesh( new THREE.PlaneGeometry( 7.6, ARENA.halfDepth * 2 + 40 ), roadMat );
    road.rotation.x = -Math.PI / 2;
    road.position.set( 0, 0.012, 0 );
    road.receiveShadow = true;
    this.group.add( road );

    // Lane markings.
    const markParts = [];
    for ( let i = -14; i <= 14; i++ ) {
      const dash = roundedBox( 0.16, 0.012, 1.5, 0.004, 1 );
      dash.translate( 0, 0.020, i * 3.4 );
      markParts.push( paintGeometry( dash, 0xf6f2e4 ) );
    }
    for ( const sx of [ -1, 1 ] ) {
      const edge = roundedBox( 0.13, 0.012, ARENA.halfDepth * 2 + 36, 0.004, 1 );
      edge.translate( sx * 3.4, 0.020, 0 );
      markParts.push( paintGeometry( edge, 0xf6f2e4 ) );
    }
    const markMat = createToonMaterial( this._toonProps( { specStrength: 0, rimStrength: 0 } ) );
    this._materials.push( markMat );
    this._add( mergeGeometries( markParts ), markMat, { cast: false, outline: false } );

    // Kerbs.
    const kerbParts = [];
    for ( const sx of [ -1, 1 ] ) {
      const k = roundedBox( 0.42, 0.16, ARENA.halfDepth * 2 + 40, 0.03, 1 );
      k.translate( sx * 3.9, 0.08, 0 );
      kerbParts.push( paintGeometry( k, LEVEL_COLORS.kerb ) );
    }
    const kerbMat = createToonMaterial( this._toonProps() );
    this._materials.push( kerbMat );
    this._add( mergeGeometries( kerbParts ), kerbMat, { cast: false } );
  }

  _buildProps() {
    const parts = [];

    for ( const c of COVER_LAYOUT ) {
      let geo, half, tag = 'cover';

      switch ( c.kind ) {
        case 'crate': {
          const s = c.size ?? 1;
          geo = crate( s );
          half = V( s / 2, s / 2, s / 2 );
          geo.translate( c.x, s / 2, c.z );
          break;
        }
        case 'container': {
          const len = c.len ?? 6;
          geo = container( len, 2.6, 2.4, c.color ?? LEVEL_COLORS.container );
          geo.rotateY( c.ry ?? 0 );
          geo.translate( c.x, 1.3, c.z );
          // Axis-aligned bound, expanded to cover the rotation. Exact OBB
          // collision would be more correct, but a slightly generous box is
          // the right trade: it never lets a unit clip into the mesh.
          const ry = Math.abs( c.ry ?? 0 );
          const hw = ( 2.4 / 2 ) * Math.abs( Math.cos( ry ) ) + ( len / 2 ) * Math.abs( Math.sin( ry ) );
          const hd = ( 2.4 / 2 ) * Math.abs( Math.sin( ry ) ) + ( len / 2 ) * Math.abs( Math.cos( ry ) );
          half = V( hw, 1.3, hd );
          break;
        }
        case 'barrier': {
          const len = c.len ?? 2.4;
          geo = jerseyBarrier( len );
          geo.rotateY( c.ry ?? 0 );
          geo.translate( c.x, 0, c.z );
          const ry = Math.abs( c.ry ?? 0 );
          const bw = 0.24;   // half-width of the widest tier
          half = V( bw * Math.abs( Math.cos( ry ) ) + ( len / 2 ) * Math.abs( Math.sin( ry ) ), 0.45,
                    bw * Math.abs( Math.sin( ry ) ) + ( len / 2 ) * Math.abs( Math.cos( ry ) ) );
          break;
        }
        case 'planter': {
          const w = c.w ?? 2.2, d = c.d ?? 1.2, h = 0.62;
          geo = planter( w, d, h );
          geo.rotateY( c.ry ?? 0 );
          geo.translate( c.x, h / 2, c.z );
          const ry = Math.abs( c.ry ?? 0 );
          half = V(
            ( w / 2 ) * Math.abs( Math.cos( ry ) ) + ( d / 2 ) * Math.abs( Math.sin( ry ) ),
            h / 2,
            ( w / 2 ) * Math.abs( Math.sin( ry ) ) + ( d / 2 ) * Math.abs( Math.cos( ry ) )
          );
          break;
        }
        default:
          continue;
      }

      parts.push( geo );

      const centerY = c.kind === 'barrier' ? 0.45 : ( c.kind === 'crate' ? ( c.size ?? 1 ) / 2 : ( c.kind === 'container' ? 1.3 : 0.31 ) );
      this.physics.addBox( V( c.x, centerY, c.z ), half, { tag } );

      // Cover points: four standing spots, one per face, offset clear of the
      // collider so a unit can actually stand there.
      const height = half.y * 2;
      for ( const [ dx, dz ] of [ [ 1, 0 ], [ -1, 0 ], [ 0, 1 ], [ 0, -1 ] ] ) {
        this.coverPoints.push( {
          position: V( c.x + dx * ( half.x + 0.55 ), 0, c.z + dz * ( half.z + 0.55 ) ),
          normal: V( dx, 0, dz ),
          height,
          // Chest-high cover you can shoot over is worth more than a wall
          // you have to lean around.
          quality: height > 1.6 ? 1.0 : ( height > 0.85 ? 0.85 : 0.6 ),
          occupied: null,
        } );
      }
    }

    // Lampposts along the road.
    for ( let i = -3; i <= 3; i++ ) {
      if ( i === 0 ) continue;
      for ( const sx of [ -1, 1 ] ) {
        const g = lamppost( 5.2 );
        if ( sx < 0 ) g.rotateY( Math.PI );
        g.translate( sx * 4.8, 0, i * 8.5 );
        parts.push( g );
        this.physics.addCylinder( V( sx * 4.8, 2.6, i * 8.5 ), 0.14, 5.2, { tag: 'prop' } );
      }
    }

    const mat = createToonMaterial( this._toonProps() );
    this._materials.push( mat );
    this._add( mergeGeometries( parts ), mat );
  }

  _buildBuildings() {
    const parts = [];
    for ( const b of BUILDING_LAYOUT ) {
      const geo = building( b.w, b.h, b.d, {
        bodyColor: LEVEL_COLORS[ b.body ],
        trimColor: b.body === 'buildingC' ? LEVEL_COLORS.trimWarm : LEVEL_COLORS.trim,
        windowColor: LEVEL_COLORS.window,
        floors: b.floors,
      } );
      geo.translate( b.x, b.h / 2, b.z );
      parts.push( geo );
      this.physics.addBox( V( b.x, b.h / 2, b.z ), V( b.w / 2, b.h / 2, b.d / 2 ), { tag: 'world' } );
    }

    const mat = createToonMaterial( this._toonProps( { rimStrength: 0.18 } ) );
    this._materials.push( mat );
    this._add( mergeGeometries( parts ), mat, { receive: true } );
  }

  /** An invisible wall ring, so units can never leave the playable area. */
  _buildBoundary() {
    const { halfWidth: w, halfDepth: d, wallHeight: h } = ARENA;
    const t = 1.5;
    this.physics.addBox( V( 0, h / 2, -d - t ), V( w + t * 2, h / 2, t ), { tag: 'world' } );
    this.physics.addBox( V( 0, h / 2, d + t ), V( w + t * 2, h / 2, t ), { tag: 'world' } );
    this.physics.addBox( V( -w - t, h / 2, 0 ), V( t, h / 2, d + t * 2 ), { tag: 'world' } );
    this.physics.addBox( V( w + t, h / 2, 0 ), V( t, h / 2, d + t * 2 ), { tag: 'world' } );

    // A low perimeter wall, so the boundary is visible rather than an
    // invisible shove.
    const parts = [];
    for ( const [ x, z, sw, sd ] of [
      [ 0, -d, w, 0.35 ], [ 0, d, w, 0.35 ],
      [ -w, 0, 0.35, d ], [ w, 0, 0.35, d ],
    ] ) {
      const g = roundedBox( sw * 2, 1.05, sd * 2, 0.05, 1 );
      g.translate( x, 0.52, z );
      parts.push( paintGeometry( g, LEVEL_COLORS.barrier ) );
      const cap = roundedBox( sw * 2 + 0.14, 0.14, sd * 2 + 0.14, 0.03, 1 );
      cap.translate( x, 1.06, z );
      parts.push( paintGeometry( cap, LEVEL_COLORS.trim ) );
    }
    const mat = createToonMaterial( this._toonProps() );
    this._materials.push( mat );
    this._add( mergeGeometries( parts ), mat );
  }

  _buildSpawns() {
    for ( let i = 0; i < 4; i++ ) {
      this.spawns.squad.push( V( ( i - 1.5 ) * 2.0, 0, 14 ) );
    }
    const hostile = [
      [ 0, -19 ], [ -6, -20 ], [ 6, -20 ], [ -12, -17 ], [ 12, -17 ],
      [ -17, -14 ], [ 17, -14 ], [ -3, -21 ], [ 3, -21 ],
    ];
    for ( const [ x, z ] of hostile ) this.spawns.hostile.push( V( x, 0, z ) );
  }

  /**
   * Finds the best unoccupied cover point for a unit facing a threat.
   * Scores by cover quality, proximity, and whether the cover actually sits
   * between the unit and the threat.
   */
  findCover( from, threat, maxDistance = 14 ) {
    let best = null, bestScore = -Infinity;
    const toThreat = new THREE.Vector3().subVectors( threat, from ).setY( 0 ).normalize();

    for ( const cp of this.coverPoints ) {
      if ( cp.occupied ) continue;
      const dist = cp.position.distanceTo( from );
      if ( dist > maxDistance ) continue;

      // The cover's face must point away from the threat to protect anything.
      const facing = -cp.normal.dot( toThreat );
      if ( facing < 0.15 ) continue;

      const score = cp.quality * 2.2 + facing * 1.6 - dist * 0.12;
      if ( score > bestScore ) { bestScore = score; best = cp; }
    }
    return best;
  }

  releaseCover( point ) {
    if ( point ) point.occupied = null;
  }

  setQuality( level ) {
    for ( const child of this.group.children ) {
      if ( child.userData.outline ) child.userData.outline.visible = level >= 1;
      child.castShadow = level >= 1 && child.castShadow;
    }
  }

  onResize( w, h, pr ) {
    this.outlineMaterial.uniforms.uResolution.value.set( w * pr, h * pr );
  }

  dispose() {
    for ( const g of this._geometries ) g.dispose();
    for ( const m of this._materials ) m.dispose();
    this.outlineMaterial.dispose();
  }
}
