import * as THREE from 'three';
import { strand, offsetShell, cullFaces, mergeGeometries } from './Geometry.js';

/**
 * Procedural anime hair.
 *
 * Hair is built in three layers, which is roughly how it is modelled by hand:
 *
 *   1. A **shell** — the skull surface pushed outward, with the face carved
 *      out of it. Gives the silhouette its mass.
 *   2. **Static clumps** — bangs and side locks, welded to the head bone.
 *      These frame the face and never move independently.
 *   3. **Dynamic chains** — twintails, ponytails, long back hair. Each gets
 *      real bones so the spring solver can swing them.
 *
 * Every clump is a flattened, tapering blade rather than a tube: anime hair
 * reads as sheets of hair, and round strands look like spaghetti.
 */

const V = ( x, y, z ) => new THREE.Vector3( x, y, z );

/** Where the head sits in bind pose. Mirrors the values in Rig.js. */
export const HEAD = {
  centerY: 1.472,
  radius: 0.118,
  top: 1.605,
  chin: 1.340,
  front: 0.118,
};

/** Cubic width profile: fat at the root, needle at the tip. */
const taper = ( root, mid = 0.9, power = 1.9 ) => ( t ) =>
  root * ( 1 - Math.pow( t, power ) ) * ( 1 - ( 1 - mid ) * Math.sin( t * Math.PI ) );

/* ---------------------------------------------------------------------- */
/* Shell                                                                   */
/* ---------------------------------------------------------------------- */

/**
 * Carves the face opening out of an offset skull shell.
 *
 * The hairline is a simple predicate rather than a modelled curve: hair is
 * removed where the surface faces forward AND sits above the jaw, with the
 * threshold falling away toward the sides so the shell still covers the
 * temples and in front of the ears.
 */
export function hairShell( headGeo, { thickness = 0.014, crown = 0.030, hairlineY = 1.548, sideDrop = 1.0 } = {} ) {
  const shell = offsetShell( headGeo, { base: thickness, crown, centerY: HEAD.centerY } );
  return cullFaces( shell, ( x, y, z ) => !( z > 0.040 && y < hairlineY - sideDrop * Math.abs( x ) ) );
}

/* ---------------------------------------------------------------------- */
/* Clump builders                                                          */
/* ---------------------------------------------------------------------- */

/**
 * A fringe of bangs sweeping across the forehead.
 *
 * Strands are laid out along a normalised u ∈ [-1,1] and pushed outward in x
 * as they descend, so the fringe splays instead of hanging as a curtain. A
 * per-strand length jitter is what stops it reading as a comb.
 */
