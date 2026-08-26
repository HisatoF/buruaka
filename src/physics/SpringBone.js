/**
 * @file Secondary motion for anime hair, skirts and ribbons.
 *
 * Design notes — why this shape of solver:
 *
 * - Anime hair reads as *lag*, not as physics. What sells a dash is that the
 *   hair keeps going after the head stops, then swings back once and settles.
 *   That is a damped angular spring, so the whole solver is one particle per
 *   joint, a rest-pose spring and a hard length constraint — not a cloth solver.
 * - Simulation happens in **world space**. The whole point is that hair reacts
 *   to the character moving through the world; doing it in local space would
 *   make the hair perfectly rigid relative to the head, which is precisely the
 *   look we are trying to avoid.
 * - The result is written back as a **swing-only** quaternion
 *   (`setFromUnitVectors`, which is by construction the minimal rotation
 *   between two directions and therefore carries no twist). A strand that rolls
 *   about its own axis shears the skinning and makes ribbons flip; a strand that
 *   stretches makes the hair mesh visibly tear away from the scalp. Neither can
 *   happen here: rotation is the only thing ever written to a bone, and the
 *   particle is re-projected onto its rest length every substep.
 * - A per-bone cone limit about the *current* rest direction stops hair folding
 *   back through the skull when the character whips around, which is the single
 *   most common artefact in this kind of system.
 * - Fixed internal timestep with an accumulator, so the settle looks identical
 *   at 30 and 60 fps. Verlet with a variable `h` silently changes the effective
 *   damping, and hair that goes limp when the framerate drops is very visible.
 *
 * Conventions: metres, +Y up, radians, seconds.
 *
 * @example
 * const hair = new SpringBoneChain( twintailBones, {
 *   stiffness: 55, damping: 5, gravity: 9.8,
 *   dragCoefficient: 0.35, coneAngle: Math.PI / 3, radius: 0.015,
 * } );
 * hair.setColliders( [
 *   { type: 'sphere', object: headBone, offset: new THREE.Vector3( 0, 0.09, 0 ), radius: 0.115 },
 *   { type: 'capsule', object: chestBone, start: ..., end: ..., radius: 0.12 },
 * ] );
 *
 * // per frame
 * hair.setExternalForce( windPlusDashInertia );
 * hair.update( dt );
 */

import * as THREE from 'three';

/** Inner step. 120 Hz matches the physics world so the two never beat. */
const FIXED_DT = 1 / 120;
/** Spiral guard: at 30 fps this is exactly enough to stay in lockstep. */
const MAX_SUBSTEPS = 4;
/** Below this a direction is considered degenerate. */
const EPS = 1e-8;

/* --------------------------------------------------------------- scratch -- */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _head = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _dirA = new THREE.Vector3();
const _dirB = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _ipos = new THREE.Vector3();
const _iscl = new THREE.Vector3();
const _iq = new THREE.Quaternion();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _mat = new THREE.Matrix4();

const clamp = ( v, lo, hi ) => ( v < lo ? lo : ( v > hi ? hi : v ) );

/**
 * Closest point on segment `a → b` to `p`, written into `out`.
 * @returns {THREE.Vector3} `out`
 */
function closestOnSegment( p, a, b, out ) {
  _v3.subVectors( b, a );
  const l2 = _v3.lengthSq();
  if ( l2 < EPS ) return out.copy( a );
  _v4.subVectors( p, a );
  const t = clamp( _v4.dot( _v3 ) / l2, 0, 1 );
  return out.copy( a ).addScaledVector( _v3, t );
}

/* ------------------------------------------------------- SpringBoneChain -- */

/**
 * One simulated strand: an ordered chain of bones, root first.
 *
 * `bones[i]`'s *head* is its own origin and its *tail* is `bones[i + 1]`'s
 * origin, so a chain of `n` bones has `n - 1` real segments plus a virtual tip
 * segment that continues the last one. Every bone in the array is simulated,
 * including the last — a ribbon whose final joint stayed rigid would look
 * pinned.
 *
 * The bones must be a directly parented chain (`bones[i].parent === bones[i-1]`)
 * hanging off a skeleton whose ancestors are up to date when `update` is
 * called; the solver refreshes the chain's own world matrices itself.
 */
