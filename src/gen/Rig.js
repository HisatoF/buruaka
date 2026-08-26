import * as THREE from 'three';

/**
 * Skeleton definition and automatic skin-weight solving.
 *
 * Characters are modelled in bind pose as plain geometry and then bound to a
 * skeleton afterwards, rather than authored per-bone. That keeps the modelling
 * code readable (a leg is a leg, not "the thing parented to shinL") and means
 * a new outfit piece is skinned correctly the moment it is added, with no
 * hand-painted weights.
 */

/**
 * Bind-pose skeleton for a ~1.62 m stylised anime figure, roughly 6.5 heads
 * tall. Arms rest in a relaxed A-pose: a T-pose leaves the deltoid impossible
 * to weight cleanly, and arms straight down collapse the armpit.
 *
 * Positions are absolute (world) in bind pose; the hierarchy is rebuilt into
 * local space by {@link buildSkeleton}.
 */
export const BIND_POSE = {
  root:      { pos: [ 0, 0, 0 ], parent: null },
  hips:      { pos: [ 0, 0.885, 0 ], parent: 'root' },
  spine:     { pos: [ 0, 1.010, 0 ], parent: 'hips' },
  chest:     { pos: [ 0, 1.150, 0 ], parent: 'spine' },
  neck:      { pos: [ 0, 1.318, 0 ], parent: 'chest' },
  head:      { pos: [ 0, 1.392, 0 ], parent: 'neck' },
  headTop:   { pos: [ 0, 1.560, 0 ], parent: 'head' },

  shoulderL: { pos: [ -0.052, 1.268, 0 ], parent: 'chest' },
  upperArmL: { pos: [ -0.160, 1.255, 0 ], parent: 'shoulderL' },
  lowerArmL: { pos: [ -0.262, 1.038, 0 ], parent: 'upperArmL' },
  handL:     { pos: [ -0.352, 0.845, 0 ], parent: 'lowerArmL' },

  shoulderR: { pos: [ 0.052, 1.268, 0 ], parent: 'chest' },
  upperArmR: { pos: [ 0.160, 1.255, 0 ], parent: 'shoulderR' },
  lowerArmR: { pos: [ 0.262, 1.038, 0 ], parent: 'upperArmR' },
  handR:     { pos: [ 0.352, 0.845, 0 ], parent: 'lowerArmR' },

  thighL:    { pos: [ -0.076, 0.862, 0 ], parent: 'hips' },
  shinL:     { pos: [ -0.079, 0.478, 0 ], parent: 'thighL' },
  footL:     { pos: [ -0.081, 0.082, 0 ], parent: 'shinL' },
  toeL:      { pos: [ -0.081, 0.030, 0.082 ], parent: 'footL' },

  thighR:    { pos: [ 0.076, 0.862, 0 ], parent: 'hips' },
  shinR:     { pos: [ 0.079, 0.478, 0 ], parent: 'thighR' },
  footR:     { pos: [ 0.081, 0.082, 0 ], parent: 'shinR' },
  toeR:      { pos: [ 0.081, 0.030, 0.082 ], parent: 'footR' },
};

/**
 * Capsule segments used to solve skin weights. Each entry says "vertices near
 * this line belong to this bone", with `r` controlling how far the influence
 * reaches. These are deliberately fatter than the visible limb so weights
 * blend smoothly across a joint instead of creasing.
 */