function bangs( { count = 15, spread = 0.104, drop = 0.026, width = 0.019, parting = 0.15, sweep = 0.30, seed = 1 } = {} ) {
  let s = seed >>> 0;
  const rnd = () => ( ( s = ( s * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );

  const out = [];
  for ( let i = 0; i < count; i++ ) {
    const u = count === 1 ? 0 : ( i / ( count - 1 ) ) * 2 - 1;
    // Push strands away from the parting line so it stays visible.
    const part = Math.sign( u || 1 ) * parting * ( 1 - Math.abs( u ) ) * 0.5;
    const x0 = u * spread * 0.60 + part * spread;
    const x1 = u * spread * 1.14 + sweep * spread * 0.4;

    const jitter = 0.84 + rnd() * 0.32;
    const len = drop * jitter * ( 1 - 0.28 * u * u );
    // Layer strands in depth so overlapping blades read as a fringe rather
    // than a set of intersecting planes.
    const z = 0.0045 * ( i % 3 ) - 0.0045;

    // The strand starts back on the crown and only the last third hangs over
    // the forehead. Starting it at the hairline instead gives a clump that is
    // wider than it is long, which renders as a rectangular shard rather than
    // as hair — the ratio of length to width is the whole trick.
    out.push( strand(
      [
        V( x0 * 0.55, HEAD.top + 0.004, -0.030 + z ),
        V( x0 * 0.90, HEAD.top - 0.014, 0.052 + z ),
        V( x0 * 1.02, HEAD.top - 0.050, 0.104 + z ),
        V( ( x0 + x1 ) * 0.55, HEAD.top - 0.050 - len * 0.62, 0.120 + z ),
        V( x1, HEAD.top - 0.052 - len, 0.110 + z ),
      ],
      taper( width * ( 0.88 + rnd() * 0.24 ), 0.96, 1.15 ),
      { sides: 7, steps: 20, flat: 0.62 }
    ) );
  }
  return out;
}

/** Long locks framing the face, hanging in front of the shoulders. */
function sideLocks( { length = 0.30, width = 0.040, out = 0.118, flare = 0.02 } = {} ) {
  const geos = [];
  for ( const sx of [ -1, 1 ] ) {
    for ( let k = 0; k < 2; k++ ) {
      const w = width * ( k === 0 ? 1 : 0.66 );
      const z = k === 0 ? 0.052 : -0.010;
      geos.push( strand(
        [
          V( sx * out * 0.62, HEAD.top - 0.030, z * 0.5 ),
          V( sx * out * 1.02, HEAD.centerY + 0.030, z ),
          V( sx * ( out + flare ) * 1.02, HEAD.centerY - length * 0.42, z * 0.8 ),
          V( sx * ( out + flare * 2 ), HEAD.centerY - length, z * 0.5 ),
        ],
        taper( w, 0.92 ),
        { sides: 7, steps: 14, flat: 0.52 }
      ) );
    }
  }
  return geos;
}

/** The single upright strand. Pure anime shorthand, and worth the 60 triangles. */
function ahoge( { height = 0.075, width = 0.010, lean = 0.03 } = {} ) {
  return strand(
    [
      V( 0.010, HEAD.top - 0.020, -0.012 ),
      V( 0.014, HEAD.top + height * 0.42, 0.010 ),
      V( -0.006, HEAD.top + height * 0.86, lean ),
      V( -0.030, HEAD.top + height * 0.92, lean * 1.9 ),
    ],
    taper( width, 1.0, 1.3 ),
    { sides: 5, steps: 12, flat: 0.7 }
  );
}

/** Mass at the back of the skull, so the silhouette isn't flat from behind. */
function backVolume( { drop = 0.10, width = 0.128, count = 7 } = {} ) {
  const geos = [];
  for ( let i = 0; i < count; i++ ) {
    const u = ( i / ( count - 1 ) ) * 2 - 1;
    const x = u * width * 0.78;
    geos.push( strand(
      [
        V( x * 0.6, HEAD.top - 0.030, -0.050 ),
        V( x, HEAD.centerY + 0.030, -0.105 ),
        V( x * 1.04, HEAD.centerY - drop * 0.6, -0.098 ),
        V( x * 0.96, HEAD.centerY - drop, -0.070 ),
      ],
      taper( 0.036 * ( 1 - 0.25 * u * u ), 0.94 ),
      { sides: 7, steps: 10, flat: 0.55 }
    ) );
  }
  return geos;
}

/* ---------------------------------------------------------------------- */
/* Dynamic chains                                                          */
/* ---------------------------------------------------------------------- */

/**
 * Builds a bone chain plus the blade geometry that rides on it.
 *
 * The bones are laid out along the same path the geometry follows, so the
 * rest pose is exactly the modelled shape and the spring solver starts at
 * equilibrium instead of snapping on the first frame.
 *
 * @returns {{ boneDefs: object, segments: object[], geometry: THREE.BufferGeometry, chain: string[] }}
 */
function boneChain( name, path, { width, segments: linkCount = 3, parent = 'head', sides = 7, flat = 0.42, radius = 0.03 } = {} ) {
  const curve = new THREE.CatmullRomCurve3( path, false, 'catmullrom', 0.5 );
  const boneDefs = {};
  const segments = [];
  const chain = [];

  let prevName = parent;
  let prevPos = curve.getPointAt( 0 );

  for ( let i = 0; i < linkCount; i++ ) {
    const t = ( i + 1 ) / linkCount;
    const p = curve.getPointAt( t );
    const bName = `${name}${i}`;
    boneDefs[ bName ] = { pos: [ prevPos.x, prevPos.y, prevPos.z ], parent: prevName };
    // The influence capsule spans from this bone to the next point, fattened
    // so neighbouring links share vertices and the blade doesn't kink.
    segments.push( {
      bone: bName,
      a: [ prevPos.x, prevPos.y, prevPos.z ],
      b: [ p.x, p.y, p.z ],
      r: radius,
    } );
    chain.push( bName );
    prevName = bName;
    prevPos = p;
  }

  const geometry = strand( path, taper( width, 0.94 ), { sides, steps: linkCount * 5, flat } );
  return { boneDefs, segments, geometry, chain };
}

/* ---------------------------------------------------------------------- */
/* Styles                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * @typedef {object} HairBuild
 * @property {THREE.BufferGeometry} staticGeometry   Welded to the head bone.
 * @property {THREE.BufferGeometry|null} dynamicGeometry  Skinned to the chains.
 * @property {object} boneDefs        Extra bones to add to the skeleton.
 * @property {object[]} segments      Skin segments for the dynamic geometry.
 * @property {string[][]} chains      Bone-name chains for the spring solver.
 */

export const HAIR_STYLES = {
  /** Twin tails: the loudest silhouette, and the best showcase for spring bones. */
  twintail( o = {} ) {
    const len = o.tailLength ?? 0.52;
    const anchorX = 0.108, anchorY = HEAD.top - 0.055;

    const chains = [];
    const boneDefs = {};
    const segments = [];
    const dynamic = [];

    for ( const sx of [ -1, 1 ] ) {
      const path = [
        V( sx * anchorX, anchorY, -0.030 ),
        V( sx * ( anchorX + 0.055 ), anchorY - 0.030, -0.070 ),
        V( sx * ( anchorX + 0.070 ), anchorY - len * 0.52, -0.080 ),
        V( sx * ( anchorX + 0.048 ), anchorY - len, -0.045 ),
      ];
      const c = boneChain( `tail${sx < 0 ? 'L' : 'R'}`, path, { width: 0.050, segments: 4, radius: 0.075, sides: 8, flat: 0.62 } );
      Object.assign( boneDefs, c.boneDefs );
      segments.push( ...c.segments );
      chains.push( c.chain );
      dynamic.push( c.geometry );

      // A scrunchie at the anchor, welded to the head so it doesn't swing.
      const tie = new THREE.TorusGeometry( 0.030, 0.011, 8, 18 );
      tie.rotateY( Math.PI / 2 );
      tie.rotateZ( sx * 0.3 );
      tie.translate( sx * anchorX, anchorY - 0.006, -0.036 );
      dynamic.push( tie ); // rides with the first link
      c.segments.push( { bone: c.chain[ 0 ], a: [ sx * anchorX, anchorY, -0.036 ], b: [ sx * anchorX, anchorY - 0.02, -0.036 ], r: 0.06 } );
    }

    return {
      staticGeos: [ ...bangs( { count: 13, width: 0.034, ...o.bangs } ), ...sideLocks( { length: 0.24, ...o.sideLocks } ), ...backVolume( { drop: 0.09 } ), ahoge() ],
      dynamicGeos: dynamic,
      boneDefs, segments, chains,
    };
  },

  /** Long straight hair down the back — one wide sheet plus two edge locks. */
  long( o = {} ) {
    const len = o.length ?? 0.62;
    const boneDefs = {}, segments = [], chains = [], dynamic = [];

    const defs = [
      { name: 'hairBack', x: 0, w: 0.115, z: -0.088, len: len },
      { name: 'hairSideL', x: -0.082, w: 0.052, z: -0.062, len: len * 0.86 },
      { name: 'hairSideR', x: 0.082, w: 0.052, z: -0.062, len: len * 0.86 },
    ];

    for ( const d of defs ) {
      const path = [
        V( d.x * 0.7, HEAD.top - 0.035, -0.045 ),
        V( d.x, HEAD.centerY + 0.020, d.z ),
        V( d.x * 1.06, HEAD.centerY - d.len * 0.5, d.z * 1.05 ),
        V( d.x * 0.94, HEAD.centerY - d.len, d.z * 0.62 ),
      ];
      const c = boneChain( d.name, path, { width: d.w, segments: 4, radius: 0.11, flat: 0.30 } );
      Object.assign( boneDefs, c.boneDefs );
      segments.push( ...c.segments );
      chains.push( c.chain );
      dynamic.push( c.geometry );
    }

    return {
      staticGeos: [ ...bangs( { count: 13, width: 0.034, ...o.bangs } ), ...sideLocks( { length: 0.34, ...o.sideLocks } ), ahoge( { height: 0.055 } ) ],
      dynamicGeos: dynamic,
      boneDefs, segments, chains,
    };
  },

  /** A high ponytail — small silhouette at rest, big arc when running. */
  ponytail( o = {} ) {
    const len = o.length ?? 0.46;
    const ax = 0.012, ay = HEAD.top - 0.010, az = -0.070;
    const path = [
      V( ax, ay, az ),
      V( ax, ay + 0.020, az - 0.075 ),
      V( ax, ay - len * 0.40, az - 0.120 ),
      V( ax, ay - len, az - 0.075 ),
    ];
    const c = boneChain( 'ponytail', path, { width: 0.062, segments: 4, radius: 0.10 } );

    const tie = new THREE.TorusGeometry( 0.034, 0.012, 8, 20 );
    tie.rotateX( Math.PI / 2.6 );
    tie.translate( ax, ay - 0.004, az - 0.014 );

    return {
      staticGeos: [ ...bangs( { count: 12, width: 0.033, ...o.bangs } ), ...sideLocks( { length: 0.20, ...o.sideLocks } ), ...backVolume( { drop: 0.06 } ), tie ],
      dynamicGeos: [ c.geometry ],
      boneDefs: c.boneDefs,
      segments: c.segments,
      chains: [ c.chain ],
    };
  },

  /** A short bob. All silhouette, no dynamics — cheap for background units. */
  bob( o = {} ) {
    return {
      staticGeos: [
        ...bangs( { count: 13, drop: 0.044, width: 0.033, ...o.bangs } ),
        ...sideLocks( { length: 0.155, width: 0.048, flare: 0.028, ...o.sideLocks } ),
        ...backVolume( { drop: 0.150, count: 9 } ),
      ],
      dynamicGeos: [],
      boneDefs: {}, segments: [], chains: [],
    };
  },

  /** Cropped, for enemies and male silhouettes. */
  short( o = {} ) {
    return {
      staticGeos: [
        ...bangs( { count: 9, drop: 0.030, width: 0.026, sweep: 0.6, ...o.bangs } ),
        ...backVolume( { drop: 0.030, count: 7 } ),
      ],
      dynamicGeos: [],
      boneDefs: {}, segments: [], chains: [],
    };
  },
};

/**
 * Builds a complete hair rig.
 *
 * @param {string} styleName        Key of {@link HAIR_STYLES}.
 * @param {THREE.BufferGeometry} headGeo  The bind-pose head, for the shell.
 * @param {object} [opts]
 * @returns {HairBuild}
 */
export function buildHair( styleName, headGeo, opts = {} ) {
  const style = HAIR_STYLES[ styleName ] ?? HAIR_STYLES.bob;
  const built = style( opts );

  const shell = hairShell( headGeo, opts.shell );
  const staticGeos = [ shell, ...built.staticGeos ].filter( Boolean );

  return {
    staticGeometry: mergeGeometries( staticGeos ),
    dynamicGeometry: built.dynamicGeos.length ? mergeGeometries( built.dynamicGeos ) : null,
    boneDefs: built.boneDefs,
    segments: built.segments,
    chains: built.chains,
  };
}