export class SpringBoneChain {

  /**
   * @param {THREE.Object3D[]} bones root-first chain, at least one bone.
   * @param {object} [options]
   * @param {number} [options.stiffness=55]  angular spring pulling the strand
   *   back to its rest pose, in 1/s². 0 = dead weight, 200 = lacquered.
   * @param {number} [options.damping=5]     velocity decay, 1/s. Higher settles
   *   sooner; around `2 * sqrt(stiffness)` is critical.
   * @param {number} [options.gravity=9.8]   m/s² along `gravityDir`.
   * @param {THREE.Vector3} [options.gravityDir=(0,-1,0)]
   * @param {number} [options.dragCoefficient=0.3] quadratic air drag, 1/m. This
   *   is what makes long hair *flow* rather than swing like a pendulum.
   * @param {number} [options.stretchLimit=0] fraction of rest length the strand
   *   may stretch under load. 0 keeps every segment rigid.
   * @param {number} [options.radius=0.015]  strand thickness, for collision.
   * @param {number} [options.coneAngle=Math.PI/3] per-bone half-angle limit
   *   about the rest direction. `Math.PI` disables it.
   * @param {number} [options.tipLength]     virtual tail length of the last
   *   bone; defaults to the length of the previous segment.
   * @param {THREE.Vector3} [options.tipAxis] local tail direction for a
   *   single-bone chain. Defaults to `(0, -1, 0)`.
   * @param {Array<object>} [options.colliders] see {@link SpringBoneChain#setColliders}.
   */
  constructor( bones, options = {} ) {
    if ( ! bones || bones.length === 0 ) throw new Error( 'SpringBoneChain: needs at least one bone' );

    /** @type {THREE.Object3D[]} */
    this.bones = bones.slice();
    const n = this.bones.length;

    /** @type {number} */
    this.stiffness = options.stiffness ?? 55;
    /** @type {number} */
    this.damping = options.damping ?? 5;
    /** @type {number} */
    this.gravity = options.gravity ?? 9.8;
    /** @type {THREE.Vector3} */
    this.gravityDir = new THREE.Vector3( 0, -1, 0 );
    if ( options.gravityDir ) this.gravityDir.copy( options.gravityDir );
    if ( this.gravityDir.lengthSq() < EPS ) this.gravityDir.set( 0, -1, 0 );
    this.gravityDir.normalize();
    /** @type {number} */
    this.dragCoefficient = options.dragCoefficient ?? 0.3;
    /** @type {number} */
    this.stretchLimit = Math.max( 0, options.stretchLimit ?? 0 );
    /** @type {number} */
    this.radius = options.radius ?? 0.015;
    /** @type {number} */
    this.coneAngle = options.coneAngle ?? Math.PI / 3;
    /** @type {boolean} set false to freeze the strand without unhooking it. */
    this.enabled = true;

    /** @type {THREE.Vector3} extra world-space acceleration: wind, dash inertia. */
    this.externalForce = new THREE.Vector3();

    /** @type {Array<object>} resolved every `update`. */
    this.colliders = [];
    this._colliderWorld = [];
    if ( options.colliders ) this.setColliders( options.colliders );

    // --- per-bone rest data ------------------------------------------------
    /** Local rotation each bone had when the chain was built. @private */
    this._restQuat = new Array( n );
    /** Unit tail direction in each bone's own local space. @private */
    this._axisLocal = new Array( n );
    /** Tail distance in each bone's *parent* space (i.e. local units). @private */
    this._lenLocal = new Array( n );

    for ( let i = 0; i < n; i ++ ) {
      this._restQuat[ i ] = this.bones[ i ].quaternion.clone();
      this._axisLocal[ i ] = new THREE.Vector3();
      this._lenLocal[ i ] = 0;
    }

    for ( let i = 0; i < n - 1; i ++ ) {
      const child = this.bones[ i + 1 ];
      const len = child.position.length();
      this._lenLocal[ i ] = len;
      if ( len > EPS ) this._axisLocal[ i ].copy( child.position ).divideScalar( len );
      else this._axisLocal[ i ].set( 0, 1, 0 );
    }

    // The last bone has no child, so give it a virtual tail that continues the
    // previous segment. In the tip's own local frame that direction is the
    // previous axis pushed through the tip's rest rotation.
    if ( n >= 2 ) {
      this._lenLocal[ n - 1 ] = options.tipLength ?? this._lenLocal[ n - 2 ];
      this._axisLocal[ n - 1 ]
        .copy( this._axisLocal[ n - 2 ] )
        .applyQuaternion( _q0.copy( this._restQuat[ n - 1 ] ).invert() )
        .normalize();
    } else {
      this._lenLocal[ 0 ] = options.tipLength ?? 0.05;
      this._axisLocal[ 0 ].copy( options.tipAxis ?? _v0.set( 0, -1, 0 ) ).normalize();
    }

    // --- simulation state --------------------------------------------------
    /** World-space tail particle of each bone. @private */
    this._p = new Array( n );
    /** Previous particle position — Verlet's velocity carrier. @private */
    this._prev = new Array( n );
    /** World-space head of each bone, refreshed as the chain is solved. @private */
    this._headW = new Array( n );
    /** World rest tail of each bone, refreshed as the chain is solved. @private */
    this._restW = new Array( n );
    /** World quaternion of each bone's parent. @private */
    this._parentQ = new Array( n );
    /** World segment length, i.e. `_lenLocal` under the skeleton's scale. @private */
    this._lenW = new Array( n );

    for ( let i = 0; i < n; i ++ ) {
      this._p[ i ] = new THREE.Vector3();
      this._prev[ i ] = new THREE.Vector3();
      this._headW[ i ] = new THREE.Vector3();
      this._restW[ i ] = new THREE.Vector3();
      this._parentQ[ i ] = new THREE.Quaternion();
      this._lenW[ i ] = 0;
    }

    // Root interpolation. The skeleton only hands us a pose once per frame, so
    // running four substeps against a pose that teleports at the frame boundary
    // makes the strand behave differently at 30 and 60 fps. Sweeping the
    // anchor linearly across the substeps restores exact parity.
    this._rootPos = new THREE.Vector3();
    this._rootQuat = new THREE.Quaternion();
    this._rootScl = new THREE.Vector3( 1, 1, 1 );
    this._prevRootPos = new THREE.Vector3();
    this._prevRootQuat = new THREE.Quaternion();
    this._prevRootScl = new THREE.Vector3( 1, 1, 1 );
    this._hasPrevRoot = false;
    this._savedRoot = new THREE.Matrix4();

    this._acc = 0;
    this._collisionIterations = 2;
    /** @type {number} substeps consumed by the last `update`; for profiling. */
    this.lastSubsteps = 0;

    this.reset();
  }