export const SKIN_SEGMENTS = [
  { bone: 'hips',      a: [ 0, 0.845, 0 ],      b: [ 0, 1.010, 0 ],      r: 0.19 },
  { bone: 'spine',     a: [ 0, 1.010, 0 ],      b: [ 0, 1.150, 0 ],      r: 0.19 },
  { bone: 'chest',     a: [ 0, 1.150, 0 ],      b: [ 0, 1.318, 0 ],      r: 0.175 },
  { bone: 'neck',      a: [ 0, 1.318, 0 ],      b: [ 0, 1.392, 0 ],      r: 0.075 },
  { bone: 'head',      a: [ 0, 1.392, 0 ],      b: [ 0, 1.560, 0 ],      r: 0.20 },

  { bone: 'shoulderL', a: [ -0.052, 1.268, 0 ], b: [ -0.160, 1.255, 0 ], r: 0.062 },
  { bone: 'upperArmL', a: [ -0.150, 1.272, 0 ], b: [ -0.262, 1.038, 0 ], r: 0.098 },
  { bone: 'lowerArmL', a: [ -0.262, 1.038, 0 ], b: [ -0.352, 0.845, 0 ], r: 0.058 },
  { bone: 'handL',     a: [ -0.352, 0.845, 0 ], b: [ -0.400, 0.755, 0 ], r: 0.055 },

  { bone: 'shoulderR', a: [ 0.052, 1.268, 0 ],  b: [ 0.160, 1.255, 0 ],  r: 0.062 },
  { bone: 'upperArmR', a: [ 0.150, 1.272, 0 ],  b: [ 0.262, 1.038, 0 ],  r: 0.098 },
  { bone: 'lowerArmR', a: [ 0.262, 1.038, 0 ],  b: [ 0.352, 0.845, 0 ],  r: 0.058 },
  { bone: 'handR',     a: [ 0.352, 0.845, 0 ],  b: [ 0.400, 0.755, 0 ],  r: 0.055 },

  { bone: 'thighL',    a: [ -0.076, 0.862, 0 ], b: [ -0.079, 0.478, 0 ], r: 0.115 },
  { bone: 'shinL',     a: [ -0.079, 0.478, 0 ], b: [ -0.081, 0.082, 0 ], r: 0.090 },
  { bone: 'footL',     a: [ -0.081, 0.082, 0 ], b: [ -0.081, 0.030, 0.10 ], r: 0.080 },

  { bone: 'thighR',    a: [ 0.076, 0.862, 0 ],  b: [ 0.079, 0.478, 0 ],  r: 0.115 },
  { bone: 'shinR',     a: [ 0.079, 0.478, 0 ],  b: [ 0.081, 0.082, 0 ],  r: 0.090 },
  { bone: 'footR',     a: [ 0.081, 0.082, 0 ],  b: [ 0.081, 0.030, 0.10 ], r: 0.080 },
];

/**
 * Builds the bone hierarchy from {@link BIND_POSE}.
 * @returns {{ root: THREE.Bone, bones: THREE.Bone[], byName: Record<string, THREE.Bone>, skeleton: THREE.Skeleton, order: string[] }}
 */
export function buildSkeleton( extraBones = {} ) {
  const def = { ...BIND_POSE, ...extraBones };
  const byName = {};
  const order = [];

  // Parents must exist before children, so walk the graph in dependency order
  // rather than trusting object key order.
  const pending = new Set( Object.keys( def ) );
  while ( pending.size ) {
    let progressed = false;
    for ( const name of [ ...pending ] ) {
      const d = def[ name ];
      if ( d.parent && !byName[ d.parent ] ) continue;

      const bone = new THREE.Bone();
      bone.name = name;
      const [ x, y, z ] = d.pos;
      if ( d.parent ) {
        const p = def[ d.parent ].pos;
        bone.position.set( x - p[ 0 ], y - p[ 1 ], z - p[ 2 ] );
        byName[ d.parent ].add( bone );
      } else {
        bone.position.set( x, y, z );
      }
      byName[ name ] = bone;
      order.push( name );
      pending.delete( name );
      progressed = true;
    }
    if ( !progressed ) throw new Error( 'buildSkeleton: cyclic or missing parent in bone definition' );
  }

  const root = byName.root;
  root.updateMatrixWorld( true );

  const bones = order.map( ( n ) => byName[ n ] );
  const skeleton = new THREE.Skeleton( bones );

  return { root, bones, byName, skeleton, order };
}

/* ---------------------------------------------------------------------- */
/* Skin weight solving                                                     */
/* ---------------------------------------------------------------------- */

const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

/** Squared distance from a point to a line segment. */
function distToSegment( px, py, pz, seg ) {
  _p.set( px, py, pz );
  _a.set( seg.a[ 0 ], seg.a[ 1 ], seg.a[ 2 ] );
  _ab.set( seg.b[ 0 ] - seg.a[ 0 ], seg.b[ 1 ] - seg.a[ 1 ], seg.b[ 2 ] - seg.a[ 2 ] );
  _ap.subVectors( _p, _a );
  const abLenSq = _ab.lengthSq();
  const t = abLenSq > 1e-9 ? THREE.MathUtils.clamp( _ap.dot( _ab ) / abLenSq, 0, 1 ) : 0;
  _a.addScaledVector( _ab, t );
  return _p.distanceTo( _a );
}

