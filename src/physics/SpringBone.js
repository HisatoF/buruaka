import * as THREE from 'three';

/**
 * Secondary motion for hair, skirts, ribbons and ties.
 *
 * Each bone's tip is simulated as a point mass in world space (Verlet), then
 * the bone's local rotation is recovered as the *swing* that takes its rest
 * direction onto the simulated direction. Recovering a swing-only rotation
 * rather than a full look-at is what keeps a flat hair blade from corkscrewing
 * around its own axis as it moves.
 *
 * The solver runs on a fixed internal timestep with an accumulator, so a
 * twintail behaves identically at 30fps and 144fps.
 */

const _wp = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _parentScale = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _axis = new THREE.Vector3();

const FIXED_DT = 1 / 90;

export class SpringBoneChain {
  /**
   * @param {THREE.Bone[]} bones  Root-first chain. Each bone's rest tip is
   *        taken from its first child, or from `tipOffset` for the last link.
   * @param {object} [opts]
   * @param {number} [opts.stiffness=0.16]  Pull back toward the rest pose, per fixed step.
   * @param {number} [opts.damping=0.14]    Velocity bleed, per fixed step.
   * @param {number} [opts.gravity=0.55]    Metres per second squared, scaled.
   * @param {number} [opts.drag=0.02]
   * @param {number} [opts.maxAngle=1.05]   Cone limit about the rest direction, radians.
   * @param {number} [opts.radius=0.035]    Collision radius of each tip.
   */
  constructor( bones, opts = {} ) {
    this.bones = bones.filter( Boolean );
    this.stiffness = opts.stiffness ?? 0.16;
    this.damping = opts.damping ?? 0.14;
    this.gravity = opts.gravity ?? 0.55;
    this.gravityDir = ( opts.gravityDir ?? new THREE.Vector3( 0, -1, 0 ) ).clone().normalize();
    this.drag = opts.drag ?? 0.02;
    this.maxAngle = opts.maxAngle ?? 1.05;
    this.radius = opts.radius ?? 0.035;
    this.colliders = opts.colliders ?? [];

    this.external = new THREE.Vector3();
    this._accum = 0;

    this.links = this.bones.map( ( bone, i ) => {
      const child = bone.children.find( ( c ) => c.isBone ) ?? null;
      const localTip = child
        ? child.position.clone()
        : ( opts.tipOffset ? opts.tipOffset.clone() : new THREE.Vector3( 0, -0.08, 0 ) );
      return {
        bone,
        child,
        localTip,
        length: localTip.length() || 1e-4,
        // Bind-pose local rotation; every solve is expressed relative to it.
        restQuat: bone.quaternion.clone(),
        current: new THREE.Vector3(),
        previous: new THREE.Vector3(),
        initialized: false,
      };
    } );
  }

  /** Wind, dash inertia, explosion pushes — anything that isn't gravity. */
  setExternalForce( v ) {
    this.external.copy( v );
  }

  /** Snaps every link back to rest. Call on teleport or respawn. */
  reset() {
    for ( const link of this.links ) {
      link.bone.quaternion.copy( link.restQuat );
      link.initialized = false;
    }
    this._accum = 0;
  }

  update( dt ) {
    if ( !this.links.length ) return;

    // Clamped so a stalled tab doesn't burn hundreds of catch-up steps.
    this._accum = Math.min( this._accum + dt, FIXED_DT * 4 );
    while ( this._accum >= FIXED_DT ) {
      this._solve( FIXED_DT );
      this._accum -= FIXED_DT;
    }
  }