  /**
   * Quality scaling per the engine-wide contract.
   * @param {0|1|2} level 0 = potato (no collision), 1 = balanced, 2 = maximum.
   */
  setQuality( level ) {
    this._collisionIterations = level <= 0 ? 0 : ( level === 1 ? 1 : 2 );
  }

  /**
   * Supplies the body colliders the strand must slide over — head, shoulders,
   * chest, thighs. Each entry is one of:
   *
   * ```js
   * { type: 'sphere',  center: Vector3, radius: number }
   * { type: 'capsule', start: Vector3, end: Vector3, radius: number }
   * ```
   *
   * Add `object: THREE.Object3D` and the `center` / `start` / `end` vectors are
   * read as **offsets in that object's local space**, so the collider rides the
   * skeleton for free. Without it they are taken as world-space points.
   *
   * The array is kept by reference — mutate it and the change lands next frame.
   * @param {Array<object>} list
   */
  setColliders( list ) {
    this.colliders = list || [];
    while ( this._colliderWorld.length < this.colliders.length ) {
      this._colliderWorld.push( {
        type: 'sphere',
        a: new THREE.Vector3(),
        b: new THREE.Vector3(),
        radius: 0,
      } );
    }
    return this;
  }

  /**
   * The wind / inertia input, as a world-space **acceleration** in m/s².
   *
   * This is the knob that sells the whole feature. Feed it
   * `-characterAcceleration` and the hair lags behind a dash exactly the way it
   * should; add a low-frequency noise vector and it drifts in the breeze.
   *
   * @param {THREE.Vector3} force
   * @returns {SpringBoneChain} this
   */
  setExternalForce( force ) {
    this.externalForce.copy( force );
    return this;
  }

