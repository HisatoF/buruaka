/**
 * @file Deterministic, allocation-free collision, queries and ballistics for
 * BURUAKA.
 *
 * Design notes — why this exists instead of a stock physics library:
 *
 * - A squad shooter only ever needs *upright capsules* for actors and
 *   axis-aligned boxes / vertical cylinders for level geometry. Restricting the
 *   shape set that hard turns every narrow-phase test into closed-form algebra
 *   (no GJK, no contact manifolds, no solver iterations), which is what buys us
 *   40 characters + 300 projectiles inside a 16 ms frame in JavaScript.
 * - Characters are *controllers*, not rigid bodies. They never tumble, never
 *   spin, and must feel crisp rather than physical, so the character path is
 *   "integrate, depenetrate, cancel velocity into contacts" instead of an
 *   impulse solver. Depenetration along the minimum translation vector is
 *   exactly collide-and-slide: pushing out along a wall normal leaves the
 *   tangential part of the motion untouched.
 * - Everything is deterministic: no `Math.random`, no time-dependent
 *   heuristics, fixed substeps, and stable iteration order. Two clients feeding
 *   the same inputs get the same world.
 *
 * Conventions: metres, +Y up, radians, seconds. A capsule body's `position` is
 * its **foot point** (the ground contact under the character), which is what
 * the character rig and the animation layer use as their origin.
 *
 * Allocation policy: every function on the hot path writes into caller-supplied
 * out-params or module-scope scratch. Nothing in `step`, `moveCharacter`, the
 * queries or `Ballistics.step` allocates once the pools are warm.
 */

import * as THREE from 'three';

/* --------------------------------------------------------------- layers -- */

/** Level geometry: walls, floors, props. */
export const LAYER_STATIC = 1 << 0;
/** Player-controlled / allied capsules. */
export const LAYER_CHARACTER = 1 << 1;
/** Hostile capsules. */
export const LAYER_ENEMY = 1 << 2;
/** Projectiles, if anything ever needs to query them. */
export const LAYER_PROJECTILE = 1 << 3;
/** Non-blocking volumes (objective zones, damage fields). */
export const LAYER_TRIGGER = 1 << 4;
/** Blocks sight but not movement (foliage, smoke) or vice-versa; free to use. */
export const LAYER_COVER = 1 << 5;
/** Everything. */
export const LAYER_ALL = 0xffffffff;

/** Shape discriminators stored on colliders/bodies. */
export const SHAPE_BOX = 0;
export const SHAPE_CYLINDER = 1;
export const SHAPE_PLANE = 2;
export const SHAPE_CAPSULE = 3;

/* ------------------------------------------------------------- constants -- */

/** Inner integration step. 120 Hz keeps a 10 m/s sprinter to 8 cm per step. */
const FIXED_DT = 1 / 120;
/** Never simulate more than this many substeps in one frame (spiral guard). */
const MAX_SUBSTEPS = 4;
/** Depenetration passes per move. Four resolves any realistic corner. */
const MAX_RESOLVE_PASSES = 4;
/** Penetration below this is ignored — the source of "no jitter". */
const PEN_EPS = 1e-4;
/**
 * Contact skin. A body within this distance of a surface counts as touching, so
 * a resting character keeps its ground contact instead of falling for one
 * substep, re-contacting, and buzzing at the collision epsilon.
 */
const SKIN = 0.01;
/** Ground normals steeper than this are walls, not floors (~50 degrees). */
const DEFAULT_SLOPE_COS = 0.64;

/* --------------------------------------------------------------- scratch -- */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _n0 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3( 0, 1, 0 );

const clamp = ( v, lo, hi ) => ( v < lo ? lo : ( v > hi ? hi : v ) );

/* ------------------------------------------------------------- hit info -- */

/**
 * The result record shared by every query. Queries reuse an internal instance,
 * so **copy anything you intend to keep** — or pass your own `HitInfo` as the
 * out-param.
 */
export class HitInfo {

  constructor() {
    /** @type {boolean} */
    this.hit = false;
    /** @type {THREE.Vector3} world-space contact point */
    this.point = new THREE.Vector3();
    /** @type {THREE.Vector3} unit surface normal, pointing back at the ray */
    this.normal = new THREE.Vector3();
    /** @type {number} distance along the ray, `Infinity` when there is no hit */
    this.distance = Infinity;
    /** @type {object|null} the dynamic body that was hit, if any */
    this.body = null;
    /** @type {object|null} the static collider that was hit, if any */
    this.collider = null;
    /** @type {*} `tag` of whatever was hit */
    this.tag = null;
    /** @type {*} `material` of whatever was hit (surface FX lookups) */
    this.material = null;
  }

  /** Clears back to "no hit". Returns `this` so it can be used inline. */
  reset() {
    this.hit = false;
    this.distance = Infinity;
    this.body = null;
    this.collider = null;
    this.tag = null;
    this.material = null;
    return this;
  }

  /** Deep-copies another record into this one. Allocation free. */
  copy( o ) {
    this.hit = o.hit;
    this.point.copy( o.point );
    this.normal.copy( o.normal );
    this.distance = o.distance;
    this.body = o.body;
    this.collider = o.collider;
    this.tag = o.tag;
    this.material = o.material;
    return this;
  }

}

/* ---------------------------------------------------------- broadphase --- */

/**
 * Uniform grid over the XZ plane.
 *
 * Why 2D and not 3D: arena levels are wide and short. A vertical axis would add
 * a third index whose extent is 2–3 cells, tripling insert cost and cell count
 * for almost no cull win, while a wall inserted by its XZ footprint is already
 * only a handful of cells. Ray traversal is a 2D DDA, which is branch-cheap.
 *
 * Cells hold plain arrays that are emptied with `length = 0` rather than
 * deleted, so a rebuild every substep never touches the allocator.
 */
class UniformGrid {

