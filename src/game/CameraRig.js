import * as THREE from 'three';

/**
 * Tactical follow camera.
 *
 * Frames the squad from behind and above, the way the genre expects, but the
 * interesting part is the framing logic: the camera tracks a weighted point
 * between the squad and whatever they are engaging, so the enemy a player
 * cares about stays on screen without the camera whipping around. Distance
 * also opens up as the squad spreads, so a scattered formation doesn't fall
 * off the edges of the frame.
 */

const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class CameraRig {
  constructor( camera, opts = {} ) {
    this.camera = camera;

    this.yaw = opts.yaw ?? 0;
    this.pitch = opts.pitch ?? 0.34;          // radians below horizontal
    this.distance = opts.distance ?? 10.0;
    this.minDistance = 7.8;
    this.maxDistance = 22;
    this.height = opts.height ?? 1.4;

    // When false, the rig stops driving the camera entirely. The capture
    // harness sets this to pin a fixed framing; without it every static
    // framing was silently overwritten on the very next frame.
    this.enabled = true;

    this.focus = new THREE.Vector3( 0, 1.2, 0 );
    this.smoothed = new THREE.Vector3( 0, 1.2, 0 );
    this.position = new THREE.Vector3();

    /**
     * Optional collision source. When set, the rig sweeps from the focus point
     * out to the desired camera position and pulls in on anything solid — a
     * camera that ends up inside a shipping container shows the player the
     * inside of a shipping container, which is both useless and disorienting.
     * @type {{ spherecast: Function }|null}
     */
    this.collider = opts.collider ?? null;
    this.collisionMask = opts.collisionMask ?? 1;   // LAYER_STATIC
    this.collisionRadius = opts.collisionRadius ?? 0.45;
    this._collisionDistance = this.distance;
    this._collisionPitch = this.pitch;

    this._shake = 0;
    this._shakeDecay = 3.2;
    this._shakeSeed = Math.random() * 1000;
    this._recoilKick = 0;
    this._fovBase = camera.fov;
    this._fovTarget = camera.fov;
  }

  /** @param {number} amount 0..1 */
  shake( amount, decay = 3.2 ) {
    this._shake = Math.min( 1.4, this._shake + amount );
    this._shakeDecay = decay;
  }

  /** A short punch-in, used on skill activation. */
  punchFov( delta = -4, ) {
    this._fovTarget = this._fovBase + delta;
  }

  orbit( dx, dy ) {
    this.yaw -= dx * 0.004;
    this.pitch = THREE.MathUtils.clamp( this.pitch + dy * 0.003, 0.18, 1.15 );
  }

  zoom( steps ) {
    this.distance = THREE.MathUtils.clamp( this.distance + steps * 1.4, this.minDistance, this.maxDistance );
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} squadCentre
   * @param {THREE.Vector3|null} engagementCentre  Where the fighting is.
   * @param {number} spread  Radius of the squad formation, metres.
   */
  update( dt, squadCentre, engagementCentre, spread = 0 ) {
    if ( !this.enabled ) return;
    // Bias the framing toward the fight, but cap the pull in metres rather
    // than as a fraction. A ratio looks fine at short range and shoves the
    // squad off the bottom of the frame the moment the enemy is 20 m away.
    _target.copy( squadCentre );
    if ( engagementCentre ) {
      _tmp.subVectors( engagementCentre, squadCentre ).setY( 0 );
      const pull = Math.min( _tmp.length() * 0.28, 2.8 );
      if ( _tmp.lengthSq() > 1e-6 ) _target.addScaledVector( _tmp.normalize(), pull );
    }
    _target.y = 1.15;

    // Critically-damped-ish follow: fast enough to keep up, slow enough that
    // a single unit dying doesn't jolt the frame.
    const k = 1 - Math.pow( 0.0015, dt );
    this.smoothed.lerp( _target, k );

    const dist = THREE.MathUtils.clamp( this.distance + spread * 0.26, this.minDistance, this.maxDistance );
    let usedDistance = dist;

    _offset.set(
      Math.sin( this.yaw ) * Math.cos( this.pitch ),
      Math.sin( this.pitch ),
      Math.cos( this.yaw ) * Math.cos( this.pitch )
    ).multiplyScalar( dist );

    // --- collision -------------------------------------------------------
    // Pulling the boom in is not enough on its own. When the squad is hugging
    // a container, the obstruction sits closer than the minimum distance, so
    // clamping just parks the camera inside the container instead of behind
    // it. Real cameras solve this by climbing: if the boom is blocked at this
    // pitch, try a steeper one and look down over the obstacle.
    if ( this.collider ) {
      let chosenPitch = this.pitch;
      let chosenDist = dist;
      let cleared = false;

      for ( const extra of [ 0, 0.18, 0.38, 0.62, 0.92 ] ) {
        const p = Math.min( this.pitch + extra, 1.32 );
        _tmp.set(
          Math.sin( this.yaw ) * Math.cos( p ),
          Math.sin( p ),
          Math.cos( this.yaw ) * Math.cos( p )
        );
        const hit = this.collider.spherecast(
          this.smoothed, _tmp, this.collisionRadius, dist, this.collisionMask
        );
        if ( !hit || !hit.hit ) { chosenPitch = p; chosenDist = dist; cleared = true; break; }
        // Remember the best partial result in case nothing fully clears.
        const usable = hit.distance - this.collisionRadius;
        if ( usable > chosenDist || extra === 0 ) { chosenPitch = p; chosenDist = usable; }
      }

      // No floor tied to minDistance here. If nothing clears at any pitch, the
      // camera has to accept a short boom: cramped but outside the geometry is
      // strictly better than roomy but inside it, and clamping back up to a
      // "comfortable" distance is exactly what put the lens inside a shipping
      // container twice. Only an absolute floor, to stay off the characters.
      if ( !cleared ) chosenDist = Math.max( chosenDist, 1.6 );

      // Snap in immediately when something intrudes, but ease back out — the
      // reverse reads as the camera being shoved by geometry it has left.
      this._collisionDistance = chosenDist < this._collisionDistance
        ? chosenDist
        : this._collisionDistance + ( chosenDist - this._collisionDistance ) * Math.min( 1, dt * 2.2 );
      this._collisionPitch += ( chosenPitch - this._collisionPitch ) * Math.min( 1, dt * 4.5 );

      usedDistance = Math.min( dist, this._collisionDistance );
      const finalDist = usedDistance;
      const cp = this._collisionPitch;
      _offset.set(
        Math.sin( this.yaw ) * Math.cos( cp ),
        Math.sin( cp ),
        Math.cos( this.yaw ) * Math.cos( cp )
      ).multiplyScalar( finalDist );
    }

    _desired.copy( this.smoothed ).add( _offset );
    _desired.y = Math.max( _desired.y, 1.4 );   // never dip below the props

    this.position.lerp( _desired, 1 - Math.pow( 0.002, dt ) );

    // --- shake -----------------------------------------------------------
    this._shake = Math.max( 0, this._shake - dt * this._shakeDecay );
    if ( this._shake > 0.001 ) {
      const s = this._shake * this._shake;
      const t = performance.now() * 0.001 + this._shakeSeed;
      // Two decorrelated frequencies read as a real impact; one sine reads as
      // a wobble.
      _tmp.set(
        ( Math.sin( t * 47.3 ) + Math.sin( t * 23.1 ) * 0.6 ) * s * 0.22,
        ( Math.sin( t * 39.7 ) + Math.sin( t * 17.9 ) * 0.6 ) * s * 0.18,
        ( Math.sin( t * 31.1 ) ) * s * 0.12
      );
      this.camera.position.copy( this.position ).add( _tmp );
    } else {
      this.camera.position.copy( this.position );
    }

    this.camera.lookAt( this.smoothed );
    if ( this._shake > 0.001 ) this.camera.rotateZ( Math.sin( performance.now() * 0.041 ) * this._shake * 0.012 );

    // --- fov ---------------------------------------------------------------
    // Widen as the boom is forced in. A camera shoved against cover otherwise
    // frames two backs and a wall; opening the lens keeps roughly the same
    // amount of world on screen while the geometry is crowding it.
    const squeeze = THREE.MathUtils.clamp( 1 - usedDistance / Math.max( dist, 1e-3 ), 0, 1 );
    this._fovTarget = this._fovBase + squeeze * 16;

    this._fovTarget += ( this._fovBase - this._fovTarget ) * Math.min( 1, dt * 3.5 ) * ( 1 - squeeze );
    if ( Math.abs( this.camera.fov - this._fovTarget ) > 0.01 ) {
      this.camera.fov += ( this._fovTarget - this.camera.fov ) * Math.min( 1, dt * 9 );
      this.camera.updateProjectionMatrix();
    }
  }

  /** Ground-plane point under a normalised-device-coords pointer. */
  screenToGround( ndc, out = new THREE.Vector3() ) {
    _tmp.set( ndc.x, ndc.y, 0.5 ).unproject( this.camera );
    _tmp.sub( this.camera.position ).normalize();
    const t = -this.camera.position.y / ( _tmp.y || -1e-6 );
    return out.copy( this.camera.position ).addScaledVector( _tmp, t );
  }
}
