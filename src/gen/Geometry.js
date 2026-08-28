import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Geometry primitives for building stylised anime characters and props out of
 * code. Everything here works in the character's bind pose (world space,
 * Y up, facing +Z) and is merged and auto-skinned later.
 */

const _v = new THREE.Vector3();

/* ---------------------------------------------------------------------- */
/* Profile tube — the workhorse                                            */
/* ---------------------------------------------------------------------- */

/**
 * Lofts a closed tube through a stack of elliptical rings.
 *
 * Rings are interpolated with a Catmull-Rom spline rather than lerped, so a
 * limb reads as an organic taper instead of a stack of truncated cones. This
 * single builder produces torsos, arms, legs, socks, sleeves and skirts.
 *
 * @param {Array<{y:number, rx:number, rz?:number, cx?:number, cz?:number, squash?:number}>} rings
 *        Bottom-to-top cross sections. `rz` defaults to `rx`; `cx`/`cz` offset
 *        the ring centre, which is how you bend a limb or give a torso posture.
 * @param {object} [opts]
 * @param {number} [opts.radial=16]     Segments around the tube.
 * @param {number} [opts.subdiv=3]      Extra interpolated rings between each pair.
 * @param {boolean} [opts.capTop=true]
 * @param {boolean} [opts.capBottom=true]
 * @param {number} [opts.capRound=0]    0 = flat cap, 1 = hemispherical cap.
 * @param {'cylindrical'|'planar'} [opts.uv='cylindrical']
 * @returns {THREE.BufferGeometry}
 */