  /** @param {number} cellSize edge length of a cell, metres */
  constructor( cellSize ) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
    /** @type {Map<number, Array>} */
    this.cells = new Map();
  }

  /** Cell key. Offset keeps indices positive; valid to ±16000 cells. */
  static key( ix, iz ) {
    return ( clamp( ix, -16000, 16000 ) + 16384 ) * 32768 + ( clamp( iz, -16000, 16000 ) + 16384 );
  }

  /** Empties every cell but keeps the arrays for reuse. */
  clear() {
    for ( const arr of this.cells.values() ) arr.length = 0;
  }

  /** Inserts `item` into every cell its XZ footprint touches. */
  insert( minX, minZ, maxX, maxZ, item ) {
    const i0 = Math.floor( minX * this.inv ), i1 = Math.floor( maxX * this.inv );
    const k0 = Math.floor( minZ * this.inv ), k1 = Math.floor( maxZ * this.inv );
    for ( let ix = i0; ix <= i1; ix ++ ) {
      for ( let iz = k0; iz <= k1; iz ++ ) {
        const k = UniformGrid.key( ix, iz );
        let arr = this.cells.get( k );
        if ( arr === undefined ) { arr = []; this.cells.set( k, arr ); }
        arr.push( item );
      }
    }
  }

  /**
   * Appends every item whose cell overlaps the XZ rectangle into `out`,
   * de-duplicated with a monotonically increasing `stamp`.
   */
  gatherAABB( minX, minZ, maxX, maxZ, stamp, out ) {
    const i0 = Math.floor( minX * this.inv ), i1 = Math.floor( maxX * this.inv );
    const k0 = Math.floor( minZ * this.inv ), k1 = Math.floor( maxZ * this.inv );
    for ( let ix = i0; ix <= i1; ix ++ ) {
      for ( let iz = k0; iz <= k1; iz ++ ) {
        const arr = this.cells.get( UniformGrid.key( ix, iz ) );
        if ( arr === undefined ) continue;
        for ( let i = 0, n = arr.length; i < n; i ++ ) {
          const it = arr[ i ];
          if ( it._stamp === stamp ) continue;
          it._stamp = stamp;
          out.push( it );
        }
      }
    }
    return out;
  }

  /**
   * Amanatides–Woo DDA along the XZ projection of a ray. `dx`/`dz` come from a
   * unit direction so `t` is in metres. Vertical rays collapse to one cell.
   */
  gatherRay( ox, oz, dx, dz, maxDist, stamp, out ) {
    const cs = this.cellSize;
    let ix = Math.floor( ox * this.inv );
    let iz = Math.floor( oz * this.inv );
    const stepX = dx > 0 ? 1 : ( dx < 0 ? -1 : 0 );
    const stepZ = dz > 0 ? 1 : ( dz < 0 ? -1 : 0 );
    const adx = Math.abs( dx ), adz = Math.abs( dz );
    const tDeltaX = adx > 1e-9 ? cs / adx : Infinity;
    const tDeltaZ = adz > 1e-9 ? cs / adz : Infinity;
    let tMaxX = adx > 1e-9
      ? ( stepX > 0 ? ( ix + 1 ) * cs - ox : ox - ix * cs ) / adx
      : Infinity;
    let tMaxZ = adz > 1e-9
      ? ( stepZ > 0 ? ( iz + 1 ) * cs - oz : oz - iz * cs ) / adz
      : Infinity;

    let t = 0;
    for ( let guard = 0; guard < 4096; guard ++ ) {
      const arr = this.cells.get( UniformGrid.key( ix, iz ) );
      if ( arr !== undefined ) {
        for ( let i = 0, n = arr.length; i < n; i ++ ) {
          const it = arr[ i ];
          if ( it._stamp === stamp ) continue;
          it._stamp = stamp;
          out.push( it );
        }
      }
      if ( tMaxX < tMaxZ ) {
        t = tMaxX; if ( t > maxDist ) break;
        ix += stepX; tMaxX += tDeltaX;
      } else {
        t = tMaxZ; if ( t > maxDist ) break;
        iz += stepZ; tMaxZ += tDeltaZ;
      }
      if ( ! isFinite( t ) ) break;
    }
    return out;
  }

}

/* ------------------------------------------------------- narrow phase ---- */
/*
 * Every actor capsule is upright, so a capsule is a vertical segment plus a
 * radius. That collapses each test into a 2D problem: the XZ distance to the
 * shape's footprint, and an interval overlap in Y. The results below are exact
 * minimum-translation vectors, not iterative approximations — which is why
 * depenetration converges in one pass for a flat wall and never oscillates.
 */

/** Signed penetration of an upright capsule against an AABB. */
function capsuleBoxMTV( px, py, pz, radius, height, box, outN ) {
  const ay = py + radius;
  const by = py + height - radius;

  // Cheap reject before the algebra.
  if ( px + radius < box.minX || px - radius > box.maxX ) return -1e9;
  if ( pz + radius < box.minZ || pz - radius > box.maxZ ) return -1e9;
  if ( by + radius < box.minY || ay - radius > box.maxY ) return -1e9;

  const qx = clamp( px, box.minX, box.maxX );
  const qz = clamp( pz, box.minZ, box.maxZ );

  let sy, qy;
  if ( by < box.minY ) { sy = by; qy = box.minY; }
  else if ( ay > box.maxY ) { sy = ay; qy = box.maxY; }
  else {
    // Y ranges overlap: the closest pair shares a height, so dy is zero.
    sy = ( Math.max( ay, box.minY ) + Math.min( by, box.maxY ) ) * 0.5;
    qy = sy;
  }

  const dx = px - qx, dy = sy - qy, dz = pz - qz;
  const d2 = dx * dx + dy * dy + dz * dz;

  if ( d2 > 1e-12 ) {
    const d = Math.sqrt( d2 );
    outN.set( dx / d, dy / d, dz / d );
    return radius - d;
  }

  // Spine inside the box — escape through the nearest face.
  let best = box.maxX - px, bx = 1, bY = 0, bz = 0;
  let c = px - box.minX; if ( c < best ) { best = c; bx = -1; bY = 0; bz = 0; }
  c = box.maxY - sy;     if ( c < best ) { best = c; bx = 0; bY = 1; bz = 0; }
  c = sy - box.minY;     if ( c < best ) { best = c; bx = 0; bY = -1; bz = 0; }
  c = box.maxZ - pz;     if ( c < best ) { best = c; bx = 0; bY = 0; bz = 1; }
  c = pz - box.minZ;     if ( c < best ) { best = c; bx = 0; bY = 0; bz = -1; }
  outN.set( bx, bY, bz );
  return radius + best;
}

/** Signed penetration of an upright capsule against an upright cylinder. */
function capsuleCylinderMTV( px, py, pz, radius, height, cyl, outN ) {
  const ay = py + radius;
  const by = py + height - radius;
  const cMinY = cyl.minY, cMaxY = cyl.maxY;

  if ( by + radius < cMinY || ay - radius > cMaxY ) return -1e9;

  let dx = px - cyl.center.x, dz = pz - cyl.center.z;
  const rad = Math.sqrt( dx * dx + dz * dz );
  if ( rad - cyl.radius > radius ) return -1e9;

  // Work in the (radial, y) half-plane: the cylinder becomes a rectangle.
  const qRad = clamp( rad, 0, cyl.radius );
  let sy, qy;
  if ( by < cMinY ) { sy = by; qy = cMinY; }
  else if ( ay > cMaxY ) { sy = ay; qy = cMaxY; }
  else { sy = ( Math.max( ay, cMinY ) + Math.min( by, cMaxY ) ) * 0.5; qy = sy; }

  const dr = rad - qRad, dy = sy - qy;
  const d2 = dr * dr + dy * dy;

  // Radial unit direction; concentric capsules pick +X so the result is stable.
  let ux = 1, uz = 0;
  if ( rad > 1e-9 ) { ux = dx / rad; uz = dz / rad; }

  if ( d2 > 1e-12 ) {
    const d = Math.sqrt( d2 );
    outN.set( ux * ( dr / d ), dy / d, uz * ( dr / d ) );
    return radius - d;
  }

  // Inside: escape radially or through the nearer cap, whichever is shallower.
  const outRad = cyl.radius - rad;
  const outTop = cMaxY - sy;
  const outBot = sy - cMinY;
  if ( outRad <= outTop && outRad <= outBot ) { outN.set( ux, 0, uz ); return radius + outRad; }
  if ( outTop <= outBot ) { outN.set( 0, 1, 0 ); return radius + outTop; }
  outN.set( 0, -1, 0 );
  return radius + outBot;
}

/**
 * Signed penetration between two upright capsules.
 *
 * When their vertical spans overlap — the normal case for two people standing
 * on the same floor — the separation is forced horizontal. Letting a crowd
 * generate vertical pushout is how squads end up climbing each other's heads.
 */
