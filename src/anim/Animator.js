import * as THREE from 'three';

/**
 * Procedural character animation.
 *
 * There are no animation clips to load, so everything is generated: the
 * locomotion layer is a set of phase-driven Euler offsets, and the combat
 * layer is two-bone IK that puts the hands on an actual weapon transform.
 *
 * Solving the arms with IK rather than hand-authored Euler poses matters more
 * than it sounds: an aim pose written as fixed joint angles only looks correct
 * for one weapon at one height, whereas IK to a grip point stays correct for
 * every weapon, every target elevation, and every character scale.
 */

/*
 * Scratch state is split per-function on purpose. An earlier version shared
 * one module-level pool between the IK solver and its caller, and because the
 * solver's first line writes the shoulder position into the same vector the
 * caller had passed as the target, every aim resolved against garbage and both
 * arms flew out sideways. Aliasing bugs like that are silent — the code reads
 * correctly — so the pools stay separate.
 */

// --- solveTwoBoneIK private scratch -----------------------------------
const _ikRoot = new THREE.Vector3();
const _ikToTarget = new THREE.Vector3();
const _ikAxis = new THREE.Vector3();
const _ikPole = new THREE.Vector3();
const _ikDesired = new THREE.Vector3();
const _ikRestDir = new THREE.Vector3();
const _ikTmp = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();
const _ikParentQ = new THREE.Quaternion();
const _ikDiscard = new THREE.Vector3();

// --- Animator private scratch -----------------------------------------
const _a1 = new THREE.Vector3();
const _a2 = new THREE.Vector3();
const _a3 = new THREE.Vector3();
const _gripMain = new THREE.Vector3();
const _gripSupport = new THREE.Vector3();
const _poleMain = new THREE.Vector3();
const _poleSupport = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler();

/* ---------------------------------------------------------------------- */
/* Two-bone IK                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Classic analytic two-bone IK (shoulder → elbow → wrist).
 *
 * The upper bone is aimed at the target, then bent by the angle the law of
 * cosines says the chain needs in order to reach; the pole vector resolves the
 * remaining degree of freedom, which is simply which way the elbow points.
 *
 * @param {THREE.Bone} root   Shoulder.
 * @param {THREE.Bone} mid    Elbow.
 * @param {THREE.Bone} end    Wrist. Only its rest offset is read, for length.
 * @param {THREE.Vector3} targetWorld   Copied immediately; safe to alias.
 * @param {THREE.Vector3} poleWorld     Copied immediately; safe to alias.
 * @param {number} [weight=1]  Blends the result against the incoming pose.
 */
export function solveTwoBoneIK( root, mid, end, targetWorld, poleWorld, weight = 1 ) {
  if ( weight <= 0 ) return;

  // Copy the inputs before touching anything, so callers may pass their own
  // scratch vectors without having to know what this function clobbers.
  _ikToTarget.copy( targetWorld );
  _ikPole.copy( poleWorld );

  root.updateMatrixWorld( true );

  const upperLen = mid.position.length();
  const lowerLen = end.position.length();
  const reach = ( upperLen + lowerLen ) * 0.995;

  root.getWorldPosition( _ikRoot );
  _ikToTarget.sub( _ikRoot );
  const dist = THREE.MathUtils.clamp( _ikToTarget.length(), 1e-3, reach );
  _ikToTarget.normalize();

  const cosShoulder = THREE.MathUtils.clamp(
    ( upperLen * upperLen + dist * dist - lowerLen * lowerLen ) / ( 2 * upperLen * dist ), -1, 1
  );
  const shoulderAngle = Math.acos( cosShoulder );

  const cosElbow = THREE.MathUtils.clamp(
    ( upperLen * upperLen + lowerLen * lowerLen - dist * dist ) / ( 2 * upperLen * lowerLen ), -1, 1
  );
  const elbowAngle = Math.PI - Math.acos( cosElbow );

  // Bend plane normal: perpendicular to both the target line and the pole.
  _ikPole.sub( _ikRoot );
  _ikAxis.crossVectors( _ikToTarget, _ikPole );
  if ( _ikAxis.lengthSq() < 1e-8 ) _ikAxis.set( 0, 1, 0 ).cross( _ikToTarget );
  _ikAxis.normalize();

  // --- upper bone -------------------------------------------------------
  const rootRest = root.userData.restQuat ?? ( root.userData.restQuat = root.quaternion.clone() );

  root.parent.updateMatrixWorld( true );
  root.parent.matrixWorld.decompose( _ikDiscard, _ikParentQ, _ikTmp );
  _ikParentQ.invert();

  // Where the upper bone should point, in the shoulder's parent space.
  _ikDesired.copy( _ikToTarget ).applyAxisAngle( _ikAxis, shoulderAngle ).applyQuaternion( _ikParentQ ).normalize();

  // Where it points at rest, in the same space.
  _ikRestDir.copy( mid.position ).normalize().applyQuaternion( rootRest ).normalize();

  _ikQ.setFromUnitVectors( _ikRestDir, _ikDesired ).multiply( rootRest );
  root.quaternion.slerp( _ikQ, weight );
  root.updateMatrixWorld( true );

  // --- mid bone ---------------------------------------------------------
  const midRest = mid.userData.restQuat ?? ( mid.userData.restQuat = mid.quaternion.clone() );

  // The bend axis, brought into the elbow's parent (i.e. the upper bone's) space.
  mid.parent.matrixWorld.decompose( _ikDiscard, _ikParentQ, _ikTmp );
  _ikParentQ.invert();
  _ikTmp.copy( _ikAxis ).applyQuaternion( _ikParentQ ).normalize();

  // Sign and order both matter here. The upper bone was rotated +shoulderAngle
  // about the bend axis, which moves it *toward* the pole; the forearm must
  // therefore rotate back the other way to reach the target. And the axis is
  // expressed in the elbow's parent space, so the bend left-multiplies the
  // rest orientation rather than following it.
  _ikQ.setFromAxisAngle( _ikTmp, -elbowAngle ).multiply( midRest );
  mid.quaternion.slerp( _ikQ, weight );
  mid.updateMatrixWorld( true );
}