export function profileTube( rings, opts = {} ) {
  const {
    radial = 16, subdiv = 3, capTop = true, capBottom = true,
    capRound = 0, uv = 'cylindrical', uvScale = 1,
  } = opts;

  const norm = rings.map( ( r ) => ( {
    y: r.y, rx: r.rx, rz: r.rz ?? r.rx, cx: r.cx ?? 0, cz: r.cz ?? 0,
  } ) );

  // Catmull-Rom through the ring parameters. Duplicating the end rings gives
  // the spline clamped tangents so the ends don't flare.
  const ext = [ norm[ 0 ], ...norm, norm[ norm.length - 1 ] ];
  const sample = ( i, t ) => {
    const p0 = ext[ i ], p1 = ext[ i + 1 ], p2 = ext[ i + 2 ], p3 = ext[ i + 3 ];
    const t2 = t * t, t3 = t2 * t;
    const cr = ( a, b, c, d ) =>
      0.5 * ( ( 2 * b ) + ( -a + c ) * t + ( 2 * a - 5 * b + 4 * c - d ) * t2 + ( -a + 3 * b - 3 * c + d ) * t3 );
    return {
      y: cr( p0.y, p1.y, p2.y, p3.y ),
      rx: Math.max( cr( p0.rx, p1.rx, p2.rx, p3.rx ), 1e-4 ),
      rz: Math.max( cr( p0.rz, p1.rz, p2.rz, p3.rz ), 1e-4 ),
      cx: cr( p0.cx, p1.cx, p2.cx, p3.cx ),
      cz: cr( p0.cz, p1.cz, p2.cz, p3.cz ),
    };
  };

  const lofted = [];
  for ( let i = 0; i < norm.length - 1; i++ ) {
    const steps = subdiv + 1;
    for ( let s = 0; s < steps; s++ ) lofted.push( sample( i, s / steps ) );
  }
  lofted.push( norm[ norm.length - 1 ] );

  const positions = [], normals = [], uvs = [], indices = [];
  const rowCount = lofted.length;

  const totalLen = Math.abs( lofted[ rowCount - 1 ].y - lofted[ 0 ].y ) || 1;

  for ( let r = 0; r < rowCount; r++ ) {
    const ring = lofted[ r ];
    const vCoord = ( ring.y - lofted[ 0 ].y ) / totalLen;
    // Central difference on the ring centres, so a bent limb gets normals
    // that follow the bend instead of pointing straight out from the axis.
    const prev = lofted[ Math.max( r - 1, 0 ) ];
    const next = lofted[ Math.min( r + 1, rowCount - 1 ) ];
    const dy = next.y - prev.y;
    const dRx = ( next.rx - prev.rx );
    const dRz = ( next.rz - prev.rz );

    for ( let a = 0; a <= radial; a++ ) {
      const ang = ( a / radial ) * Math.PI * 2;
      const ca = Math.cos( ang ), sa = Math.sin( ang );
      positions.push( ring.cx + ca * ring.rx, ring.y, ring.cz + sa * ring.rz );

      // Slope-corrected normal: a cone's surface normal tilts by the taper.
      const nx = ca / ring.rx, nz = sa / ring.rz;
      const slope = -( ca * dRx + sa * dRz ) / ( Math.abs( dy ) > 1e-6 ? dy : 1e-6 );
      _v.set( nx, slope * Math.hypot( nx, nz ), nz ).normalize();
      normals.push( _v.x, _v.y, _v.z );

      uvs.push( uv === 'planar' ? ( ca * ring.rx * uvScale + 0.5 ) : ( a / radial ) * uvScale, vCoord );
    }
  }

  const stride = radial + 1;
  for ( let r = 0; r < rowCount - 1; r++ ) {
    for ( let a = 0; a < radial; a++ ) {
      const i0 = r * stride + a, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
      indices.push( i0, i2, i1, i1, i2, i3 );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
  geo.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
  geo.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
  geo.setIndex( indices );

  const parts = [ geo ];
  if ( capBottom ) parts.push( makeCap( lofted[ 0 ], radial, -1, capRound ) );
  if ( capTop ) parts.push( makeCap( lofted[ rowCount - 1 ], radial, 1, capRound ) );

  return parts.length > 1 ? mergeGeometries( parts ) : geo;
}

/** Flat or domed end cap matching a ring's ellipse. */
function makeCap( ring, radial, dir, round ) {
  const positions = [], normals = [], uvs = [], indices = [];
  const domeRows = round > 0 ? 5 : 1;
  const height = round * Math.max( ring.rx, ring.rz );

  for ( let r = 0; r <= domeRows; r++ ) {
    const t = r / domeRows;
    const phi = t * Math.PI * 0.5;
    const scale = Math.cos( phi );
    const y = ring.y + dir * Math.sin( phi ) * height;
    for ( let a = 0; a <= radial; a++ ) {
      const ang = ( a / radial ) * Math.PI * 2;
      const ca = Math.cos( ang ), sa = Math.sin( ang );
      positions.push( ring.cx + ca * ring.rx * scale, y, ring.cz + sa * ring.rz * scale );
      if ( round > 0 ) {
        _v.set( ca * scale, dir * Math.sin( phi ), sa * scale ).normalize();
        normals.push( _v.x, _v.y, _v.z );
      } else {
        normals.push( 0, dir, 0 );
      }
      uvs.push( ca * scale * 0.5 + 0.5, sa * scale * 0.5 + 0.5 );
    }
  }

  const stride = radial + 1;
  for ( let r = 0; r < domeRows; r++ ) {
    for ( let a = 0; a < radial; a++ ) {
      const i0 = r * stride + a, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
      if ( dir > 0 ) indices.push( i0, i2, i1, i1, i2, i3 );
      else indices.push( i0, i1, i2, i1, i3, i2 );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
  geo.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
  geo.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
  geo.setIndex( indices );
  return geo;
}

/* ---------------------------------------------------------------------- */
/* Strand — hair, ribbons, straps                                          */
/* ---------------------------------------------------------------------- */

/**
 * Sweeps a flattened cross-section along a Catmull-Rom path.
 *
 * Anime hair is not tubes. It is flat, blade-like clumps that taper to a
 * point, so the cross-section here is an ellipse squashed on one axis, and
 * the width profile is driven by the caller. `flat` controls how blade-like
 * the section is: 1 = round, 0.25 = a ribbon.
 *
 * @param {THREE.Vector3[]} path       Control points, at least 2.
 * @param {(t:number)=>number} widthAt Half-width along the strand.
 * @param {object} [opts]
 */
export function strand( path, widthAt, opts = {} ) {
  const { sides = 6, steps = 14, flat = 0.42, twist = 0, tipSharpness = 1.6 } = opts;

  const curve = new THREE.CatmullRomCurve3( path, false, 'catmullrom', 0.5 );
  const frames = curve.computeFrenetFrames( steps, false );
  const positions = [], normals = [], uvs = [], indices = [];

  for ( let i = 0; i <= steps; i++ ) {
    const t = i / steps;
    const p = curve.getPointAt( t );
    const N = frames.normals[ i ], B = frames.binormals[ i ];
    const w = widthAt( t ) * Math.pow( 1 - t, 0 ) || 1e-4;
    const tw = twist * t;

    for ( let a = 0; a <= sides; a++ ) {
      const ang = ( a / sides ) * Math.PI * 2 + tw;
      const ca = Math.cos( ang ), sa = Math.sin( ang );
      const ox = ca * w, oy = sa * w * flat;
      positions.push(
        p.x + N.x * ox + B.x * oy,
        p.y + N.y * ox + B.y * oy,
        p.z + N.z * ox + B.z * oy
      );
      _v.set( N.x * ca + B.x * sa / flat, N.y * ca + B.y * sa / flat, N.z * ca + B.z * sa / flat ).normalize();
      normals.push( _v.x, _v.y, _v.z );
      uvs.push( a / sides, t );
    }
  }

  // Collapse the last ring to a point so the strand ends in a tip rather than
  // a visible cut-off disc.
  const tip = curve.getPointAt( 1 );
  const tipIndex = positions.length / 3;
  positions.push( tip.x, tip.y, tip.z );
  const tang = curve.getTangentAt( 1 );
  normals.push( tang.x, tang.y, tang.z );
  uvs.push( 0.5, 1 );

  const stride = sides + 1;
  for ( let i = 0; i < steps; i++ ) {
    for ( let a = 0; a < sides; a++ ) {
      const i0 = i * stride + a, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
      indices.push( i0, i2, i1, i1, i2, i3 );
    }
  }
  const lastRow = steps * stride;
  for ( let a = 0; a < sides; a++ ) indices.push( lastRow + a, tipIndex, lastRow + a + 1 );

  const geo = new THREE.BufferGeometry();
  geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
  geo.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
  geo.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
  geo.setIndex( indices );
  geo.userData.tipSharpness = tipSharpness;
  return orientOutward( geo );
}

/* ---------------------------------------------------------------------- */
/* Misc primitives                                                         */
/* ---------------------------------------------------------------------- */

/** Rounded box via a subdivided cube projected onto a superellipsoid. */
export function roundedBox( w, h, d, radius = 0.02, seg = 4 ) {
  const geo = new THREE.BoxGeometry( w, h, d, seg, seg, seg );
  const pos = geo.attributes.position;
  const hw = w / 2 - radius, hh = h / 2 - radius, hd = d / 2 - radius;

  for ( let i = 0; i < pos.count; i++ ) {
    const x = pos.getX( i ), y = pos.getY( i ), z = pos.getZ( i );
    // Clamp to the inner box, then push back out by the corner radius along
    // the direction of the overhang — a standard rounded-box construction.
    const cx = THREE.MathUtils.clamp( x, -hw, hw );
    const cy = THREE.MathUtils.clamp( y, -hh, hh );
    const cz = THREE.MathUtils.clamp( z, -hd, hd );
    _v.set( x - cx, y - cy, z - cz );
    if ( _v.lengthSq() > 1e-12 ) _v.normalize().multiplyScalar( radius );
    pos.setXYZ( i, cx + _v.x, cy + _v.y, cz + _v.z );
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Reshapes a UV sphere into a stylised anime skull: tall cranium, narrow
 * tapering jaw, a small chin push and a flattened back so hair sits on it.
 */
export function shapeHead( radius = 0.125, { jawNarrow = 0.62, chin = 0.22, backFlat = 0.9, widthSegments = 36, heightSegments = 28 } = {} ) {
  const geo = new THREE.SphereGeometry( radius, widthSegments, heightSegments );
  const pos = geo.attributes.position;

  for ( let i = 0; i < pos.count; i++ ) {
    let x = pos.getX( i ), y = pos.getY( i ), z = pos.getZ( i );
    const t = y / radius; // -1 at chin, +1 at crown

    if ( t < 0 ) {
      // Jaw: taper the cross-section quadratically toward the chin.
      const k = 1 - ( 1 - jawNarrow ) * Math.pow( -t, 1.5 );
      x *= k;
      z *= k;
      // Push the chin forward and slightly up so the profile isn't a ball.
      z += chin * radius * Math.pow( -t, 2.4 ) * ( z > 0 ? 1 : 0.15 );
      y += radius * 0.10 * Math.pow( -t, 3 );
    } else {
      // Cranium: slightly taller than wide.
      y *= 1 + 0.10 * t;
    }
    if ( z < 0 ) z *= backFlat;

    pos.setXYZ( i, x, y, z );
  }

  geo.computeVertexNormals();
  return geo;
}

/**
 * Front-planar UV projection along -Z.
 *
 * The head texture is authored as a flat face plate, so projecting it
 * straight on keeps the features undistorted from every angle the camera
 * actually sees. Vertices on the back of the skull land in the texture's
 * plain-skin margin, which is hidden by hair anyway.
 */
export function planarFrontUV( geo, { width, height, centerY = 0, arcCorrect = 0.35 } = {} ) {
  const pos = geo.attributes.position;
  const uv = new Float32Array( pos.count * 2 );

  for ( let i = 0; i < pos.count; i++ ) {
    const x = pos.getX( i ), y = pos.getY( i );
    let u = x / width + 0.5;
    let v = ( y - centerY ) / height + 0.5;

    // Blend toward an arcsine warp near the silhouette, which spreads the
    // texture more evenly across the curve instead of smearing it at the edge.
    const nx = THREE.MathUtils.clamp( ( u - 0.5 ) * 2, -1, 1 );
    const arc = Math.asin( nx ) / Math.PI + 0.5;
    u = u * ( 1 - arcCorrect ) + arc * arcCorrect;

    uv[ i * 2 ] = u;
    uv[ i * 2 + 1 ] = v;
  }
  geo.setAttribute( 'uv', new THREE.BufferAttribute( uv, 2 ) );
  return geo;
}

/** A slightly domed quad, used for eye / brow / mouth cards on the face. */
export function faceCard( width, height, curvature = 0.35, seg = 6 ) {
  const geo = new THREE.PlaneGeometry( width, height, seg, seg );
  const pos = geo.attributes.position;
  for ( let i = 0; i < pos.count; i++ ) {
    const x = pos.getX( i ) / ( width / 2 );
    const y = pos.getY( i ) / ( height / 2 );
    // Spherical bulge so the card hugs the skull and never pokes through it.
    pos.setZ( i, -curvature * width * 0.5 * ( x * x * 0.9 + y * y * 0.45 ) );
  }
  geo.computeVertexNormals();
  return geo;
}

/** Applies a transform to a geometry in place and fixes up the normals. */
export function xform( geo, { position, rotation, scale } = {} ) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if ( rotation ) q.setFromEuler( rotation instanceof THREE.Euler ? rotation : new THREE.Euler( ...rotation ) );
  m.compose(
    position ? ( position.isVector3 ? position : new THREE.Vector3( ...position ) ) : new THREE.Vector3(),
    q,
    scale ? ( scale.isVector3 ? scale : ( typeof scale === 'number' ? new THREE.Vector3( scale, scale, scale ) : new THREE.Vector3( ...scale ) ) ) : new THREE.Vector3( 1, 1, 1 )
  );
  geo.applyMatrix4( m );
  return geo;
}

/** Mirrors a geometry across X, flipping winding so it isn't inside out. */
export function mirrorX( geo ) {
  const out = geo.clone();
  out.applyMatrix4( new THREE.Matrix4().makeScale( -1, 1, 1 ) );
  const idx = out.getIndex();
  if ( idx ) {
    const a = idx.array;
    for ( let i = 0; i < a.length; i += 3 ) { const t = a[ i ]; a[ i ] = a[ i + 2 ]; a[ i + 2 ] = t; }
    idx.needsUpdate = true;
  }
  const n = out.attributes.normal;
  for ( let i = 0; i < n.count; i++ ) n.setX( i, -n.getX( i ) );
  n.needsUpdate = true;
  return out;
}

export { mergeGeometries };

/* ---------------------------------------------------------------------- */
/* Oriented limbs and shell surgery                                        */
/* ---------------------------------------------------------------------- */

const _up = new THREE.Vector3( 0, 1, 0 );
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();

/**
 * Lofts a tube from point `a` to point `b`.
 *
 * {@link profileTube} always builds along +Y; a limb almost never runs along
 * +Y. This wraps it so an arm can be described by its two joint positions,
 * which is how the skeleton already stores them.
 *
 * @param {THREE.Vector3} a
 * @param {THREE.Vector3} b
 * @param {Array<{t:number, r?:number, rx?:number, rz?:number}>} rings  `t` ∈ [0,1] along a→b.
 */
export function limb( a, b, rings, opts = {} ) {
  const len = a.distanceTo( b );
  const geo = profileTube(
    rings.map( ( r ) => ( {
      y: r.t * len,
      rx: r.rx ?? r.r,
      rz: r.rz ?? r.r,
      cx: r.cx ?? 0,
      cz: r.cz ?? 0,
    } ) ),
    opts
  );

  _dir.subVectors( b, a ).normalize();
  _quat.setFromUnitVectors( _up, _dir );
  geo.applyMatrix4( _mat.makeRotationFromQuaternion( _quat ) );
  geo.translate( a.x, a.y, a.z );
  return geo;
}

/**
 * Removes every triangle whose centroid fails `keep`.
 *
 * Used to carve the face opening out of a hair shell. Cutting the shell is
 * much cheaper than trying to author a partial sphere with the right
 * silhouette, and it lets the hairline be described as a simple predicate
 * over position rather than as spherical-coordinate bookkeeping.
 *
 * @param {THREE.BufferGeometry} geo  Must be indexed.
 * @param {(x:number,y:number,z:number)=>boolean} keep
 */
export function cullFaces( geo, keep ) {
  const index = geo.getIndex();
  if ( !index ) throw new Error( 'cullFaces: geometry must be indexed' );
  const pos = geo.attributes.position;
  const src = index.array;
  const out = [];

  for ( let i = 0; i < src.length; i += 3 ) {
    const a = src[ i ], b = src[ i + 1 ], c = src[ i + 2 ];
    const cx = ( pos.getX( a ) + pos.getX( b ) + pos.getX( c ) ) / 3;
    const cy = ( pos.getY( a ) + pos.getY( b ) + pos.getY( c ) ) / 3;
    const cz = ( pos.getZ( a ) + pos.getZ( b ) + pos.getZ( c ) ) / 3;
    if ( keep( cx, cy, cz ) ) out.push( a, b, c );
  }

  geo.setIndex( out );
  return geo;
}

/**
 * A hair shell: the head surface offset outward, so hair reads as a solid
 * volume sitting on the skull rather than a decal painted on it. The offset
 * grows toward the crown, which is where real hair has the most body.
 */
export function offsetShell( headGeo, { base = 0.012, crown = 0.030, centerY = 0 } = {} ) {
  const geo = headGeo.clone();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;

  for ( let i = 0; i < pos.count; i++ ) {
    const y = pos.getY( i );
    // 0 at the chin, 1 at the crown.
    const t = THREE.MathUtils.clamp( ( y - centerY ) / 0.14 * 0.5 + 0.5, 0, 1 );
    const off = base + ( crown - base ) * Math.pow( t, 1.4 );
    pos.setXYZ(
      i,
      pos.getX( i ) + nrm.getX( i ) * off,
      y + nrm.getY( i ) * off,
      pos.getZ( i ) + nrm.getZ( i ) * off
    );
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * A pleated skirt.
 *
 * The pleats are radial: the hem radius is modulated by a triangle wave over
 * the azimuth, and the modulation depth ramps in from zero at the waist. A
 * plain cone reads as a lampshade; the fold silhouette is the entire reason a
 * school skirt is recognisable.
 */
export function pleatedSkirt( {
  waistY = 0.90, hemY = 0.66,
  waistRX = 0.125, waistRZ = 0.090,
  hemRX = 0.215, hemRZ = 0.170,
  pleats = 18, depth = 0.30, flare = 1.5,
  rows = 14, radial = 108,
} = {} ) {
  const positions = [], normals = [], uvs = [], indices = [];
  const stride = radial + 1;

  for ( let r = 0; r <= rows; r++ ) {
    const t = r / rows;
    const y = waistY + ( hemY - waistY ) * t;
    // Flare accelerates toward the hem so the skirt bells out rather than
    // opening as a straight cone.
    const k = Math.pow( t, 1 / flare );
    const rx = waistRX + ( hemRX - waistRX ) * k;
    const rz = waistRZ + ( hemRZ - waistRZ ) * k;
    const amp = depth * Math.pow( t, 1.25 );

    for ( let a = 0; a <= radial; a++ ) {
      const u = a / radial;
      const ang = u * Math.PI * 2;
      // Triangle wave: sharp creases, unlike a sine which reads as ripple.
      const phase = ( u * pleats ) % 1;
      const tri = Math.abs( phase * 2 - 1 ) * 2 - 1;
      const m = 1 + amp * tri;

      positions.push( Math.cos( ang ) * rx * m, y, Math.sin( ang ) * rz * m );
      uvs.push( u * pleats, t );
      normals.push( 0, 0, 0 ); // recomputed below
    }
  }

  for ( let r = 0; r < rows; r++ ) {
    for ( let a = 0; a < radial; a++ ) {
      const i0 = r * stride + a, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
      indices.push( i0, i2, i1, i1, i2, i3 );
    }
  }

  // Hem underside, so the skirt isn't a one-sided surface when seen from below.
  const hemStart = positions.length / 3;
  const inner = 0.93;
  for ( let a = 0; a <= radial; a++ ) {
    const base = ( rows * stride + a ) * 3;
    positions.push( positions[ base ] * inner, positions[ base + 1 ] + 0.014, positions[ base + 2 ] * inner );
    uvs.push( a / radial, 1 );
    normals.push( 0, 0, 0 );
  }
  for ( let a = 0; a < radial; a++ ) {
    const o = rows * stride + a;
    indices.push( o, o + 1, hemStart + a, o + 1, hemStart + a + 1, hemStart + a );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
  geo.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
  geo.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
  geo.setIndex( indices );
  geo.computeVertexNormals();
  return orientOutward( geo );
}

/**
 * Forces a swept surface's triangles to wind outward.
 *
 * `profileTube`, `strand` and `pleatedSkirt` all emit the same index pattern,
 * but the resulting winding depends on which way the sweep runs: a tube built
 * bottom-to-top winds outward, and the same code sweeping top-to-bottom — a
 * skirt from waist to hem, a twintail from scalp to tip — winds inward. Those
 * surfaces are then back-face culled and vanish, and the only reason they
 * appeared on screen at all was the BackSide outline hull painting them in.
 * Which is why skirts and hanging hair looked like flat ink.
 *
 * Rather than hand-track sweep direction at every call site, this measures it:
 * sample face normals against the direction from the mesh's centre, and flip
 * everything if the majority point inward.
 */
export function orientOutward( geo ) {
  const index = geo.getIndex();
  const pos = geo.attributes.position;
  if ( !index ) return geo;

  geo.computeBoundingSphere();
  const c = geo.boundingSphere.center;

  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3(), outward = new THREE.Vector3();

  const arr = index.array;
  const triCount = arr.length / 3;
  const step = Math.max( 1, Math.floor( triCount / 64 ) );
  let score = 0;

  for ( let t = 0; t < triCount; t += step ) {
    const i0 = arr[ t * 3 ], i1 = arr[ t * 3 + 1 ], i2 = arr[ t * 3 + 2 ];
    a.fromBufferAttribute( pos, i0 );
    b.fromBufferAttribute( pos, i1 );
    d.fromBufferAttribute( pos, i2 );
    ab.subVectors( b, a );
    ac.subVectors( d, a );
    n.crossVectors( ab, ac );
    if ( n.lengthSq() < 1e-14 ) continue;

    outward.copy( a ).add( b ).add( d ).multiplyScalar( 1 / 3 ).sub( c );
    if ( outward.lengthSq() < 1e-12 ) continue;

    score += Math.sign( n.dot( outward ) );
  }

  if ( score >= 0 ) return geo;

  // Majority inward: reverse every triangle and negate the stored normals.
  for ( let t = 0; t < triCount; t++ ) {
    const i = t * 3;
    const tmp = arr[ i ];
    arr[ i ] = arr[ i + 2 ];
    arr[ i + 2 ] = tmp;
  }
  index.needsUpdate = true;

  const nrm = geo.attributes.normal;
  if ( nrm ) {
    for ( let i = 0; i < nrm.count; i++ ) {
      nrm.setXYZ( i, -nrm.getX( i ), -nrm.getY( i ), -nrm.getZ( i ) );
    }
    nrm.needsUpdate = true;
  }
  return geo;
}