function capsuleCapsuleMTV( a, b, outN ) {
  const dx = a.position.x - b.position.x;
  const dz = a.position.z - b.position.z;
  const rs = a.radius + b.radius;

  const aay = a.position.y + a.radius, aby = a.position.y + a.height - a.radius;
  const bay = b.position.y + b.radius, bby = b.position.y + b.height - b.radius;

  let dy = 0;
  if ( aby < bay ) dy = aby - bay;
  else if ( aay > bby ) dy = aay - bby;

  const horiz2 = dx * dx + dz * dz;
  const d2 = horiz2 + dy * dy;
  if ( d2 > rs * rs ) return -1e9;

  if ( dy === 0 ) {
    // Same slab: horizontal-only separation.
    if ( horiz2 > 1e-12 ) {
      const d = Math.sqrt( horiz2 );
      outN.set( dx / d, 0, dz / d );
      return rs - d;
    }
    // Exactly coincident. Fan them out along a golden-angle direction derived
    // from the body id: deterministic, and a pile-up scatters instead of
    // collapsing onto one axis.
    const ang = a.id * 2.39996322972865332;
    outN.set( Math.cos( ang ), 0, Math.sin( ang ) );
    return rs;
  }

  const d = Math.sqrt( d2 );
  if ( d > 1e-9 ) { outN.set( dx / d, dy / d, dz / d ); return rs - d; }
  outN.set( 0, 1, 0 );
  return rs;
}

/* ---------------------------------------------------------- PhysicsWorld -- */

let _nextId = 1;

/**
 * The collision world: static geometry in a uniform grid, upright capsule
 * bodies, a fixed-substep integrator and a full set of allocation-free queries.
 *
 * @example
 * const world = new PhysicsWorld( { gravity: -22 } );
 * world.addPlane( 0 );
 * world.addBox( new THREE.Vector3( 0, 1.5, 6 ), new THREE.Vector3( 6, 1.5, 0.4 ), { tag: 'wall' } );
 * const hina = world.addCapsule( new THREE.Vector3( 0, 0, 0 ), 0.32, 1.62, { tag: 'hina', mass: 62 } );
 * world.step( dt );
 */
export class PhysicsWorld {

  /**
   * @param {object} [options]
   * @param {number} [options.gravity=-22]  m/s². Games want heavier-than-real.
   * @param {number} [options.cellSize=4]   broadphase cell edge, metres.
   */
  constructor( options = {} ) {
    /** @type {number} */
    this.gravity = options.gravity ?? -22;
    /** @type {number} */
    this.cellSize = options.cellSize ?? 4;

    /** @type {Array<object>} every static collider, in insertion order */
    this.colliders = [];
    /** @type {Array<object>} infinite ground planes (never in the grid) */
    this.planes = [];
    /** @type {Array<object>} every capsule body */
    this.bodies = [];

    this._staticGrid = new UniformGrid( this.cellSize );
    this._dynamicGrid = new UniformGrid( this.cellSize );

    this._acc = 0;
    this._stamp = 0;
    /** Wall-clock-free step counter; useful for replay assertions. */
    this.stepCount = 0;

    // Reused query buffers.
    this._candA = [];
    this._candB = [];
    this._hit = new HitInfo();
    this._hitTmp = new HitInfo();
    this._cover = { inCover: false, quality: 0, coverNormal: new THREE.Vector3() };

    this._resolveIterations = MAX_RESOLVE_PASSES;
    this._coverSamples = 4;
  }

  /**
   * Quality scaling per the engine-wide contract.
   * @param {0|1|2} level 0 = potato, 1 = balanced, 2 = maximum.
   */
  setQuality( level ) {
    this._resolveIterations = level <= 0 ? 2 : ( level === 1 ? 3 : MAX_RESOLVE_PASSES );
    this._coverSamples = level <= 0 ? 2 : ( level === 1 ? 3 : 4 );
  }

  /* -------------------------------------------------- static colliders -- */

  /**
   * Adds an axis-aligned box.
   * @param {THREE.Vector3} center
   * @param {THREE.Vector3} halfExtents
   * @param {object} [opts]
   * @param {*} [opts.tag] gameplay label surfaced on every hit record.
   * @param {*} [opts.material] surface id for impact FX / footstep audio.
   * @param {number} [opts.layer=LAYER_STATIC] bitmask this collider lives on.
   * @returns {object} the collider handle.
   */
  addBox( center, halfExtents, opts = {} ) {
    const c = {
      shape: SHAPE_BOX,
      id: _nextId ++,
      center: new THREE.Vector3().copy( center ),
      half: new THREE.Vector3().copy( halfExtents ),
      minX: center.x - halfExtents.x, maxX: center.x + halfExtents.x,
      minY: center.y - halfExtents.y, maxY: center.y + halfExtents.y,
      minZ: center.z - halfExtents.z, maxZ: center.z + halfExtents.z,
      tag: opts.tag ?? null,
      material: opts.material ?? null,
      layer: opts.layer ?? LAYER_STATIC,
      enabled: true,
      _stamp: -1,
    };
    this.colliders.push( c );
    this._staticGrid.insert( c.minX, c.minZ, c.maxX, c.maxZ, c );
    return c;
  }

  /**
   * Adds a Y-aligned cylinder (pillars, barrels, silos).
   * @param {THREE.Vector3} center centre of the cylinder, not its base.
   * @param {number} radius
   * @param {number} height full height.
   * @param {object} [opts] same options as {@link PhysicsWorld#addBox}.
   * @returns {object} the collider handle.
   */
  addCylinder( center, radius, height, opts = {} ) {
    const c = {
      shape: SHAPE_CYLINDER,
      id: _nextId ++,
      center: new THREE.Vector3().copy( center ),
      radius,
      height,
      minY: center.y - height * 0.5,
      maxY: center.y + height * 0.5,
      minX: center.x - radius, maxX: center.x + radius,
      minZ: center.z - radius, maxZ: center.z + radius,
      tag: opts.tag ?? null,
      material: opts.material ?? null,
      layer: opts.layer ?? LAYER_STATIC,
      enabled: true,
      _stamp: -1,
    };
    this.colliders.push( c );
    this._staticGrid.insert( c.minX, c.minZ, c.maxX, c.maxZ, c );
    return c;
  }

  /**
   * Adds an infinite horizontal plane. Planes bypass the broadphase entirely —
   * they are in every cell by definition, so gridding them would only pollute
   * candidate lists.
   * @param {number} y
   * @param {object} [opts] same options as {@link PhysicsWorld#addBox}.
   * @returns {object} the collider handle.
   */
  addPlane( y, opts = {} ) {
    const c = {
      shape: SHAPE_PLANE,
      id: _nextId ++,
      y,
      tag: opts.tag ?? 'ground',
      material: opts.material ?? null,
      layer: opts.layer ?? LAYER_STATIC,
      enabled: true,
      _stamp: -1,
    };
    this.planes.push( c );
    this.colliders.push( c );
    return c;
  }

  /**
   * Removes a static collider and rebuilds the grid. Level-edit time only —
   * this allocates.
   * @param {object} collider
   */
  removeCollider( collider ) {
    let i = this.colliders.indexOf( collider );
    if ( i >= 0 ) this.colliders.splice( i, 1 );
    i = this.planes.indexOf( collider );
    if ( i >= 0 ) this.planes.splice( i, 1 );
    this.rebuildStatic();
  }

  /** Re-inserts every static collider. Call after mutating collider bounds. */
  rebuildStatic() {
    this._staticGrid.clear();
    for ( let i = 0; i < this.colliders.length; i ++ ) {
      const c = this.colliders[ i ];
      if ( c.shape === SHAPE_PLANE || ! c.enabled ) continue;
      this._staticGrid.insert( c.minX, c.minZ, c.maxX, c.maxZ, c );
    }
  }

  /* --------------------------------------------------- dynamic bodies -- */