  /**
   * Snaps the strand back to its rest pose with zero velocity.
   *
   * Call this on respawn and after any teleport. Without it the particles are
   * still sitting at the old world position and the first frame draws the hair
   * as a streak across the entire map.
   * @returns {SpringBoneChain} this
   */
  reset() {
    const n = this.bones.length;
    for ( let i = 0; i < n; i ++ ) this.bones[ i ].quaternion.copy( this._restQuat[ i ] );
    this._refreshRoot();
    for ( let i = 0; i < n; i ++ ) {
      this._syncBone( i );
      this._p[ i ].copy( this._restW[ i ] );
      this._prev[ i ].copy( this._restW[ i ] );
    }
    this._acc = 0;
    this.lastSubsteps = 0;
    // Forget where the anchor used to be, or the frame after a teleport would
    // sweep the strand across the whole map.
    this._hasPrevRoot = false;
    return this;
  }

  /**
   * Advances the strand. Frame-rate independent: the internal step is fixed, so
   * 2 frames at 1/30 s produce the same pose as 4 frames at 1/60 s.
   *
   * @param {number} dt seconds since the last call. Clamped to 0.25.
   * @param {number} [elapsed] unused; present for the engine-wide signature.
   * @returns {SpringBoneChain} this
   */
  update( dt ) {
    if ( ! this.enabled || ! ( dt > 0 ) ) return this;

    const anchor = this.bones[ 0 ].parent;
    this._refreshRoot();
    if ( anchor ) {
      anchor.matrixWorld.decompose( this._rootPos, this._rootQuat, this._rootScl );
      if ( ! this._hasPrevRoot ) {
        this._prevRootPos.copy( this._rootPos );
        this._prevRootQuat.copy( this._rootQuat );
        this._prevRootScl.copy( this._rootScl );
        this._hasPrevRoot = true;
      }
      this._savedRoot.copy( anchor.matrixWorld );
    }
    this._refreshColliders();

    this._acc += Math.min( dt, 0.25 );

    // Count the substeps first: the interpolation needs the denominator.
    let n = 0;
    let rest = this._acc;
    while ( rest >= FIXED_DT && n < MAX_SUBSTEPS ) { rest -= FIXED_DT; n ++; }

    for ( let k = 1; k <= n; k ++ ) {
      if ( anchor ) {
        const a = k / n;
        _ipos.lerpVectors( this._prevRootPos, this._rootPos, a );
        _iq.copy( this._prevRootQuat ).slerp( this._rootQuat, a );
        _iscl.lerpVectors( this._prevRootScl, this._rootScl, a );
        anchor.matrixWorld.compose( _ipos, _iq, _iscl );
      }
      this._solve( FIXED_DT );
    }

    this._acc = rest;
    // Out of budget: drop the backlog rather than spiral into it.
    if ( n === MAX_SUBSTEPS && this._acc > FIXED_DT ) this._acc = 0;

    if ( anchor ) {
      anchor.matrixWorld.copy( this._savedRoot );
      if ( n > 0 ) {
        // Only advance the history when time was actually consumed, so a frame
        // too short to produce a substep still gets swept next time.
        this._prevRootPos.copy( this._rootPos );
        this._prevRootQuat.copy( this._rootQuat );
        this._prevRootScl.copy( this._rootScl );
      }
    }
    this.lastSubsteps = n;
    return this;
  }