const _abRest = new THREE.Vector3();
const _abDesired = new THREE.Vector3();
const _abParentQ = new THREE.Quaternion();
const _abDiscard = new THREE.Vector3();
const _abScale = new THREE.Vector3();
const _abQ = new THREE.Quaternion();
const _abPos = new THREE.Vector3();

/**
 * Rotates a single bone so its child direction points partway toward a world
 * target.
 *
 * Used to let the clavicle follow the arm. Without it, a shoulder driven to
 * 90° by IK leaves every vertex weighted to the static clavicle behind,
 * stretching the deltoid and sleeve into a flat slab — the single most
 * visible skinning artefact on an aiming character.
 *
 * @param {THREE.Bone} bone
 * @param {THREE.Vector3} targetWorld
 * @param {number} weight  0 = keep rest pose, 1 = point straight at the target.
 */
export function aimBoneAt( bone, targetWorld, weight ) {
  if ( weight <= 0 ) return;
  const child = bone.children.find( ( c ) => c.isBone );
  if ( !child ) return;

  const rest = bone.userData.restQuat ?? ( bone.userData.restQuat = bone.quaternion.clone() );

  bone.parent.updateMatrixWorld( true );
  bone.parent.matrixWorld.decompose( _abDiscard, _abParentQ, _abScale );
  _abParentQ.invert();

  bone.getWorldPosition( _abPos );
  _abDesired.copy( targetWorld ).sub( _abPos );
  if ( _abDesired.lengthSq() < 1e-8 ) return;
  _abDesired.normalize().applyQuaternion( _abParentQ ).normalize();

  _abRest.copy( child.position ).normalize().applyQuaternion( rest ).normalize();

  _abQ.setFromUnitVectors( _abRest, _abDesired ).multiply( rest );
  bone.quaternion.copy( rest ).slerp( _abQ, weight );
  bone.updateMatrixWorld( true );
}

/* ---------------------------------------------------------------------- */
/* Pose buffer                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Accumulates weighted Euler offsets per bone before anything is written to
 * the skeleton.
 *
 * Layers must compose additively — a run cycle plus a hit flinch plus
 * breathing — and writing each layer straight onto `bone.rotation` would make
 * the last one win. Summing offsets first and applying once keeps blending
 * order-independent.
 */
class PoseBuffer {
  constructor( bones ) {
    this.bones = bones;
    this.offsets = new Map();
    for ( const name of Object.keys( bones ) ) {
      this.offsets.set( name, { x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0 } );
    }
  }

  clear() {
    for ( const o of this.offsets.values() ) {
      o.x = o.y = o.z = 0;
      o.px = o.py = o.pz = 0;
    }
  }