  /**
   * Adds an upright capsule body — the shape every character uses.
   *
   * @param {THREE.Vector3} position **foot** position (ground point).
   * @param {number} radius
   * @param {number} height total height including both caps; clamped to `2*radius`.
   * @param {object} [opts]
   * @param {*} [opts.tag]
   * @param {number} [opts.mass=60] kilograms; `0` or less means immovable.
   * @param {*} [opts.userData] free slot for the gameplay layer.
   * @param {number} [opts.layer=LAYER_CHARACTER]
   * @param {number} [opts.collisionMask] what this body collides with.
   * @param {boolean} [opts.useGravity=true]
   * @param {boolean} [opts.kinematic=false] skip integration; driven by `moveCharacter`.
   * @param {number} [opts.stepHeight=0.3] max ledge the controller walks up.
   * @param {number} [opts.snapDistance=0.35] downward stick-to-ground range.
   * @returns {object} the body handle.
   */
  addCapsule( position, radius, height, opts = {} ) {
    const h = Math.max( height, radius * 2 );
    const mass = opts.mass ?? 60;
    const body = {
      shape: SHAPE_CAPSULE,
      id: _nextId ++,
      position: new THREE.Vector3().copy( position ),
      velocity: new THREE.Vector3(),
      radius,
      height: h,
      tag: opts.tag ?? null,
      material: opts.material ?? null,
      layer: opts.layer ?? LAYER_CHARACTER,
      collisionMask: opts.collisionMask ?? ( LAYER_STATIC | LAYER_CHARACTER | LAYER_ENEMY ),
      mass,
      invMass: mass > 0 ? 1 / mass : 0,
      userData: opts.userData ?? null,
      useGravity: opts.useGravity ?? true,
      kinematic: opts.kinematic ?? false,
      enabled: true,
      /** @type {boolean} true while standing on a walkable surface */
      grounded: false,
      /** @type {THREE.Vector3} normal of the surface underfoot */
      groundNormal: new THREE.Vector3( 0, 1, 0 ),
      /** @type {boolean} true when the last move was stopped by a wall */
      blocked: false,
      slopeCos: opts.slopeCos ?? DEFAULT_SLOPE_COS,
      stepHeight: opts.stepHeight ?? 0.3,
      snapDistance: opts.snapDistance ?? 0.35,
      /** @type {HitReaction|null} filled in by {@link PhysicsWorld#applyImpulse} */
      hitReaction: null,
      _wasGrounded: false,
      _stamp: -1,
    };
    this.bodies.push( body );
    return body;
  }

  /** Removes a body. Safe to call from a hit callback. */
  removeBody( body ) {
    const i = this.bodies.indexOf( body );
    if ( i >= 0 ) this.bodies.splice( i, 1 );
  }

  /** Teleports a body, clearing its velocity and contact state. */
  teleport( body, position ) {
    body.position.copy( position );
    body.velocity.set( 0, 0, 0 );
    body.grounded = false;
    body._wasGrounded = false;
    body.blocked = false;
  }

  /**
   * Writes the capsule's spine endpoints into `outA`/`outB`.
   * @returns {THREE.Vector3} `outA`
   */
  getSpine( body, outA, outB ) {
    outA.set( body.position.x, body.position.y + body.radius, body.position.z );
    outB.set( body.position.x, body.position.y + body.height - body.radius, body.position.z );
    return outA;
  }

  /** Approximate eye/aim height for a body — used by AI vision and cover. */
  getEyePoint( body, out ) {
    return out.set( body.position.x, body.position.y + body.height * 0.88, body.position.z );
  }

  /** Refreshes the dynamic broadphase. Called once per substep. */
  _rebuildDynamicGrid() {
    const g = this._dynamicGrid;
    g.clear();
    for ( let i = 0; i < this.bodies.length; i ++ ) {
      const b = this.bodies[ i ];
      if ( ! b.enabled ) continue;
      const r = b.radius;
      g.insert( b.position.x - r, b.position.z - r, b.position.x + r, b.position.z + r, b );
    }
  }

  /* ------------------------------------------------------------- step -- */

  /**
   * Advances the world by `dt` seconds using a fixed 1/120 s inner step and an
   * accumulator. Fast movers therefore never tunnel regardless of frame rate,
   * and the simulation is frame-rate independent: 2 frames at 1/30 produce the
   * same state as 4 frames at 1/60.
   *
   * @param {number} dt seconds since the last call. Clamped to 0.25.
   */
  step( dt ) {
    if ( ! ( dt > 0 ) ) return;
    this._acc += Math.min( dt, 0.25 );
    let n = 0;
    while ( this._acc >= FIXED_DT && n < MAX_SUBSTEPS ) {
      this._substep( FIXED_DT );
      this._acc -= FIXED_DT;
      n ++;
    }
    // Ran out of budget: drop the backlog rather than spiral into it.
    if ( n === MAX_SUBSTEPS && this._acc > FIXED_DT ) this._acc = 0;
  }

  /** One fixed inner step. @private */
  _substep( h ) {
    this.stepCount ++;
    this._rebuildDynamicGrid();

    const g = this.gravity * h;
    for ( let i = 0; i < this.bodies.length; i ++ ) {
      const b = this.bodies[ i ];
      if ( ! b.enabled || b.kinematic ) continue;
      if ( b.useGravity ) b.velocity.y += g;
      _v0.copy( b.velocity ).multiplyScalar( h );
      this.moveCharacter( b, _v0, true );
    }

    this._separateBodies();

    for ( let i = 0; i < this.bodies.length; i ++ ) {
      const b = this.bodies[ i ];
      if ( b.hitReaction !== null ) b.hitReaction.update( h );
    }
  }

  /**
   * Moves a capsule by `desiredDelta` with collide-and-slide.
   *
   * The slide falls out of minimum-translation depenetration: pushing the
   * capsule back along a wall's normal removes exactly the normal component of
   * the motion and leaves the tangential component intact. Iterating that (up
   * to four passes) resolves corners and wedges. Because a correction is only
   * applied when the overlap exceeds `PEN_EPS`, and because contacts within a
   * 1 cm skin still cancel velocity, a character pressed into a wall reaches a
   * fixed point and stays there instead of buzzing.
   *
   * Also performs a step-up trial (default 0.3 m) when a wall blocks horizontal
   * motion, and snaps to the ground when it was grounded last step, so walking
   * down stairs doesn't launch the character into a fall.
   *
   * @param {object} body handle from {@link PhysicsWorld#addCapsule}.
   * @param {THREE.Vector3} desiredDelta world-space displacement for this step.
   * @param {boolean} [cancelVelocity=true] zero the body's velocity into contacts.
   */
  moveCharacter( body, desiredDelta, cancelVelocity = true ) {
    const startX = body.position.x, startY = body.position.y, startZ = body.position.z;
    body._wasGrounded = body.grounded;
    body.grounded = false;
    body.blocked = false;

    body.position.x += desiredDelta.x;
    body.position.y += desiredDelta.y;
    body.position.z += desiredDelta.z;
    this._resolve( body, cancelVelocity );

    const wantX = desiredDelta.x, wantZ = desiredDelta.z;
    const wantLen = Math.sqrt( wantX * wantX + wantZ * wantZ );

    if ( body.blocked && body.stepHeight > 0 && wantLen > 1e-5 ) {
      const dxn = wantX / wantLen, dzn = wantZ / wantLen;
      // Bank the slide result so a failed step-up costs nothing.
      const sx = body.position.x, sy = body.position.y, sz = body.position.z;
      const sGrounded = body.grounded, sBlocked = body.blocked;
      _n1.copy( body.groundNormal );
      _v6.copy( body.velocity );
      const slideProgress = ( sx - startX ) * dxn + ( sz - startZ ) * dzn;

      // Lift, move, then fall back onto whatever is under the new spot.
      body.position.set( startX, startY + body.stepHeight, startZ );
      this._resolve( body, false );
      body.position.x += wantX;
      body.position.z += wantZ;
      this._resolve( body, false );
      body.position.y -= body.stepHeight + 0.02;
      this._resolve( body, false );

      const stepProgress = ( body.position.x - startX ) * dxn + ( body.position.z - startZ ) * dzn;
      const accept = body.grounded &&
        stepProgress > slideProgress + 1e-4 &&
        body.position.y <= startY + body.stepHeight + 1e-3;

      if ( accept ) {
        body.blocked = false;
        if ( cancelVelocity && body.velocity.y < 0 ) body.velocity.y = 0;
      } else {
        body.position.set( sx, sy, sz );
        body.grounded = sGrounded;
        body.blocked = sBlocked;
        body.groundNormal.copy( _n1 );
        body.velocity.copy( _v6 );
      }
    }

    if ( ! body.grounded && body._wasGrounded && desiredDelta.y <= 1e-6 && body.snapDistance > 0 ) {
      const sx = body.position.x, sy = body.position.y, sz = body.position.z;
      body.position.y -= body.snapDistance;
      this._resolve( body, false );
      if ( ! body.grounded ) body.position.set( sx, sy, sz );
      else if ( cancelVelocity && body.velocity.y < 0 ) body.velocity.y = 0;
    }
  }