  /**
   * World-space tail position of bone `i` — where a hair-tip VFX or a trail
   * emitter should sit.
   * @param {number} i
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3} `out`
   */
  getTailPosition( i, out ) {
    return out.copy( this._p[ i ] );
  }

  /* ---------------------------------------------------------- internals -- */

  /** Brings the chain's ancestors up to date. @private */
  _refreshRoot() {
    const parent = this.bones[ 0 ].parent;
    if ( parent ) parent.updateWorldMatrix( true, false );
  }

  /** Resolves collider definitions into world-space segments. @private */
  _refreshColliders() {
    const src = this.colliders;
    for ( let i = 0; i < src.length; i ++ ) {
      const c = src[ i ];
      const w = this._colliderWorld[ i ];
      const capsule = c.type === 'capsule';
      w.type = capsule ? 'capsule' : 'sphere';
      w.radius = c.radius ?? 0.1;
      if ( capsule ) { w.a.copy( c.start ); w.b.copy( c.end ); }
      else { w.a.copy( c.center ); w.b.copy( c.center ); }
      if ( c.object ) {
        c.object.updateWorldMatrix( true, false );
        w.a.applyMatrix4( c.object.matrixWorld );
        w.b.applyMatrix4( c.object.matrixWorld );
      }
    }
  }

  /**
   * Recomputes bone `i`'s world matrix from its current local transform, then
   * caches its head, its parent's world rotation, and the world-space rest tail
   * the spring pulls toward.
   * @private
   */
  _syncBone( i ) {
    const bone = this.bones[ i ];
    bone.updateMatrix();
    if ( bone.parent ) bone.matrixWorld.multiplyMatrices( bone.parent.matrixWorld, bone.matrix );
    else bone.matrixWorld.copy( bone.matrix );

    const e = bone.matrixWorld.elements;
    this._headW[ i ].set( e[ 12 ], e[ 13 ], e[ 14 ] );

    const pq = this._parentQ[ i ];
    if ( bone.parent ) {
      bone.parent.matrixWorld.decompose( _pos, pq, _scl );
    } else {
      pq.identity();
      _scl.set( 1, 1, 1 );
    }
    const scale = ( Math.abs( _scl.x ) + Math.abs( _scl.y ) + Math.abs( _scl.z ) ) / 3;
    this._lenW[ i ] = this._lenLocal[ i ] * scale;

    // Rest tail: where this bone's tail would be if the strand were rigid,
    // given wherever the skeleton has carried the parent this frame.
    _q0.copy( pq ).multiply( this._restQuat[ i ] );
    this._restW[ i ]
      .copy( this._axisLocal[ i ] )
      .applyQuaternion( _q0 )
      .normalize()
      .multiplyScalar( this._lenW[ i ] )
      .add( this._headW[ i ] );
  }