  /** @param {string} name @param {number[]} rot [x,y,z] radians @param {number} w */
  add( name, rot, w = 1 ) {
    const o = this.offsets.get( name );
    if ( !o ) return;
    o.x += rot[ 0 ] * w;
    o.y += rot[ 1 ] * w;
    o.z += rot[ 2 ] * w;
  }

  addPos( name, pos, w = 1 ) {
    const o = this.offsets.get( name );
    if ( !o ) return;
    o.px += pos[ 0 ] * w;
    o.py += pos[ 1 ] * w;
    o.pz += pos[ 2 ] * w;
  }

  /** Writes the accumulated offsets onto the skeleton, relative to bind pose. */
  apply( restPose ) {
    for ( const [ name, o ] of this.offsets ) {
      const bone = this.bones[ name ];
      const rest = restPose[ name ];
      if ( !bone || !rest ) continue;
      _euler.set( o.x, o.y, o.z, 'YXZ' );
      bone.quaternion.copy( rest.quat ).multiply( _q.setFromEuler( _euler ) );
      bone.position.set( rest.pos.x + o.px, rest.pos.y + o.py, rest.pos.z + o.pz );
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Animator                                                               */
/* ---------------------------------------------------------------------- */

const TAU = Math.PI * 2;

export class Animator {
  /**
   * @param {import('../gen/Character.js').Character} character
   */
  constructor( character ) {
    this.character = character;
    this.bones = character.bones;

    // Bind pose snapshot: every layer is expressed as a delta from this.
    this.restPose = {};
    for ( const [ name, bone ] of Object.entries( this.bones ) ) {
      this.restPose[ name ] = { quat: bone.quaternion.clone(), pos: bone.position.clone() };
    }

    this.pose = new PoseBuffer( this.bones );

    this.state = 'idle';
    this.phase = Math.random();      // desynchronise identical units
    this.speed = 0;
    this.aimWeight = 0;
    this.aimTarget = new THREE.Vector3( 0, 1.3, 5 );

    this._recoil = 0;
    this._flinch = 0;
    this._flinchDir = new THREE.Vector3();
    this._reload = 0;
    this._skill = 0;
    this._downed = 0;
    this._lean = 0;
    this._leanTarget = 0;
    this._seed = Math.random() * 100;

    // Where the hands should sit on the weapon, in the weapon's local space.
    this.gripMain = new THREE.Vector3( 0, -0.02, 0.02 );
    this.gripSupport = new THREE.Vector3( 0, -0.02, 0.26 );
  }

  setState( state ) {
    if ( state !== this.state ) {
      this.state = state;
      if ( state === 'run' || state === 'walk' ) this.phase = this.phase % 1;
    }
  }

  /** @param {number} n 0 = idle, 1 = full sprint */
  setSpeed( n ) { this.speed = THREE.MathUtils.clamp( n, 0, 1 ); }

  setAim( worldPoint, weight = 1 ) {
    if ( worldPoint ) this.aimTarget.copy( worldPoint );
    this._aimWeightTarget = weight;
  }

  fire( strength = 1 ) { this._recoil = Math.max( this._recoil, strength ); }
  reload() { this._reload = 1; }
  castSkill() { this._skill = 1; }

  /** @param {THREE.Vector3} worldDir  Direction the damage came from. */
  hit( worldDir, strength = 1 ) {
    this._flinch = Math.min( 1, this._flinch + strength );
    if ( worldDir ) this._flinchDir.copy( worldDir ).normalize();
  }

  setDowned( on ) { this._downedTarget = on ? 1 : 0; }

  /* ------------------------------------------------------------------ */

  update( dt, elapsed ) {
    const p = this.pose;
    p.clear();

    // Cycle rate scales with speed so footfalls land with actual movement.
    const cadence = 0.9 + this.speed * 1.5;
    if ( this.speed > 0.02 ) this.phase = ( this.phase + dt * cadence * 2.0 ) % 1;

    this._breathe( p, elapsed );
    this._locomotion( p, elapsed );

    // Decay one-shots.
    this._recoil = Math.max( 0, this._recoil - dt * 6.5 );
    this._flinch = Math.max( 0, this._flinch - dt * 3.2 );
    this._reload = Math.max( 0, this._reload - dt * 0.75 );
    this._skill = Math.max( 0, this._skill - dt * 1.4 );
    this._downed += ( ( this._downedTarget ?? 0 ) - this._downed ) * Math.min( 1, dt * 6 );
    this.aimWeight += ( ( this._aimWeightTarget ?? 0 ) - this.aimWeight ) * Math.min( 1, dt * 8 );

    this._flinchLayer( p );
    this._reloadLayer( p );
    this._skillLayer( p );
    this._downedLayer( p );

    p.apply( this.restPose );

    // IK runs after the pose is written, because it needs the animated
    // shoulder transform to solve against.
    if ( this.aimWeight > 0.01 && this._downed < 0.5 ) this._solveAim( dt );
    else this._carryWeapon();

    this.character.root.updateMatrixWorld( true );
  }

  /* --- layers -------------------------------------------------------- */

  _breathe( p, t ) {
    const s = this._seed;
    const breath = Math.sin( ( t + s ) * 1.35 );
    const idle = 1 - this.speed;
    p.add( 'chest', [ breath * 0.028, 0, 0 ], idle );
    p.add( 'spine', [ -breath * 0.014, 0, 0 ], idle );
    p.addPos( 'chest', [ 0, breath * 0.004, 0 ], idle );

    // A slow, off-beat weight shift keeps a standing unit from looking frozen.
    const sway = Math.sin( ( t + s ) * 0.47 );
    p.add( 'hips', [ 0, sway * 0.055, sway * 0.02 ], idle );
    p.add( 'head', [ Math.sin( ( t + s ) * 0.83 ) * 0.03, sway * 0.07, 0 ], idle );
    p.add( 'upperArmL', [ 0, 0, sway * 0.045 ], idle );
    p.add( 'upperArmR', [ 0, 0, -sway * 0.045 ], idle );
  }

  _locomotion( p, t ) {
    const w = this.speed;
    if ( w < 0.02 ) return;

    const a = this.phase * TAU;

    /*
     * A run cycle is not a sine wave on the thigh. Driving both joints from
     * the same phase gives a straight-legged scissor — the "skate lunge" this
     * used to have. The parts that actually read as running are:
     *
     *   - a short stance and a long swing, so a foot spends most of the cycle
     *     in the air rather than half and half;
     *   - the knee folding hard during swing and extending just before
     *     contact, which is where the leg's silhouette changes most;
     *   - the ankle leading on contact and pushing off at the end of stance.
     *
     * `lift` below is the swing-phase weight for one leg; `plant` is its
     * complement. Everything else keys off those.
     */
    const stride = 0.42 + w * 0.36;

    const leg = ( phase, sign ) => {
      const s = Math.sin( phase );
      const c = Math.cos( phase );
      // Swing weight: 1 through the airborne half, 0 while planted.
      const lift = Math.max( 0, s );
      const plant = Math.max( 0, -s );

      // Thigh drives forward through swing and trails through stance.
      const thigh = s * stride + lift * 0.22;
      // Knee folds hardest early in swing, then extends to meet the ground.
      const shin = -( Math.max( 0, Math.sin( phase - 0.55 ) ) ** 1.4 ) * ( 1.15 + w * 0.75 );
      // Ankle: toe leads on contact, pushes off at the end of stance.
      const foot = lift * 0.34 - plant * 0.20 * Math.max( 0, c ) - 0.06;

      return { thigh, shin, foot, lift, plant };
    };

    const L = leg( a, -1 );
    const R = leg( a + Math.PI, 1 );

    p.add( 'thighL', [ L.thigh, 0, 0 ], w );
    p.add( 'thighR', [ R.thigh, 0, 0 ], w );
    p.add( 'shinL', [ L.shin, 0, 0 ], w );
    p.add( 'shinR', [ R.shin, 0, 0 ], w );
    p.add( 'footL', [ L.foot, 0, 0 ], w );
    p.add( 'footR', [ R.foot, 0, 0 ], w );

    // Legs track slightly inward under the body's centre line rather than
    // swinging in two parallel planes, which is what made the stance splay.
    p.add( 'thighL', [ 0, 0, 0.055 + L.lift * 0.035 ], w );
    p.add( 'thighR', [ 0, 0, -0.055 - R.lift * 0.035 ], w );

    // Counter-rotating hips and chest, and a lean that grows with speed.
    p.add( 'hips', [ 0, -Math.sin( a ) * 0.13, 0 ], w );
    p.add( 'chest', [ 0.09 + w * 0.16, Math.sin( a ) * 0.15, 0 ], w );
    p.add( 'spine', [ 0.05 + w * 0.07, 0, 0 ], w );

    // Vertical bob peaks at mid-stance, not at the crossover: the body is
    // highest when it is vaulting over a planted foot.
    const bob = Math.abs( Math.cos( a ) );
    p.addPos( 'hips', [ 0, bob * 0.030 * w - 0.016 * w, 0 ], 1 );
    p.add( 'hips', [ 0, 0, Math.sin( a * 2 ) * 0.026 ], w );

    // Arms counter-swing, but only where the aim layer isn't overriding them.
    const armW = w * ( 1 - this.aimWeight );
    p.add( 'upperArmL', [ -Math.sin( a ) * 0.78, 0, 0.13 ], armW );
    p.add( 'upperArmR', [ Math.sin( a ) * 0.78, 0, -0.13 ], armW );
    p.add( 'lowerArmL', [ -0.62 - Math.max( 0, Math.sin( a ) ) * 0.45, 0, 0 ], armW );
    p.add( 'lowerArmR', [ -0.62 - Math.max( 0, -Math.sin( a ) ) * 0.45, 0, 0 ], armW );

    p.add( 'head', [ -0.045 * w, 0, 0 ], 1 );
  }

  _flinchLayer( p ) {
    const f = this._flinch;
    if ( f < 0.01 ) return;
    // Recoil away from the hit, strongest in the spine, fading up the chain.
    const lateral = this._flinchDir.x;
    const fore = this._flinchDir.z;
    p.add( 'spine', [ -fore * 0.30 * f, 0, lateral * 0.22 * f ] );
    p.add( 'chest', [ -fore * 0.24 * f, lateral * 0.18 * f, lateral * 0.16 * f ] );
    p.add( 'head', [ -fore * 0.20 * f, 0, lateral * 0.14 * f ] );
    p.add( 'hips', [ -fore * 0.12 * f, 0, 0 ] );
  }

  _reloadLayer( p ) {
    const r = this._reload;
    if ( r < 0.01 ) return;
    // A three-beat gesture: drop the weapon, bring the support hand to the
    // magazine well, snap back up.
    const t = 1 - r;
    const drop = Math.sin( Math.min( t, 1 ) * Math.PI );
    p.add( 'upperArmL', [ 0.55 * drop, 0.35 * drop, 0 ] );
    p.add( 'lowerArmL', [ -0.9 * drop, 0, 0 ] );
    p.add( 'chest', [ 0.12 * drop, 0.10 * drop, 0 ] );
    p.add( 'head', [ 0.18 * drop, 0.10 * drop, 0 ] );
  }

  _skillLayer( p ) {
    const s = this._skill;
    if ( s < 0.01 ) return;
    // Wind-up then release, with a back-arch on the release for readability
    // at gameplay camera distance.
    const t = 1 - s;
    const wind = Math.sin( Math.min( t * 1.6, 1 ) * Math.PI );
    p.add( 'chest', [ -0.30 * wind, 0, 0 ] );
    p.add( 'spine', [ -0.16 * wind, 0, 0 ] );
    p.add( 'head', [ -0.24 * wind, 0, 0 ] );
    p.add( 'upperArmR', [ -1.1 * wind, 0, -0.5 * wind ] );
    p.add( 'upperArmL', [ -1.1 * wind, 0, 0.5 * wind ] );
  }

  _downedLayer( p ) {
    const d = this._downed;
    if ( d < 0.01 ) return;
    p.add( 'hips', [ 0.35 * d, 0, 0 ] );
    p.add( 'spine', [ 0.45 * d, 0, 0 ] );
    p.add( 'chest', [ 0.35 * d, 0, 0 ] );
    p.add( 'head', [ 0.30 * d, 0, 0 ] );
    p.add( 'thighL', [ -1.0 * d, 0, 0.2 * d ] );
    p.add( 'thighR', [ -1.0 * d, 0, -0.2 * d ] );
    p.add( 'shinL', [ -1.3 * d, 0, 0 ] );
    p.add( 'shinR', [ -1.3 * d, 0, 0 ] );
    p.addPos( 'hips', [ 0, -0.42 * d, 0 ] );
  }

  /* --- aim ----------------------------------------------------------- */

  /**
   * Low-ready carry: the weapon hangs at the right hip, muzzle down and
   * forward. Used whenever the aim layer is off, so a running or downed unit
   * still has its weapon on its body.
   */
  _carryWeapon() {
    const socket = this.character.weaponSocket;
    if ( !socket ) return;
    const b = this.bones;

    b.handR.updateMatrixWorld( true );
    b.handR.getWorldPosition( _a1 );

    // Muzzle down-forward, roughly parallel to the thigh.
    _euler.set( -1.05, 0.22, 0, 'YXZ' );
    socket.quaternion.setFromEuler( _euler );

    // Place the *grip*, not the weapon's origin. The origin sits at the
    // receiver's centre, so anchoring it to the hand left the gun floating a
    // grip-length clear of the fist.
    socket.position.set( 0, 0, 0 );
    socket.updateMatrixWorld( true );
    _a2.copy( this.gripMain ).applyMatrix4( socket.matrixWorld );
    socket.position.copy( _a1 ).sub( _a2 );
    socket.parent.worldToLocal( socket.position );
    socket.updateMatrixWorld( true );
  }

  _solveAim( dt ) {
    const b = this.bones;
    const w = this.aimWeight;
    const socket = this.character.weaponSocket;

    this.character.root.updateMatrixWorld( true );

    // Turn the chest and head toward the target before the arms solve, so the
    // shoulders already face the right way and the IK isn't asked to wrench an
    // arm across the body.
    _a1.copy( this.aimTarget );
    b.chest.parent.worldToLocal( _a1 );
    const yaw = Math.atan2( _a1.x, Math.max( _a1.z, 0.05 ) );
    const pitch = -Math.atan2( _a1.y - 1.15, Math.hypot( _a1.x, _a1.z ) );
    const clampedYaw = THREE.MathUtils.clamp( yaw, -1.0, 1.0 );

    _euler.set( pitch * 0.35 * w, clampedYaw * 0.55 * w, 0, 'YXZ' );
    b.chest.quaternion.copy( this.restPose.chest.quat ).multiply( _q.setFromEuler( _euler ) );
    b.chest.updateMatrixWorld( true );

    _euler.set( pitch * 0.45 * w, clampedYaw * 0.35 * w, 0, 'YXZ' );
    b.head.quaternion.copy( this.restPose.head.quat ).multiply( _q.setFromEuler( _euler ) );
    b.head.updateMatrixWorld( true );

    if ( !socket ) return;

    // --- place the weapon ------------------------------------------------
    // Anchored between the shoulders and pushed forward along the aim line,
    // which keeps the grip inside both arms' reach at any target elevation.
    b.chest.getWorldPosition( _a1 );
    _a1.y += 0.115;
    _a3.subVectors( this.aimTarget, _a1 );
    if ( _a3.lengthSq() < 1e-6 ) _a3.set( 0, 0, 1 );
    _a3.normalize();

    // Offset toward the trigger side: right of the aim axis, on the ground plane.
    _a2.set( _a3.z, 0, -_a3.x ).normalize();

    _a1.addScaledVector( _a3, 0.20 ).addScaledVector( _a2, 0.075 );
    _a1.y -= 0.045;

    socket.position.copy( _a1 );
    socket.parent.worldToLocal( socket.position );

    _a1.copy( this.aimTarget );
    socket.parent.worldToLocal( _a1 );
    socket.lookAt( _a1 );

    // Recoil kicks the weapon back along its own barrel and pitches it up.
    if ( this._recoil > 0.01 ) {
      const r = this._recoil * this._recoil;
      socket.translateZ( -0.05 * r );
      socket.rotateX( -0.30 * r );
    }
    socket.updateMatrixWorld( true );

    // --- hands to the grips ----------------------------------------------
    _gripMain.copy( this.gripMain ).applyMatrix4( socket.matrixWorld );
    _gripSupport.copy( this.gripSupport ).applyMatrix4( socket.matrixWorld );

    // Poles sit below and behind each shoulder so elbows drop naturally
    // instead of flaring out to the sides like a chicken wing.
    b.upperArmR.getWorldPosition( _poleMain );
    _poleMain.addScaledVector( _a3, -0.35 ).add( _a2.clone().multiplyScalar( 0.45 ) );
    _poleMain.y -= 0.55;

    b.upperArmL.getWorldPosition( _poleSupport );
    _poleSupport.addScaledVector( _a3, -0.30 ).add( _a2.clone().multiplyScalar( -0.45 ) );
    _poleSupport.y -= 0.50;

    // Let the clavicles follow part of the way first, so the deltoid isn't
    // asked to absorb the whole rotation on its own.
    aimBoneAt( b.shoulderR, _gripMain, 0.26 * w );
    aimBoneAt( b.shoulderL, _gripSupport, 0.22 * w );

    solveTwoBoneIK( b.upperArmR, b.lowerArmR, b.handR, _gripMain, _poleMain, w );
    solveTwoBoneIK( b.upperArmL, b.lowerArmL, b.handL, _gripSupport, _poleSupport, w );
  }
}