  /**
   * Iterative depenetration against static geometry and other capsules.
   * Updates `body.grounded`, `body.groundNormal` and `body.blocked`.
   * @private
   */
  _resolve( body, cancelVelocity ) {
    const passes = this._resolveIterations;
    const mask = body.collisionMask;
    const r = body.radius;

    for ( let pass = 0; pass < passes; pass ++ ) {
      let corrected = false;

      // --- infinite planes -------------------------------------------------
      for ( let i = 0; i < this.planes.length; i ++ ) {
        const p = this.planes[ i ];
        if ( ! p.enabled || ( p.layer & mask ) === 0 ) continue;
        const depth = p.y - body.position.y;
        if ( depth <= -SKIN ) continue;
        _n0.set( 0, 1, 0 );
        if ( this._contact( body, _n0, depth, p, cancelVelocity, false ) ) corrected = true;
      }

      // --- static colliders ------------------------------------------------
      const cand = this._candA;
      cand.length = 0;
      const pad = r + SKIN;
      this._staticGrid.gatherAABB(
        body.position.x - pad, body.position.z - pad,
        body.position.x + pad, body.position.z + pad,
        ++ this._stamp, cand,
      );
      for ( let i = 0; i < cand.length; i ++ ) {
        const c = cand[ i ];
        if ( ! c.enabled || ( c.layer & mask ) === 0 ) continue;
        const depth = c.shape === SHAPE_BOX
          ? capsuleBoxMTV( body.position.x, body.position.y, body.position.z, r, body.height, c, _n0 )
          : capsuleCylinderMTV( body.position.x, body.position.y, body.position.z, r, body.height, c, _n0 );
        if ( depth <= -SKIN ) continue;
        if ( this._contact( body, _n0, depth, c, cancelVelocity, false ) ) corrected = true;
      }

      // --- other capsules --------------------------------------------------
      const dyn = this._candB;
      dyn.length = 0;
      this._dynamicGrid.gatherAABB(
        body.position.x - pad, body.position.z - pad,
        body.position.x + pad, body.position.z + pad,
        ++ this._stamp, dyn,
      );
      for ( let i = 0; i < dyn.length; i ++ ) {
        const o = dyn[ i ];
        if ( o === body || ! o.enabled || ( o.layer & mask ) === 0 ) continue;
        const depth = capsuleCapsuleMTV( body, o, _n0 );
        if ( depth <= PEN_EPS ) continue;
        // Mass-weighted: the heavier body barely gives ground.
        const sum = body.invMass + o.invMass;
        const wa = sum > 0 ? body.invMass / sum : 1;
        body.position.addScaledVector( _n0, depth * wa );
        if ( wa < 1 ) o.position.addScaledVector( _n0, -depth * ( 1 - wa ) );
        if ( cancelVelocity ) {
          const vn = body.velocity.dot( _n0 );
          if ( vn < 0 ) body.velocity.addScaledVector( _n0, -vn );
        }
        corrected = true;
      }

      if ( ! corrected ) break;
    }
  }

  /**
   * Applies one contact: records ground/wall state, cancels velocity into the
   * normal and pushes out (or seats down, for floors within the skin).
   * @returns {boolean} true when the position actually moved.
   * @private
   */
  _contact( body, n, depth, source, cancelVelocity, isDynamic ) {
    const upness = n.y;

    if ( upness >= body.slopeCos ) {
      body.grounded = true;
      body.groundNormal.copy( n );
    } else if ( Math.abs( upness ) < 0.7 && depth > PEN_EPS && ! isDynamic ) {
      body.blocked = true;
    }

    if ( cancelVelocity ) {
      const vn = body.velocity.dot( n );
      if ( vn < 0 ) body.velocity.addScaledVector( n, -vn );
    }

    // Positive depth = overlap, push out. Small negative depth on a floor =
    // hovering inside the skin, so seat the capsule down onto exact contact.
    // Doing that for walls too would suck characters sideways into geometry.
    const apply = depth > PEN_EPS || ( depth < -PEN_EPS && upness >= body.slopeCos );
    if ( ! apply ) return false;
    body.position.addScaledVector( n, depth );
    return true;
  }

  /**
   * Global capsule-vs-capsule relaxation. Runs after every body has moved so a
   * squad funnelling through a doorway settles symmetrically; resolving crowd
   * overlap only inside each body's own move makes the last mover win and the
   * group shear.
   * @private
   */
  _separateBodies() {
    const bodies = this.bodies;
    for ( let iter = 0; iter < 2; iter ++ ) {
      for ( let i = 0; i < bodies.length; i ++ ) {
        const a = bodies[ i ];
        if ( ! a.enabled ) continue;
        const cand = this._candB;
        cand.length = 0;
        const pad = a.radius + 1.2;
        this._dynamicGrid.gatherAABB(
          a.position.x - pad, a.position.z - pad,
          a.position.x + pad, a.position.z + pad,
          ++ this._stamp, cand,
        );
        for ( let j = 0; j < cand.length; j ++ ) {
          const b = cand[ j ];
          // id ordering makes each pair resolve exactly once per iteration.
          if ( b === a || ! b.enabled || b.id <= a.id ) continue;
          if ( ( b.layer & a.collisionMask ) === 0 ) continue;
          const depth = capsuleCapsuleMTV( a, b, _n0 );
          if ( depth <= PEN_EPS ) continue;
          const sum = a.invMass + b.invMass;
          if ( sum <= 0 ) continue;
          const wa = a.invMass / sum;
          a.position.addScaledVector( _n0, depth * wa );
          b.position.addScaledVector( _n0, -depth * ( 1 - wa ) );
        }
      }
    }
    // The relaxation can shove a body a few millimetres into a wall; one cheap
    // static-only pass puts everyone back outside the level.
    for ( let i = 0; i < bodies.length; i ++ ) {
      const b = bodies[ i ];
      if ( b.enabled && ! b.kinematic ) this._resolveStaticOnly( b );
    }
  }