  /** One fixed inner step over the whole chain, root to tip. @private */
  _solve( h ) {
    const n = this.bones.length;
    const hh = h * h;
    const decay = Math.exp( - this.damping * h );
    const gx = this.gravityDir.x * this.gravity + this.externalForce.x;
    const gy = this.gravityDir.y * this.gravity + this.externalForce.y;
    const gz = this.gravityDir.z * this.gravity + this.externalForce.z;
    const cosCone = Math.cos( clamp( this.coneAngle, 0, Math.PI ) );
    const limited = this.coneAngle < Math.PI - 1e-6;
    const minLen = 1 - this.stretchLimit;
    const maxLen = 1 + this.stretchLimit;

    for ( let i = 0; i < n; i ++ ) {
      // The head is wherever the solved parent has just put it.
      this._syncBone( i );

      const p = this._p[ i ];
      const prev = this._prev[ i ];
      _head.copy( this._headW[ i ] );
      _rest.copy( this._restW[ i ] );
      const len = this._lenW[ i ];

      // --- Verlet ---------------------------------------------------------
      // Displacement over the last step, bled off by the strand's own damping.
      _v0.subVectors( p, prev ).multiplyScalar( decay );

      let ax = gx, ay = gy, az = gz;

      // Quadratic air drag on the world velocity. Long hair without this
      // swings like a rope; with it, it flows.
      if ( this.dragCoefficient > 0 ) {
        const vx = _v0.x / h, vy = _v0.y / h, vz = _v0.z / h;
        const sp = Math.sqrt( vx * vx + vy * vy + vz * vz );
        if ( sp > EPS ) {
          const k = this.dragCoefficient * sp;
          ax -= k * vx; ay -= k * vy; az -= k * vz;
        }
      }

      // Angular spring back to the rest pose. Both endpoints sit at `len` from
      // the head, so this is purely a restoring torque — it can never stretch.
      if ( this.stiffness > 0 ) {
        ax += ( _rest.x - p.x ) * this.stiffness;
        ay += ( _rest.y - p.y ) * this.stiffness;
        az += ( _rest.z - p.z ) * this.stiffness;
      }

      prev.copy( p );
      p.x += _v0.x + ax * hh;
      p.y += _v0.y + ay * hh;
      p.z += _v0.z + az * hh;

      // --- constraints ----------------------------------------------------
      this._constrainLength( p, _head, len, minLen, maxLen );

      if ( limited ) {
        _dirA.subVectors( _rest, _head );
        if ( _dirA.lengthSq() > EPS ) {
          _dirA.normalize();
          this._constrainCone( p, _head, _dirA, len, cosCone );
        }
      }

      // Alternate push-out and re-projection, then let collision have the last
      // word. A length projection applied *after* the final push-out can shave
      // the particle back inside the collider by a few microns, and a strand
      // sunk into the skull is far more visible than a segment 0.04 % short.
      for ( let it = 0; it < this._collisionIterations; it ++ ) {
        if ( ! this._collide( p ) ) break;
        this._constrainLength( p, _head, len, minLen, maxLen );
      }
      if ( this._collisionIterations > 0 ) this._collide( p );

      // --- write the pose back --------------------------------------------
      this._applyRotation( i, _head, len );
    }
  }

  /** Re-projects the particle onto the shell of allowed lengths. @private */
  _constrainLength( p, head, len, minLen, maxLen ) {
    if ( len <= EPS ) { p.copy( head ); return; }
    _v1.subVectors( p, head );
    const d = _v1.length();
    if ( d < EPS ) {
      // Fully collapsed onto the head: there is no direction left to keep, so
      // fall back to the rest direction rather than emitting a NaN.
      _v1.copy( _rest ).sub( head );
      if ( _v1.lengthSq() < EPS ) _v1.set( 0, -1, 0 );
      _v1.normalize();
      p.copy( head ).addScaledVector( _v1, len );
      return;
    }
    const lo = len * minLen, hi = len * maxLen;
    if ( d >= lo && d <= hi ) return;
    const target = d < lo ? lo : hi;
    p.copy( head ).addScaledVector( _v1, target / d );
  }

  /**
   * Clamps the strand to a cone about `restDir`. This is what stops hair
   * folding back through the skull on a hard turn.
   * @private
   */
  _constrainCone( p, head, restDir, len, cosCone ) {
    _dirB.subVectors( p, head );
    const d = _dirB.length();
    if ( d < EPS ) return;
    _dirB.divideScalar( d );

    const c = _dirB.dot( restDir );
    if ( c >= cosCone ) return;

    _axis.crossVectors( restDir, _dirB );
    if ( _axis.lengthSq() < EPS ) {
      // Exactly antiparallel: any perpendicular will do, but it has to be a
      // *stable* one or the strand will chatter between two choices.
      _axis.set( restDir.y, - restDir.x, 0 );
      if ( _axis.lengthSq() < EPS ) _axis.set( 0, restDir.z, - restDir.y );
    }
    _axis.normalize();

    _q1.setFromAxisAngle( _axis, Math.acos( clamp( cosCone, -1, 1 ) ) );
    _v2.copy( restDir ).applyQuaternion( _q1 );
    p.copy( head ).addScaledVector( _v2, d );
  }