  _solve( dt ) {
    for ( const link of this.links ) {
      const { bone } = link;

      // Reset to rest first so the rest direction is measured against the
      // parent's *current* animated pose, not last frame's simulated one.
      bone.quaternion.copy( link.restQuat );
      bone.updateMatrixWorld( true );

      _rest.copy( link.localTip ).applyMatrix4( bone.matrixWorld );
      bone.getWorldPosition( _wp );

      if ( !link.initialized ) {
        link.current.copy( _rest );
        link.previous.copy( _rest );
        link.initialized = true;
      }

      // --- Verlet integration ------------------------------------------
      _delta.subVectors( link.current, link.previous ).multiplyScalar( 1 - this.drag );
      _cur.copy( link.current ).add( _delta );

      // Spring back toward rest, plus gravity and any external force.
      _tmp.subVectors( _rest, link.current ).multiplyScalar( this.stiffness );
      _cur.add( _tmp );
      _cur.addScaledVector( this.gravityDir, this.gravity * dt * dt * 60 );
      _cur.addScaledVector( this.external, dt * dt * 60 );
      _cur.lerp( link.current, this.damping );

      // --- constraints ---------------------------------------------------
      // Length: the tip must stay exactly one bone-length from the joint,
      // otherwise the chain visibly stretches under acceleration.
      _tmp.subVectors( _cur, _wp );
      const worldLen = _rest.distanceTo( _wp ) || link.length;
      _tmp.setLength( worldLen );
      _cur.copy( _wp ).add( _tmp );

      // Cone limit about the rest direction, so hair can't fold through the
      // skull or a skirt panel swing up past the waist.
      _rest.sub( _wp ).normalize();
      _tmp.normalize();
      const cosA = THREE.MathUtils.clamp( _tmp.dot( _rest ), -1, 1 );
      const angle = Math.acos( cosA );
      if ( angle > this.maxAngle ) {
        _axis.crossVectors( _rest, _tmp );
        if ( _axis.lengthSq() > 1e-10 ) {
          _axis.normalize();
          _q.setFromAxisAngle( _axis, this.maxAngle );
          _tmp.copy( _rest ).applyQuaternion( _q );
        } else {
          _tmp.copy( _rest );
        }
      }
      _cur.copy( _wp ).addScaledVector( _tmp, worldLen );

      // Collision against body spheres, so hair slides over the shoulders.
      for ( const c of this.colliders ) {
        _tmp.subVectors( _cur, c.center );
        const minDist = c.radius + this.radius;
        const d = _tmp.length();
        if ( d < minDist && d > 1e-6 ) {
          _cur.copy( c.center ).addScaledVector( _tmp.divideScalar( d ), minDist );
          // Re-apply the length constraint; pushing out of a collider would
          // otherwise stretch the bone.
          _tmp.subVectors( _cur, _wp ).setLength( worldLen );
          _cur.copy( _wp ).add( _tmp );
        }
      }

      link.previous.copy( link.current );
      link.current.copy( _cur );

      // --- recover a swing-only local rotation ---------------------------
      bone.parent.matrixWorld.decompose( _tmp, _parentQ, _parentScale );
      _qi.copy( _parentQ ).invert();

      // Rest and simulated tip directions, both in the bone's parent space.
      _tmp.copy( link.localTip ).applyQuaternion( link.restQuat ).normalize();
      _cur.sub( _wp ).applyQuaternion( _qi ).normalize();

      _q.setFromUnitVectors( _tmp, _cur );
      bone.quaternion.copy( _q ).multiply( link.restQuat );
      bone.updateMatrixWorld( true );
    }
  }
}

/**
 * Body colliders hair should slide over. Positions are refreshed from the
 * skeleton each frame by the animator.
 */
export function makeBodyColliders( bones ) {
  const spec = [
    { bone: 'head', offset: [ 0, 0.075, 0 ], radius: 0.125 },
    { bone: 'chest', offset: [ 0, 0.06, 0 ], radius: 0.135 },
    { bone: 'shoulderL', offset: [ -0.03, 0, 0 ], radius: 0.075 },
    { bone: 'shoulderR', offset: [ 0.03, 0, 0 ], radius: 0.075 },
    { bone: 'hips', offset: [ 0, 0, 0 ], radius: 0.135 },
  ];

  return spec
    .filter( ( s ) => bones[ s.bone ] )
    .map( ( s ) => ( {
      bone: bones[ s.bone ],
      offset: new THREE.Vector3( ...s.offset ),
      radius: s.radius,
      center: new THREE.Vector3(),
    } ) );
}

export function updateBodyColliders( colliders ) {
  for ( const c of colliders ) {
    c.center.copy( c.offset ).applyMatrix4( c.bone.matrixWorld );
  }
}