  /** Single-pass static depenetration used to clean up after crowd pushout. @private */
  _resolveStaticOnly( body ) {
    const mask = body.collisionMask;
    const r = body.radius;
    for ( let i = 0; i < this.planes.length; i ++ ) {
      const p = this.planes[ i ];
      if ( ! p.enabled || ( p.layer & mask ) === 0 ) continue;
      const depth = p.y - body.position.y;
      if ( depth > PEN_EPS ) body.position.y += depth;
    }
    const cand = this._candA;
    cand.length = 0;
    const pad = r + SKIN;
    this._staticGrid.gatherAABB(
      body.position.x - pad, body.position.z - pad,
      body.position.x + pad, body.position.z + pad,
      ++ this._stamp, cand,
    );
    for ( let i = 0; i < cand.length; i ++ ) {
      const c = cand[ i ];
      if ( ! c.enabled || ( c.layer & mask ) === 0 ) continue;
      const depth = c.shape === SHAPE_BOX
        ? capsuleBoxMTV( body.position.x, body.position.y, body.position.z, r, body.height, c, _n0 )
        : capsuleCylinderMTV( body.position.x, body.position.y, body.position.z, r, body.height, c, _n0 );
      if ( depth > PEN_EPS ) body.position.addScaledVector( _n0, depth );
    }
  }

  /* ---------------------------------------------------------- impulses -- */

  /**
   * Applies an instantaneous impulse (kg·m/s) to a body, and — when a contact
   * point is supplied — seeds the body's {@link HitReaction} so the rig can
   * play a directional flinch. Characters are controllers, not rigid bodies, so
   * the "torque" is deliberately fake: it becomes a decaying tilt curve rather
   * than real angular momentum.
   *
   * @param {object} body
   * @param {THREE.Vector3} impulse world-space impulse.
   * @param {THREE.Vector3} [point] world-space point of application.
   * @returns {object} the body.
   */
  applyImpulse( body, impulse, point ) {
    return applyImpulse( body, impulse, point );
  }

  /* ------------------------------------------------------------- cover -- */

  /**
   * Evaluates how well `position` is protected from `threatPosition` by
   * sampling rays at several body heights toward the threat's aim point.
   *
   * Low samples are weighted highest: a crate that blocks the legs and torso is
   * real cover even though the head is exposed, while something that only
   * blocks the head is not cover at all.
   *
   * @param {THREE.Vector3} position foot position of the character taking cover.
   * @param {THREE.Vector3} threatPosition foot position of the shooter.
   * @param {number} [mask=LAYER_STATIC] what counts as cover.
   * @returns {{inCover: boolean, quality: number, coverNormal: THREE.Vector3}}
   *   a reused struct — copy it if you need to keep it.
   */
  evaluateCover( position, threatPosition, mask = LAYER_STATIC ) {
    const out = this._cover;
    out.inCover = false;
    out.quality = 0;
    out.coverNormal.set( 0, 0, 0 );

    // Sample heights from shin to head, and the weight each one carries.
    const heights = COVER_HEIGHTS;
    const weights = COVER_WEIGHTS;
    const count = Math.min( this._coverSamples, heights.length );

    let total = 0, blocked = 0;
    _v4.set( threatPosition.x, threatPosition.y + 1.4, threatPosition.z );

    for ( let i = 0; i < count; i ++ ) {
      const w = weights[ i ];
      total += w;
      _v3.set( position.x, position.y + heights[ i ], position.z );
      _dir.subVectors( _v4, _v3 );
      const dist = _dir.length();
      if ( dist < 1e-5 ) continue;
      _dir.multiplyScalar( 1 / dist );
      const h = this.raycast( _v3, _dir, dist, mask, this._hitTmp );
      if ( h.hit ) {
        blocked += w;
        out.coverNormal.add( h.normal );
      }
    }

    out.quality = total > 0 ? blocked / total : 0;
    // Half the weighted body blocked is the threshold where peeking beats
    // standing — matches the crouch-behind-a-crate case exactly.
    out.inCover = out.quality >= 0.5;
    if ( out.coverNormal.lengthSq() > 1e-12 ) out.coverNormal.normalize();
    else out.coverNormal.set( 0, 0, 0 );
    return out;
  }

  /* ----------------------------------------------------------- queries -- */

  /**
   * Casts a ray against static geometry and capsule bodies.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} direction unit vector (normalised defensively).
   * @param {number} [maxDist=Infinity]
   * @param {number} [mask=LAYER_ALL]
   * @param {HitInfo} [out] destination; defaults to a shared internal record
   *   that the next query will overwrite.
   * @param {object} [ignoreBody] a body to skip (the shooter, usually).
   * @returns {HitInfo} `{ hit, point, normal, distance, body, tag, ... }`
   */
  raycast( origin, direction, maxDist = Infinity, mask = LAYER_ALL, out = this._hit, ignoreBody = null ) {
    return this._cast( origin, direction, 0, maxDist, mask, out, ignoreBody );
  }

  /**
   * Casts a sphere of `radius` — a projectile with girth. Fat casts stop
   * bullets from threading a hairline gap between two crates, and they give
   * grenades a believable contact point.
   *
   * The Minkowski sums are slightly conservative at box corners and cylinder
   * rims (a rounded shape is approximated by a swept sphere), which makes the
   * cast hit a hair early rather than late — the safe direction for a shooter.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} direction unit vector.
   * @param {number} radius
   * @param {number} [maxDist=Infinity]
   * @param {number} [mask=LAYER_ALL]
   * @param {HitInfo} [out]
   * @param {object} [ignoreBody]
   * @returns {HitInfo}
   */
  spherecast( origin, direction, radius, maxDist = Infinity, mask = LAYER_ALL, out = this._hit, ignoreBody = null ) {
    return this._cast( origin, direction, radius, maxDist, mask, out, ignoreBody );
  }