  /**
   * Pushes the particle out of every body collider.
   * @returns {boolean} true when something moved.
   * @private
   */
  _collide( p ) {
    const list = this._colliderWorld;
    const count = this.colliders.length;
    let moved = false;
    for ( let i = 0; i < count; i ++ ) {
      const c = list[ i ];
      const rr = c.radius + this.radius;
      if ( c.type === 'capsule' ) closestOnSegment( p, c.a, c.b, _v2 );
      else _v2.copy( c.a );
      _v1.subVectors( p, _v2 );
      const d2 = _v1.lengthSq();
      if ( d2 >= rr * rr ) continue;
      if ( d2 > EPS ) _v1.multiplyScalar( rr / Math.sqrt( d2 ) );
      else _v1.set( 0, rr, 0 );   // dead centre: eject straight up, deterministically
      p.copy( _v2 ).add( _v1 );
      moved = true;
    }
    return moved;
  }

  /**
   * Turns the solved tail position into a **swing-only** local rotation and
   * writes it to the bone.
   *
   * `setFromUnitVectors` returns the minimal rotation carrying one direction
   * onto another — the shortest arc, with no component about the shared axis.
   * That is precisely the "no roll" guarantee: the bone's own twist can only
   * ever be whatever the rest pose had.
   * @private
   */
  _applyRotation( i, head, len ) {
    const bone = this.bones[ i ];
    const pq = this._parentQ[ i ];

    // Rest direction in world space, and the direction we actually ended at.
    _q0.copy( pq ).multiply( this._restQuat[ i ] );
    _dirA.copy( this._axisLocal[ i ] ).applyQuaternion( _q0 );
    if ( _dirA.lengthSq() < EPS ) return;
    _dirA.normalize();

    _dirB.subVectors( this._p[ i ], head );
    if ( _dirB.lengthSq() < EPS ) return;
    _dirB.normalize();

    // swing: rest -> actual, in world space. Pure swing, zero twist.
    _q1.setFromUnitVectors( _dirA, _dirB );

    // worldRotation = swing * parentWorld * rest   ->   local = parent⁻¹ * world
    _q2.copy( _q1 ).multiply( _q0 );
    _q0.copy( pq ).invert();
    bone.quaternion.copy( _q0 ).multiply( _q2 );

    // Keep the matrices consistent so the next bone's head is correct.
    bone.updateMatrix();
    if ( bone.parent ) bone.matrixWorld.multiplyMatrices( bone.parent.matrixWorld, bone.matrix );
    else bone.matrixWorld.copy( bone.matrix );
  }

}

/**
 * Builds a chain per root and drives them together — the usual case, where one
 * character has several strands (two twintails, a skirt of eight, a ribbon).
 *
 * Purely a convenience wrapper: it owns no simulation of its own.
 */
export class SpringBoneGroup {

  /** @param {SpringBoneChain[]} [chains] */
  constructor( chains = [] ) {
    /** @type {SpringBoneChain[]} */
    this.chains = chains;
    /** @type {boolean} */
    this.enabled = true;
  }

  /** @param {SpringBoneChain} chain @returns {SpringBoneChain} the chain */
  add( chain ) { this.chains.push( chain ); return chain; }

  /** Applies the same collider list to every chain. */
  setColliders( list ) {
    for ( let i = 0; i < this.chains.length; i ++ ) this.chains[ i ].setColliders( list );
    return this;
  }

  /** Applies the same wind / inertia vector to every chain. */
  setExternalForce( force ) {
    for ( let i = 0; i < this.chains.length; i ++ ) this.chains[ i ].setExternalForce( force );
    return this;
  }

  /** @param {0|1|2} level */
  setQuality( level ) {
    for ( let i = 0; i < this.chains.length; i ++ ) this.chains[ i ].setQuality( level );
    return this;
  }

  /** Snaps every chain to rest. */
  reset() {
    for ( let i = 0; i < this.chains.length; i ++ ) this.chains[ i ].reset();
    return this;
  }

  /** @param {number} dt seconds. */
  update( dt ) {
    if ( ! this.enabled ) return this;
    for ( let i = 0; i < this.chains.length; i ++ ) this.chains[ i ].update( dt );
    return this;
  }

}