/**
 * Solves and attaches `skinIndex` / `skinWeight` for a bind-pose geometry.
 *
 * Weight falls off with distance to each bone's capsule segment, normalised
 * over the four strongest bones. The falloff exponent is what controls how
 * "rubbery" a joint looks: low values smear influence across the whole body,
 * high values produce a hard crease at the elbow.
 *
 * @param {THREE.BufferGeometry} geometry  In bind pose, world space.
 * @param {string[]} boneOrder             Bone names indexed as in the Skeleton.
 * @param {object} [opts]
 * @param {string[]} [opts.only]           Restrict influence to these bones (hair → head, skirt → skirt bones).
 * @param {Record<string, number>} [opts.bias]  Per-bone multiplier applied before normalising.
 * @param {number} [opts.falloff=2.6]
 */
export function skinGeometry( geometry, boneOrder, opts = {} ) {
  const { only = null, bias = null, falloff = 2.6, segments = SKIN_SEGMENTS } = opts;

  const boneIndex = new Map( boneOrder.map( ( n, i ) => [ n, i ] ) );
  const active = only
    ? segments.filter( ( s ) => only.includes( s.bone ) )
    : segments.filter( ( s ) => boneIndex.has( s.bone ) );

  if ( !active.length ) throw new Error( 'skinGeometry: no matching bone segments' );

  const pos = geometry.attributes.position;
  const count = pos.count;
  const idx = new Uint16Array( count * 4 );
  const wgt = new Float32Array( count * 4 );

  const scratch = [];
  for ( let i = 0; i < count; i++ ) {
    const x = pos.getX( i ), y = pos.getY( i ), z = pos.getZ( i );
    scratch.length = 0;

    for ( const seg of active ) {
      const d = distToSegment( x, y, z, seg );
      // Smooth, bounded falloff: 1 at the bone axis, →0 well outside `r`.
      let w = 1 / ( Math.pow( d / seg.r, falloff ) + 1e-4 );
      if ( bias && bias[ seg.bone ] !== undefined ) w *= bias[ seg.bone ];
      scratch.push( { b: boneIndex.get( seg.bone ) ?? 0, w } );
    }

    scratch.sort( ( m, n ) => n.w - m.w );
    let total = 0;
    for ( let k = 0; k < 4 && k < scratch.length; k++ ) total += scratch[ k ].w;
    if ( total <= 0 ) { idx[ i * 4 ] = scratch[ 0 ].b; wgt[ i * 4 ] = 1; continue; }

    for ( let k = 0; k < 4; k++ ) {
      const s = scratch[ k ];
      idx[ i * 4 + k ] = s ? s.b : 0;
      wgt[ i * 4 + k ] = s ? s.w / total : 0;
    }
  }

  geometry.setAttribute( 'skinIndex', new THREE.Uint16BufferAttribute( idx, 4 ) );
  geometry.setAttribute( 'skinWeight', new THREE.Float32BufferAttribute( wgt, 4 ) );
  return geometry;
}

/** Rigidly binds every vertex to one bone — used for shoes, props and hair caps. */
export function skinRigid( geometry, boneOrder, boneName ) {
  const i = boneOrder.indexOf( boneName );
  if ( i < 0 ) throw new Error( `skinRigid: unknown bone "${boneName}"` );
  const count = geometry.attributes.position.count;
  const idx = new Uint16Array( count * 4 );
  const wgt = new Float32Array( count * 4 );
  for ( let v = 0; v < count; v++ ) { idx[ v * 4 ] = i; wgt[ v * 4 ] = 1; }
  geometry.setAttribute( 'skinIndex', new THREE.Uint16BufferAttribute( idx, 4 ) );
  geometry.setAttribute( 'skinWeight', new THREE.Float32BufferAttribute( wgt, 4 ) );
  return geometry;
}