  /**
   * Shared ray / sphere cast. `radius === 0` is the plain ray path.
   * @private
   */
  _cast( origin, direction, radius, maxDist, mask, out, ignoreBody ) {
    out.reset();
    const far = isFinite( maxDist ) ? maxDist : 1e6;
    if ( far <= 0 ) return out;

    _dir.copy( direction );
    const dl2 = _dir.lengthSq();
    if ( dl2 < 1e-12 ) return out;
    if ( Math.abs( dl2 - 1 ) > 1e-6 ) _dir.multiplyScalar( 1 / Math.sqrt( dl2 ) );

    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = _dir.x, dy = _dir.y, dz = _dir.z;
    let best = far;

    // --- planes ------------------------------------------------------------
    for ( let i = 0; i < this.planes.length; i ++ ) {
      const p = this.planes[ i ];
      if ( ! p.enabled || ( p.layer & mask ) === 0 ) continue;
      if ( Math.abs( dy ) < 1e-9 ) continue;
      const above = oy > p.y;
      const t = ( p.y + ( above ? radius : -radius ) - oy ) / dy;
      if ( t < 0 || t >= best ) continue;
      best = t;
      out.hit = true;
      out.normal.set( 0, above ? 1 : -1, 0 );
      out.collider = p; out.body = null; out.tag = p.tag; out.material = p.material;
    }

    // --- static colliders --------------------------------------------------
    const cand = this._candA;
    cand.length = 0;
    this._gatherAlong( this._staticGrid, ox, oz, dx, dz, far, radius, cand );
    for ( let i = 0; i < cand.length; i ++ ) {
      const c = cand[ i ];
      if ( ! c.enabled || ( c.layer & mask ) === 0 ) continue;
      let t = -1;
      if ( c.shape === SHAPE_BOX ) {
        t = rayAABB( ox, oy, oz, dx, dy, dz,
          c.minX - radius, c.minY - radius, c.minZ - radius,
          c.maxX + radius, c.maxY + radius, c.maxZ + radius, best, _n0 );
        if ( t >= 0 && radius > 0 ) {
          // Refine: the expanded AABB rounds off at corners, so re-derive the
          // normal from the closest point on the *real* box.
          const hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t;
          const qx = clamp( hx, c.minX, c.maxX );
          const qy = clamp( hy, c.minY, c.maxY );
          const qz = clamp( hz, c.minZ, c.maxZ );
          const ex = hx - qx, ey = hy - qy, ez = hz - qz;
          const l2 = ex * ex + ey * ey + ez * ez;
          if ( l2 > 1e-10 ) {
            const l = Math.sqrt( l2 );
            _n0.set( ex / l, ey / l, ez / l );
          }
        }
      } else {
        t = rayVerticalCapsule( ox, oy, oz, dx, dy, dz,
          c.center.x, c.center.z, c.minY, c.maxY, c.radius + radius, best, _n0 );
      }
      if ( t < 0 || t >= best ) continue;
      best = t;
      out.hit = true;
      out.normal.copy( _n0 );
      out.collider = c; out.body = null; out.tag = c.tag; out.material = c.material;
    }

    // --- capsule bodies ----------------------------------------------------
    const dyn = this._candB;
    dyn.length = 0;
    this._gatherAlong( this._dynamicGrid, ox, oz, dx, dz, far, radius, dyn );
    for ( let i = 0; i < dyn.length; i ++ ) {
      const b = dyn[ i ];
      if ( b === ignoreBody || ! b.enabled || ( b.layer & mask ) === 0 ) continue;
      const t = rayVerticalCapsule( ox, oy, oz, dx, dy, dz,
        b.position.x, b.position.z,
        b.position.y + b.radius, b.position.y + b.height - b.radius,
        b.radius + radius, best, _n0 );
      if ( t < 0 || t >= best ) continue;
      best = t;
      out.hit = true;
      out.normal.copy( _n0 );
      out.body = b; out.collider = null; out.tag = b.tag; out.material = b.material;
    }

    if ( out.hit ) {
      out.distance = best;
      out.point.set( ox + dx * best, oy + dy * best, oz + dz * best );
      if ( radius > 0 ) out.point.addScaledVector( out.normal, -radius );
    }
    return out;
  }

  /**
   * Collects broadphase candidates along a cast. A fat cast walks three
   * parallel DDAs (centre and ±radius sideways) so a sphere clipping the corner
   * of a neighbouring cell is still considered; the stamp de-dupes them.
   * @private
   */
  _gatherAlong( grid, ox, oz, dx, dz, far, radius, out ) {
    const stamp = ++ this._stamp;
    grid.gatherRay( ox, oz, dx, dz, far, stamp, out );
    if ( radius <= 0 ) return out;
    const hl = Math.sqrt( dx * dx + dz * dz );
    if ( hl < 1e-9 ) {
      // Straight up or down: widen to the footprint of the sphere instead.
      grid.gatherAABB( ox - radius, oz - radius, ox + radius, oz + radius, stamp, out );
      return out;
    }
    const px = -dz / hl * radius, pz = dx / hl * radius;
    grid.gatherRay( ox + px, oz + pz, dx, dz, far, stamp, out );
    grid.gatherRay( ox - px, oz - pz, dx, dz, far, stamp, out );
    return out;
  }

  /**
   * Collects everything overlapping a sphere — explosions, skill AoE, melee
   * sweeps.
   *
   * @param {THREE.Vector3} center
   * @param {number} radius
   * @param {number} [mask=LAYER_CHARACTER|LAYER_ENEMY]
   * @param {Array} outArray cleared and filled with body/collider handles.
   * @returns {Array} `outArray`
   */
  overlapSphere( center, radius, mask = ( LAYER_CHARACTER | LAYER_ENEMY ), outArray ) {
    outArray.length = 0;

    for ( let i = 0; i < this.planes.length; i ++ ) {
      const p = this.planes[ i ];
      if ( ! p.enabled || ( p.layer & mask ) === 0 ) continue;
      if ( Math.abs( center.y - p.y ) <= radius ) outArray.push( p );
    }

    const cand = this._candA;
    cand.length = 0;
    this._staticGrid.gatherAABB(
      center.x - radius, center.z - radius, center.x + radius, center.z + radius,
      ++ this._stamp, cand,
    );
    for ( let i = 0; i < cand.length; i ++ ) {
      const c = cand[ i ];
      if ( ! c.enabled || ( c.layer & mask ) === 0 ) continue;
      if ( c.shape === SHAPE_BOX ) {
        const qx = clamp( center.x, c.minX, c.maxX );
        const qy = clamp( center.y, c.minY, c.maxY );
        const qz = clamp( center.z, c.minZ, c.maxZ );
        const ex = center.x - qx, ey = center.y - qy, ez = center.z - qz;
        if ( ex * ex + ey * ey + ez * ez <= radius * radius ) outArray.push( c );
      } else {
        const ex = center.x - c.center.x, ez = center.z - c.center.z;
        const rad = Math.sqrt( ex * ex + ez * ez );
        const dr = Math.max( 0, rad - c.radius );
        const dy = center.y < c.minY ? c.minY - center.y : ( center.y > c.maxY ? center.y - c.maxY : 0 );
        if ( dr * dr + dy * dy <= radius * radius ) outArray.push( c );
      }
    }

    const dyn = this._candB;
    dyn.length = 0;
    this._dynamicGrid.gatherAABB(
      center.x - radius, center.z - radius, center.x + radius, center.z + radius,
      ++ this._stamp, dyn,
    );
    for ( let i = 0; i < dyn.length; i ++ ) {
      const b = dyn[ i ];
      if ( ! b.enabled || ( b.layer & mask ) === 0 ) continue;
      const ay = b.position.y + b.radius, by = b.position.y + b.height - b.radius;
      const cy = clamp( center.y, ay, by );
      const ex = center.x - b.position.x, ey = center.y - cy, ez = center.z - b.position.z;
      const rr = radius + b.radius;
      if ( ex * ex + ey * ey + ez * ez <= rr * rr ) outArray.push( b );
    }

    return outArray;
  }

  /**
   * Everything inside a view cone. Used for AI vision — call
   * {@link PhysicsWorld#lineOfSight} on the results if occlusion matters.
   *
   * A target counts as visible when *any* part of its capsule enters the cone,
   * not just its centre, so a character edging around a corner is spotted at
   * the moment their shoulder appears.
   *
   * @param {THREE.Vector3} origin the observer's eye point.
   * @param {THREE.Vector3} forward unit facing vector.
   * @param {number} angleRad **half**-angle of the cone.
   * @param {number} range
   * @param {number} [mask=LAYER_CHARACTER|LAYER_ENEMY]
   * @param {Array} outArray cleared and filled.
   * @returns {Array} `outArray`
   */
  queryCone( origin, forward, angleRad, range, mask = ( LAYER_CHARACTER | LAYER_ENEMY ), outArray ) {
    outArray.length = 0;
    _v5.copy( forward );
    if ( _v5.lengthSq() < 1e-12 ) return outArray;
    _v5.normalize();

    const dyn = this._candB;
    dyn.length = 0;
    this._dynamicGrid.gatherAABB(
      origin.x - range, origin.z - range, origin.x + range, origin.z + range,
      ++ this._stamp, dyn,
    );
    for ( let i = 0; i < dyn.length; i ++ ) {
      const b = dyn[ i ];
      if ( ! b.enabled || ( b.layer & mask ) === 0 ) continue;
      _v3.set( b.position.x, b.position.y + b.height * 0.5, b.position.z ).sub( origin );
      const dist = _v3.length();
      if ( dist > range + b.radius ) continue;
      if ( dist < 1e-5 ) { outArray.push( b ); continue; }
      _v3.multiplyScalar( 1 / dist );
      const ang = Math.acos( clamp( _v3.dot( _v5 ), -1, 1 ) );
      const slack = Math.asin( Math.min( 1, b.radius / Math.max( dist, b.radius ) ) );
      if ( ang - slack <= angleRad ) outArray.push( b );
    }

    if ( ( mask & LAYER_STATIC ) !== 0 || ( mask & LAYER_COVER ) !== 0 ) {
      const cand = this._candA;
      cand.length = 0;
      this._staticGrid.gatherAABB(
        origin.x - range, origin.z - range, origin.x + range, origin.z + range,
        ++ this._stamp, cand,
      );
      for ( let i = 0; i < cand.length; i ++ ) {
        const c = cand[ i ];
        if ( ! c.enabled || ( c.layer & mask ) === 0 ) continue;
        _v3.copy( c.center ).sub( origin );
        const dist = _v3.length();
        if ( dist > range || dist < 1e-5 ) continue;
        _v3.multiplyScalar( 1 / dist );
        if ( Math.acos( clamp( _v3.dot( _v5 ), -1, 1 ) ) <= angleRad ) outArray.push( c );
      }
    }

    return outArray;
  }

