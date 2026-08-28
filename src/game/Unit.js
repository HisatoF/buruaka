import * as THREE from 'three';
import { buildCharacter } from '../gen/Character.js';
import { LAYER_STATIC, LAYER_CHARACTER, LAYER_ENEMY } from '../physics/World.js';

/**
 * A combat unit: a procedural character, a physics capsule, and a small
 * behaviour tree tying the two together.
 *
 * The AI is deliberately shallow — advance, take cover, engage, reposition —
 * because in a squad shooter what reads as intelligence is almost entirely
 * *legibility*: units that visibly commit to a piece of cover, visibly lean
 * out to fire, and visibly fall back when suppressed look far smarter than
 * ones running a deeper planner invisibly.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();

export const TEAM = { SQUAD: 0, HOSTILE: 1 };

let _uid = 0;

export class Unit {
  /**
   * @param {object} cfg
   * @param {string|object} cfg.preset      Character preset key or design.
   * @param {number} cfg.team
   * @param {THREE.Vector3} cfg.position
   * @param {import('../physics/World.js').PhysicsWorld} cfg.physics
   * @param {object} cfg.game               Back-reference for VFX/audio hooks.
   */
  constructor( cfg ) {
    this.id = `u${_uid++}`;
    this.team = cfg.team;
    this.game = cfg.game;
    this.physics = cfg.physics;

    this.character = buildCharacter( cfg.preset, { quality: cfg.quality ?? 2 } );
    this.character.root.position.copy( cfg.position );
    this.animator = this.character.animator;
    this.stats = this.character.stats ?? { damage: 8, rpm: 500, spread: 0.03, range: 18, mag: 30, reload: 2, speed: 180 };

    this.name = this.character.design.name ?? 'UNIT';

    // The HUD keys its procedural portraits on this colour, so every squad
    // member sharing one accent made all four roster chips render identically.
    // Taking it from the character's own hair makes each card recognisable at
    // a glance, which is the whole point of a roster.
    this.color = cfg.color ?? hexToCss(
      this.character.design.hair?.color ?? ( this.team === TEAM.SQUAD ? 0x7fd6ff : 0xff5d6c )
    );
    this.accent = hexToCss( this.character.design.eyes?.color ?? 0x7fd6ff );

    const scale = this.character.design.scale ?? 1;
    this.maxHp = cfg.maxHp ?? ( this.team === TEAM.SQUAD ? 2200 : 620 * scale );
    this.hp = this.maxHp;
    this.armor = cfg.armor ?? ( this.team === TEAM.SQUAD ? 3 : 0 );
    this.armorMax = this.armor;
    this._armorFloat = this.armor;
    this._armorRegen = 0;
    this.dead = false;
    this.downedTimer = 0;

    // Sized to the visible silhouette, not the torso: the skirt hem alone is
    // 0.22 m in radius and the hair tails swing wider still, so a 0.30 m
    // capsule let two units touch while their art plainly overlapped.
    this.body = this.physics.addCapsule(
      cfg.position, 0.38 * scale, 1.55 * scale,
      {
        tag: this.team === TEAM.SQUAD ? 'squad' : 'hostile',
        layer: this.team === TEAM.SQUAD ? LAYER_CHARACTER : LAYER_ENEMY,
        collisionMask: LAYER_STATIC | LAYER_CHARACTER | LAYER_ENEMY,
        mass: 62 * scale,
        userData: this,
      }
    );

    this.moveSpeed = ( this.team === TEAM.SQUAD ? 3.6 : 3.0 ) * scale;
    this.target = null;
    this.coverPoint = null;
    this.destination = null;
    this.state = 'advance';
    this._stateTime = 0;
    this._fireCooldown = 0;
    this._reloadTimer = 0;
    this._ammo = this.stats.mag ?? 30;
    this._retargetTimer = 0;
    this._burstLeft = 0;
    this._facing = 0;
    this._muzzleFlashAt = -1;

    // Desynchronise the AI so a squad doesn't think in lockstep.
    this._think = Math.random() * 0.3;

    // Staggered wedge rather than a rank abreast.
    this.formationOffset = cfg.formationOffset ?? new THREE.Vector3();

    /** @type {Array<{id:string,kind:string,icon:string,name:string,duration:number,maxDuration:number,stacks:number,onEnd?:Function}>} */
    this.statuses = [];
  }

  get position() { return this.body.position; }

  /** Rounds left in the magazine, and whether a reload is in progress. */
  get ammo() { return this._ammo; }
  get ammoMax() { return this.stats.mag ?? 0; }
  get reloading() { return this._reloadTimer > 0; }

  /** Eye/chest height, where shots originate and are aimed. */
  chestPoint( out = _v ) {
    return out.copy( this.body.position ).setY( this.body.position.y + 1.15 * ( this.character.design.scale ?? 1 ) );
  }

  headPoint( out = _v2 ) {
    return out.copy( this.body.position ).setY( this.body.position.y + 1.5 * ( this.character.design.scale ?? 1 ) );
  }

  /* ------------------------------------------------------------------ */

  takeDamage( amount, fromDirection, kind = 'normal' ) {
    if ( this.dead ) return 0;

    // Flat armour reduction with a floor, so a high-armour target is worth
    // switching weapons for but never immune. Armour is also a *depleting*
    // resource — the roster shows it as pips, and pips that never move are
    // decoration rather than information.
    const reduced = Math.max( amount * 0.15, amount - this.armor * 2.5 );
    this.hp = Math.max( 0, this.hp - reduced );

    this._armorFloat = Math.max( 0, ( this._armorFloat ?? this.armor ) - amount / ( this.maxHp * 0.16 ) );
    this.armor = Math.ceil( this._armorFloat );
    this._armorRegen = 6;

    this.animator.hit( fromDirection, Math.min( 1, reduced / ( this.maxHp * 0.08 ) ) );
    this.character.setExpression( { eye: 'angry', brow: 'angry', mouth: 'grimace' } );
    this._expressionHold = 0.7;

    if ( this.hp <= 0 ) this.kill( fromDirection );
    return reduced;
  }

  /**
   * Applies a timed status effect.
   *
   * Effects own their own expiry rather than being scheduled with setTimeout:
   * a timer fires whether or not the unit is still alive, whether or not the
   * mission is still running, and cannot be paused. Ticking them down in the
   * unit's own update keeps them in step with the simulation and lets the HUD
   * read the remaining duration, which is what the status strip displays.
   *
   * @param {object} spec  { id, kind: 'buff'|'debuff'|'heal'|'shield', icon, name, duration, stacks?, onApply?, onEnd? }
   */
  addStatus( spec ) {
    const existing = this.statuses.find( ( s ) => s.id === spec.id );
    if ( existing ) {
      existing.duration = Math.max( existing.duration, spec.duration );
      existing.maxDuration = Math.max( existing.maxDuration, spec.duration );
      existing.stacks = Math.min( 9, existing.stacks + ( spec.stacks ?? 1 ) );
      return existing;
    }
    const st = {
      id: spec.id,
      kind: spec.kind ?? 'buff',
      icon: spec.icon ?? '+',
      name: spec.name ?? spec.id,
      duration: spec.duration,
      maxDuration: spec.duration,
      stacks: spec.stacks ?? 1,
      onEnd: spec.onEnd,
    };
    spec.onApply?.( this );
    this.statuses.push( st );
    return st;
  }

  _tickStatuses( dt ) {
    for ( let i = this.statuses.length - 1; i >= 0; i-- ) {
      const st = this.statuses[ i ];
      st.duration -= dt;
      if ( st.duration <= 0 ) {
        this.statuses.splice( i, 1 );
        st.onEnd?.( this );
      }
    }
  }

  heal( amount ) {
    if ( this.dead ) return 0;
    const before = this.hp;
    this.hp = Math.min( this.maxHp, this.hp + amount );
    return this.hp - before;
  }

  kill( fromDirection ) {
    if ( this.dead ) return;
    this.dead = true;
    this.downedTimer = 0;
    this.animator.setDowned( true );
    this.animator.setAim( null, 0 );
    this.character.setExpression( { eye: 'dizzy', brow: 'sad', mouth: 'grimace' } );
    this.releaseCover();
    // Keep the body in the world briefly so the fall reads, but stop it
    // pushing living units around.
    this.body.collisionMask = LAYER_STATIC;
    this.game?.onUnitDown?.( this, fromDirection );
  }

  releaseCover() {
    if ( this.coverPoint ) {
      this.coverPoint.occupied = null;
      this.coverPoint = null;
    }
  }

  dispose() {
    this.releaseCover();
    this.physics.removeBody( this.body );
    this.character.dispose();
    this.character.root.removeFromParent();
  }

  /* ------------------------------------------------------------------ */
  /* AI                                                                  */
  /* ------------------------------------------------------------------ */

  _acquireTarget( enemies ) {
    let best = null, bestScore = -Infinity;
    this.chestPoint( _v );

    for ( const e of enemies ) {
      if ( e.dead ) continue;
      const dist = e.position.distanceTo( this.position );
      if ( dist > this.stats.range * 1.8 ) continue;

      const visible = this.physics.lineOfSight( _v, e.chestPoint( _v2 ), LAYER_STATIC );

      // Prefer close, visible, already-damaged targets. Sticking with the
      // current target unless something is clearly better stops units from
      // flip-flopping and never landing a burst.
      let score = -dist * 0.6 + ( visible ? 14 : 0 ) + ( 1 - e.hp / e.maxHp ) * 6;
      if ( e === this.target ) score += 5;
      if ( score > bestScore ) { bestScore = score; best = e; }
    }
    return best;
  }

  _chooseCover( level, threat ) {
    if ( this.coverPoint ) {
      // Keep held cover unless the threat has flanked it.
      _dir.subVectors( threat, this.coverPoint.position ).setY( 0 ).normalize();
      if ( -this.coverPoint.normal.dot( _dir ) > 0.05 ) return;
      this.releaseCover();
    }
    const cp = level.findCover( this.position, threat, this.team === TEAM.SQUAD ? 9 : 14 );
    if ( cp ) {
      cp.occupied = this;
      this.coverPoint = cp;
    }
  }

  _think_( dt, ctx ) {
    const { enemies, level } = ctx;

    // Cohesion: a squad that lets every member solve its own cover problem
    // independently fans out across the whole arena and stops reading as a
    // squad. Straying too far overrides everything else.
    if ( ctx.centre && this.team === TEAM.SQUAD ) {
      const strayed = this.position.distanceTo( ctx.centre );
      if ( strayed > ctx.cohesion ) {
        this.releaseCover();
        this.state = 'regroup';
        this.destination = _v.copy( ctx.centre )
          .add( this.formationOffset ?? _ZERO )
          .sub( this.position ).setY( 0 ).normalize()
          .multiplyScalar( strayed - ctx.cohesion * 0.6 )
          .add( this.position ).clone();
        return;
      }
    }

    this._retargetTimer -= dt;
    if ( this._retargetTimer <= 0 || !this.target || this.target.dead ) {
      this.target = this._acquireTarget( enemies );
      this._retargetTimer = 0.35 + Math.random() * 0.3;
    }

    if ( !this.target ) {
      this.state = 'advance';
      this.destination = ctx.rally
        ? _v.copy( ctx.rally ).add( this.formationOffset ?? _ZERO ).clone()
        : null;
      return;
    }

    const dist = this.position.distanceTo( this.target.position );
    const visible = this.physics.lineOfSight( this.chestPoint( _v ), this.target.chestPoint( _v2 ), LAYER_STATIC );
    const idealRange = this.stats.range * 0.72;
    const inFightingRange = visible && dist <= this.stats.range * 1.05;

    // Cover is only worth taking once the fight is actually joined. Seeking
    // it the moment a target is *detected* — which can be 40 m out — makes
    // both sides dig in at their spawns and stare at each other, which is how
    // this read before the check was added.
    if ( !inFightingRange ) {
      this.releaseCover();
      this.state = 'advance';
      this.destination = _v.copy( this.target.position )
        .sub( this.position ).setY( 0 ).normalize()
        .multiplyScalar( Math.max( 1.5, dist - idealRange ) )
        .add( this.position ).clone();
      return;
    }

    this._chooseCover( level, this.target.position );

    if ( this.coverPoint && this.coverPoint.position.distanceTo( this.position ) > 0.7 ) {
      this.state = 'moveToCover';
      this.destination = this.coverPoint.position;
    } else if ( dist < this.stats.range * 0.30 && this.stats.kind !== 'shotgun' ) {
      this.state = 'backpedal';
      this.destination = _v.copy( this.position )
        .sub( this.target.position ).setY( 0 ).normalize()
        .multiplyScalar( 3 ).add( this.position ).clone();
    } else {
      this.state = 'engage';
      this.destination = null;
    }
  }

  /* ------------------------------------------------------------------ */

  update( dt, elapsed, ctx ) {
    if ( this.dead ) {
      this.statuses.length = 0;
      this.downedTimer += dt;
      this.animator.setSpeed( 0 );
      this.character.update( dt, elapsed );
      this.character.root.position.copy( this.body.position );
      return;
    }

    // Armour recovers after a lull, so falling back actually accomplishes
    // something.
    if ( this._armorRegen > 0 ) {
      this._armorRegen -= dt;
    } else if ( ( this._armorFloat ?? this.armorMax ) < this.armorMax ) {
      this._armorFloat = Math.min( this.armorMax, ( this._armorFloat ?? 0 ) + dt * 0.45 );
      this.armor = Math.ceil( this._armorFloat );
    }

    this._tickStatuses( dt );

    this._think -= dt;
    if ( this._think <= 0 ) {
      this._think = 0.12;
      this._think_( 0.12, ctx );
    }

    // --- movement --------------------------------------------------------
    let speedFrac = 0;
    if ( this.destination ) {
      _dir.subVectors( this.destination, this.position ).setY( 0 );
      const d = _dir.length();
      if ( d > 0.35 ) {
        _dir.divideScalar( d );
        const step = Math.min( this.moveSpeed * dt, d );
        this.physics.moveCharacter( this.body, _v.copy( _dir ).multiplyScalar( step ) );
        speedFrac = THREE.MathUtils.clamp( step / dt / this.moveSpeed, 0, 1 );
      } else {
        this.destination = null;
      }
    }
    this.animator.setSpeed( speedFrac );

    // --- facing ----------------------------------------------------------
    // Face the target while engaging, otherwise face the direction of travel.
    let faceDir = null;
    if ( this.target && !this.target.dead ) {
      faceDir = _v2.subVectors( this.target.position, this.position ).setY( 0 );
    } else if ( speedFrac > 0.05 ) {
      faceDir = _v2.copy( _dir );
    }
    if ( faceDir && faceDir.lengthSq() > 1e-6 ) {
      const want = Math.atan2( faceDir.x, faceDir.z );
      // Shortest-arc interpolation, or a unit crossing the ±π seam spins.
      let delta = ( want - this._facing + Math.PI * 3 ) % ( Math.PI * 2 ) - Math.PI;
      this._facing += delta * Math.min( 1, dt * 9 );
      this.character.root.rotation.y = this._facing;
    }

    // --- weapon ----------------------------------------------------------
    this._updateWeapon( dt, elapsed );

    // --- expression ------------------------------------------------------
    if ( this._expressionHold > 0 ) {
      this._expressionHold -= dt;
      if ( this._expressionHold <= 0 ) {
        this.character.setExpression( { eye: 'open', brow: 'neutral', mouth: this.state === 'engage' ? 'grimace' : 'smile' } );
      }
    }

    this.character.root.position.copy( this.body.position );
    this.character.update( dt, elapsed );

    // Dash inertia into the hair: the spring chains only know about gravity,
    // so movement has to be handed to them explicitly.
    if ( speedFrac > 0.05 ) {
      _v.copy( _dir ).multiplyScalar( -speedFrac * 1.6 );
      for ( const chain of this.character.springChains ) chain.setExternalForce( _v );
    } else {
      for ( const chain of this.character.springChains ) chain.setExternalForce( _ZERO );
    }
  }

  _updateWeapon( dt, elapsed ) {
    const canEngage = this.target && !this.target.dead;

    if ( canEngage ) {
      this.target.chestPoint( _aim );
      this.animator.setAim( _aim, 1 );
      this.character.lookAt( _aim );
    } else {
      this.animator.setAim( null, 0 );
      this.character.lookAt( null );
    }

    if ( this._reloadTimer > 0 ) {
      this._reloadTimer -= dt;
      if ( this._reloadTimer <= 0 ) this._ammo = this.stats.mag ?? 30;
      return;
    }

    this._fireCooldown -= dt;
    if ( !canEngage || this.state === 'advance' || this.state === 'regroup' ) return;
    if ( this._fireCooldown > 0 ) return;

    if ( this._ammo <= 0 ) {
      this._reloadTimer = this.stats.reload ?? 2;
      this.animator.reload();
      this.game?.onReload?.( this );
      return;
    }

    // Only shoot if the shot can actually get there — otherwise units burn
    // magazines into the cover they are hiding behind.
    if ( !this.physics.lineOfSight( this.chestPoint( _v ), _aim, LAYER_STATIC ) ) return;

    this.fire( _aim );
  }

  fire( aimPoint ) {
    const w = this.character.weapon;
    if ( !w ) return;

    w.muzzle.getWorldPosition( _muzzle );
    _dir.subVectors( aimPoint, _muzzle ).normalize();

    const pellets = this.stats.pellets ?? 1;
    const spread = this.stats.spread ?? 0.02;

    for ( let i = 0; i < pellets; i++ ) {
      _v.copy( _dir );
      if ( spread > 0 ) {
        // Cone spread sampled in the plane perpendicular to the shot.
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt( Math.random() ) * spread;
        _v2.set( _dir.z, 0, -_dir.x ).normalize();
        _v.addScaledVector( _v2, Math.cos( a ) * r );
        _v.addScaledVector( _v2.crossVectors( _dir, _v2 ).normalize(), Math.sin( a ) * r );
        _v.normalize();
      }
      this.game.spawnBullet( this, _muzzle, _v );
    }

    this._ammo--;
    this._fireCooldown = 60 / ( this.stats.rpm ?? 500 );
    this.animator.fire( 1 );
    this.game?.onFire?.( this, _muzzle, _dir );
  }
}

const _ZERO = new THREE.Vector3();

/** `0x8fb4e8` -> `'#8fb4e8'`, for handing engine colours to CSS. */
function hexToCss( hex ) {
  return typeof hex === 'string' ? hex : '#' + ( hex & 0xffffff ).toString( 16 ).padStart( 6, '0' );
}