  /**
   * True when nothing on `mask` blocks the segment `a → b`. The workhorse of
   * the AI and cover systems.
   *
   * @param {THREE.Vector3} a
   * @param {THREE.Vector3} b
   * @param {number} [mask=LAYER_STATIC]
   * @param {object} [ignoreBody]
   * @returns {boolean}
   */
  lineOfSight( a, b, mask = LAYER_STATIC, ignoreBody = null ) {
    _v2.subVectors( b, a );
    const dist = _v2.length();
    if ( dist < 1e-6 ) return true;
    _v2.multiplyScalar( 1 / dist );
    // Pull in slightly at both ends so touching the surface you stand on or
    // hug doesn't read as an occluder.
    const h = this._cast( a, _v2, 0, dist - 1e-3, mask, this._hitTmp, ignoreBody );
    return ! h.hit;
  }

}

/* ------------------------------------------------- ray primitives -------- */

/** Cover sample heights (metres above the foot) and their weights. */
const COVER_HEIGHTS = [ 0.30, 0.80, 1.25, 1.55 ];
const COVER_WEIGHTS = [ 0.34, 0.30, 0.22, 0.14 ];

/**
 * Slab test. Returns the entry distance and writes the face normal, or `-1`.
 * A ray starting inside returns 0 with the normal facing back along the ray.
 */
function rayAABB( ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, maxDist, outN ) {
  let tmin = 0, tmax = maxDist, axis = -1, sign = 0;

  if ( Math.abs( dx ) < 1e-9 ) { if ( ox < minX || ox > maxX ) return -1; }
  else {
    const inv = 1 / dx;
    let t1 = ( minX - ox ) * inv, t2 = ( maxX - ox ) * inv;
    const s = dx > 0 ? -1 : 1;
    if ( t1 > t2 ) { const tt = t1; t1 = t2; t2 = tt; }
    if ( t1 > tmin ) { tmin = t1; axis = 0; sign = s; }
    if ( t2 < tmax ) tmax = t2;
    if ( tmin > tmax ) return -1;
  }
  if ( Math.abs( dy ) < 1e-9 ) { if ( oy < minY || oy > maxY ) return -1; }
  else {
    const inv = 1 / dy;
    let t1 = ( minY - oy ) * inv, t2 = ( maxY - oy ) * inv;
    const s = dy > 0 ? -1 : 1;
    if ( t1 > t2 ) { const tt = t1; t1 = t2; t2 = tt; }
    if ( t1 > tmin ) { tmin = t1; axis = 1; sign = s; }
    if ( t2 < tmax ) tmax = t2;
    if ( tmin > tmax ) return -1;
  }
  if ( Math.abs( dz ) < 1e-9 ) { if ( oz < minZ || oz > maxZ ) return -1; }
  else {
    const inv = 1 / dz;
    let t1 = ( minZ - oz ) * inv, t2 = ( maxZ - oz ) * inv;
    const s = dz > 0 ? -1 : 1;
    if ( t1 > t2 ) { const tt = t1; t1 = t2; t2 = tt; }
    if ( t1 > tmin ) { tmin = t1; axis = 2; sign = s; }
    if ( t2 < tmax ) tmax = t2;
    if ( tmin > tmax ) return -1;
  }

  if ( tmin > maxDist ) return -1;
  if ( axis === -1 ) { outN.set( -dx, -dy, -dz ); return 0; }
  outN.set( axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0 );
  return tmin;
}

/** Nearest non-negative ray/sphere intersection, or `-1`. Unit direction. */
function raySphere( ox, oy, oz, dx, dy, dz, cx, cy, cz, R, maxDist ) {
  const px = ox - cx, py = oy - cy, pz = oz - cz;
  const b = px * dx + py * dy + pz * dz;
  const c = px * px + py * py + pz * pz - R * R;
  if ( c > 0 && b > 0 ) return -1;
  const disc = b * b - c;
  if ( disc < 0 ) return -1;
  const s = Math.sqrt( disc );
  let t = -b - s;
  if ( t < 0 ) t = -b + s;
  if ( t < 0 || t > maxDist ) return -1;
  return t;
}

/**
 * Ray against an upright capsule (vertical spine `ay..by` at `cx,cz`, radius
 * `R`). Solved as an infinite cylinder in XZ plus two cap spheres, which is
 * exact and avoids the general segment-segment machinery.
 */
function rayVerticalCapsule( ox, oy, oz, dx, dy, dz, cx, cz, ay, by, R, maxDist, outN ) {
  const px = ox - cx, pz = oz - cz;
  let best = -1, kind = 0;

  const a = dx * dx + dz * dz;
  if ( a > 1e-12 ) {
    const b = px * dx + pz * dz;
    const c = px * px + pz * pz - R * R;
    const disc = b * b - a * c;
    if ( disc >= 0 ) {
      const s = Math.sqrt( disc );
      let t = ( -b - s ) / a;
      if ( t < 0 ) t = ( -b + s ) / a;
      if ( t >= 0 && t <= maxDist ) {
        const y = oy + dy * t;
        if ( y >= ay && y <= by ) { best = t; kind = 0; }
      }
    }
  }

  const tA = raySphere( ox, oy, oz, dx, dy, dz, cx, ay, cz, R, best < 0 ? maxDist : best );
  if ( tA >= 0 && ( best < 0 || tA < best ) ) { best = tA; kind = 1; }
  const tB = raySphere( ox, oy, oz, dx, dy, dz, cx, by, cz, R, best < 0 ? maxDist : best );
  if ( tB >= 0 && ( best < 0 || tB < best ) ) { best = tB; kind = 2; }

  if ( best < 0 ) return -1;

  const hx = ox + dx * best, hy = oy + dy * best, hz = oz + dz * best;
  if ( kind === 0 ) {
    const ex = hx - cx, ez = hz - cz;
    const l = Math.sqrt( ex * ex + ez * ez ) || 1;
    outN.set( ex / l, 0, ez / l );
  } else {
    const capY = kind === 1 ? ay : by;
    const ex = hx - cx, ey = hy - capY, ez = hz - cz;
    const l = Math.sqrt( ex * ex + ey * ey + ez * ez ) || 1;
    outN.set( ex / l, ey / l, ez / l );
  }
  return best;
}
