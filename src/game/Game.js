import * as THREE from 'three';
import { PhysicsWorld, Ballistics, LAYER_STATIC, LAYER_CHARACTER, LAYER_ENEMY } from '../physics/World.js';
import { ParticleSystem } from '../render/Particles.js';
import { Level, ARENA } from '../gen/Level.js';
import { Unit, TEAM } from './Unit.js';
import { CameraRig } from './CameraRig.js';
import { STUDENT_PRESETS, ENEMY_PRESETS } from '../gen/Character.js';
import { SKILLS, applySkill } from './Skills.js';
import { WaveDirector } from './Waves.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _engage = new THREE.Vector3();

const SQUAD = [ 'hoshi', 'aoi', 'rei', 'yuki' ];

/**
 * Orchestrates a mission: level, squad, wave director, combat resolution,
 * camera, VFX and the HUD state feed.
 *
 * Nothing here owns rendering — the Engine does — so the whole game loop is
 * a pure simulation step followed by one pass that projects the simulation
 * into the flat state object the HUD consumes.
 */
export class Game {
  constructor( { scene, camera, hud, audio, quality = 2 } ) {
    this.scene = scene;
    this.camera = camera;
    this.hud = hud;
    this.audio = audio;
    this.quality = quality;

    this.physics = new PhysicsWorld( { gravity: -22, cellSize: 4 } );
    this.ballistics = new Ballistics( this.physics, { capacity: 512 } );
    this.vfx = new ParticleSystem( scene, { camera, capacity: quality >= 2 ? 4000 : 1800 } );

    this.level = new Level( this.physics, { quality } );
    scene.add( this.level.group );

    this.cameraRig = new CameraRig( camera, { distance: 8.6, pitch: 0.34 } );

    this.squad = [];
    this.hostiles = [];
    this.units = [];

    this.cost = 4;
    this.costMax = 10;
    this.costRate = 0.62;             // per second
    this.combo = 0;
    this._comboTimer = 0;
    this.score = 0;
    this.damageTaken = 0;
    this.maxCombo = 0;

    this.phase = 'title';
    this.time = 0;
    this.timeLimit = 300;

    this.boss = null;
    this.rally = new THREE.Vector3( 0, 0, -2 );
    this.squadCentre = new THREE.Vector3( 0, 0, 14 );
    this.director = new WaveDirector( this );

    this._pendingDamage = [];
    this._events = [];
    this._hudState = this._makeHudState();

    this._spawnSquad();
  }

  /* ------------------------------------------------------------------ */
  /* Setup                                                               */
  /* ------------------------------------------------------------------ */

  _spawnSquad() {
    SQUAD.forEach( ( key, i ) => {
      // A shallow wedge: leads forward and outboard, support tucked behind.
      const lane = i - ( SQUAD.length - 1 ) / 2;
      const unit = new Unit( {
        preset: key,
        team: TEAM.SQUAD,
        position: this.level.spawns.squad[ i ].clone(),
        physics: this.physics,
        game: this,
        quality: this.quality,
        formationOffset: new THREE.Vector3( lane * 1.9, 0, Math.abs( lane ) * 1.5 ),
      } );
      unit.skill = SKILLS[ key ] ?? SKILLS.default;
      unit.skillCooldown = 0;
      this.scene.add( unit.character.root );
      this.squad.push( unit );
      this.units.push( unit );
    } );
  }

  spawnHostile( presetKey, position ) {
    const unit = new Unit( {
      preset: presetKey,
      team: TEAM.HOSTILE,
      position,
      physics: this.physics,
      game: this,
      quality: this.quality,
    } );
    this.scene.add( unit.character.root );
    this.hostiles.push( unit );
    this.units.push( unit );
    return unit;
  }

  start() {
    this.phase = 'playing';
    this.time = 0;
    this.director.start();
    this.audio?.setState?.( 'combat' );
  }

  /* ------------------------------------------------------------------ */
  /* Combat                                                              */
  /* ------------------------------------------------------------------ */

  spawnBullet( shooter, origin, direction ) {
    const s = shooter.stats;
    const enemyLayer = shooter.team === TEAM.SQUAD ? LAYER_ENEMY : LAYER_CHARACTER;

    this.ballistics.spawn( {
      origin,
      direction,
      speed: s.speed ?? 180,
      gravityScale: 0.12,
      drag: 0.02,
      radius: 0.06,
      damage: s.damage ?? 8,
      owner: shooter.body,
      ownerId: shooter.body.id,
      mask: LAYER_STATIC | enemyLayer,
      maxLife: 2.5,
      onHit: ( hit ) => this._onBulletHit( shooter, hit, direction ),
    } );

    // A tracer on every round would be a wall of light; one in three reads as
    // continuous fire while leaving the individual shots legible.
    //
    // The trail sprites carry only a couple of metres per second of their own
    // velocity, so emitting one at the muzzle left them stalled in a little
    // cloud at the shooter's hands rather than streaking down the shot line.
    // Seeding several along the path draws the line directly.
    if ( Math.random() < 0.34 ) {
      const tint = shooter.team === TEAM.SQUAD ? 0x9fe0ff : 0xffb08a;
      for ( let k = 0; k < 4; k++ ) {
        _v.copy( origin ).addScaledVector( direction, 0.7 + k * 1.7 );
        this.vfx.emit( 'bulletTrail', { position: _v, direction, count: 0.6, color: tint } );
      }
    }
  }

  _onBulletHit( shooter, hit, direction ) {
    const victim = hit.body?.userData;

    if ( victim instanceof Unit && victim.team !== shooter.team && !victim.dead ) {
      // Weak point: a hit above the shoulder line crits.
      const headY = victim.position.y + 1.38 * ( victim.character.design.scale ?? 1 );
      const crit = hit.point.y > headY;
      const damage = ( shooter.stats.damage ?? 8 ) * ( crit ? 2.1 : 1 );

      _v.copy( direction ).setY( 0 ).normalize();
      const dealt = victim.takeDamage( damage, _v, crit ? 'critical' : 'normal' );

      this.vfx.emit( 'impactFlesh', { position: hit.point, direction: hit.normal, scale: crit ? 0.75 : 0.5, count: 0.7 } );
      this.vfx.emit( 'hitSpark', { position: hit.point, direction: hit.normal, scale: crit ? 0.85 : 0.6 } );

      this._pendingDamage.push( {
        value: Math.round( dealt ),
        kind: crit ? 'critical' : 'normal',
        position: hit.point.clone(),
      } );

      if ( shooter.team === TEAM.SQUAD ) {
        this.score += Math.round( dealt );
        this.combo++;
        this._comboTimer = 2.4;
        this.maxCombo = Math.max( this.maxCombo, this.combo );
        this.audio?.playAt?.( crit ? 'criticalHit' : 'impactBody', hit.point );
      } else {
        this.damageTaken += dealt;
        this.hud?.hit?.( this._screenAngleTo( shooter.position ), Math.min( 1, dealt / 200 ) );
      }
    } else {
      const material = hit.tag === 'world' || hit.tag === 'cover' ? 'impactConcrete' : 'impactMetal';
      this.vfx.emit( material, { position: hit.point, direction: hit.normal } );

      // Decals now orient to the surface they landed on, so wall and crate
      // hits mark too — the arena used to come through a three-minute
      // firefight completely spotless because every non-ground hit had to be
      // suppressed.
      this.vfx.decals.spawn( {
        position: hit.point,
        normal: hit.normal,
        type: 'bullet',
        radius: 0.075 + Math.random() * 0.045,
        opacity: 0.40,
        life: 16,
        rotation: Math.random() * Math.PI * 2,
        color: 0x2f2a3d,
      } );
      this.audio?.playAt?.( 'impactConcrete', hit.point );
    }
  }

  /** Angle of a world point relative to the camera's forward, for the hit vignette. */
  _screenAngleTo( worldPoint ) {
    _v.subVectors( worldPoint, this.camera.position ).setY( 0 ).normalize();
    this.camera.getWorldDirection( _v2 ).setY( 0 ).normalize();
    const cross = _v2.x * _v.z - _v2.z * _v.x;
    return Math.atan2( cross, _v2.dot( _v ) ) * ( 180 / Math.PI );
  }

  onUnitDown( unit, fromDirection ) {
    this.vfx.emit( 'impactFlesh', { position: unit.chestPoint( _v ), direction: fromDirection ?? _UP, scale: 1.1, count: 1.2 } );
    this.cameraRig.shake( unit.team === TEAM.SQUAD ? 0.5 : 0.18 );

    if ( unit.team === TEAM.HOSTILE ) {
      this.score += 500;
      this.cost = Math.min( this.costMax, this.cost + 0.35 );
      this.audio?.play?.( 'downed' );
    } else {
      this.audio?.play?.( 'downed' );
      this.hud?.flash?.( 'rgba(255,93,108,.85)' );
    }
  }

  onFire( unit, muzzlePos, direction ) {
    // Head-height, not torso-height. A flash wider than the character firing
    // it erases the shooter, and the reader loses track of who is engaging.
    this.vfx.emit( 'muzzleFlash', {
      position: muzzlePos,
      direction,
      scale: unit.stats.kind === 'sniper' ? 1.35 : ( unit.stats.kind === 'shotgun' ? 1.25 : 1.0 ),
      count: 0.85,
      color: unit.team === TEAM.SQUAD ? undefined : 0xffa070,
    } );
    const eject = unit.character.weapon?.ejectPort;
    if ( eject ) this.vfx.emit( 'shellCasing', { position: eject.getWorldPosition( _v ), direction: _v2.set( 1, 0.6, 0 ) } );

    const sound = { rifle: 'rifleShot', smg: 'smgShot', shotgun: 'shotgunBlast', sniper: 'sniperShot' }[ unit.stats.kind ] ?? 'rifleShot';
    this.audio?.playAt?.( sound, muzzlePos );

    if ( unit.team === TEAM.SQUAD ) {
      this.cameraRig.shake( unit.stats.kind === 'sniper' ? 0.22 : 0.05, 6 );
    }
  }

  onReload( unit ) {
    this.audio?.playAt?.( 'reload', unit.position );
  }

  /* ------------------------------------------------------------------ */
  /* Skills                                                              */
  /* ------------------------------------------------------------------ */

  useSkill( index ) {
    const unit = this.squad[ index ];
    if ( !unit || unit.dead || this.phase !== 'playing' ) return false;
    const skill = unit.skill;
    if ( unit.skillCooldown > 0 || this.cost < skill.cost ) {
      this.audio?.play?.( 'uiError' );
      return false;
    }

    this.cost -= skill.cost;
    unit.skillCooldown = skill.cooldown;
    unit.animator.castSkill();
    unit.character.setExpression( { eye: 'wide', brow: 'angry', mouth: 'open' } );
    unit._expressionHold = 1.2;

    applySkill( this, unit, skill );

    this.cameraRig.punchFov( -5 );
    this.cameraRig.shake( 0.35 );
    this.hud?.flash?.( skill.flash ?? 'rgba(127,214,255,.9)' );
    this.audio?.play?.( 'skillCast' );
    this._events.push( { type: 'skill', name: skill.name, unit: unit.name } );
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update( dt, elapsed ) {
    if ( this.phase === 'playing' ) {
      this.time += dt;
      this.cost = Math.min( this.costMax, this.cost + this.costRate * dt );

      this._comboTimer -= dt;
      if ( this._comboTimer <= 0 ) this.combo = 0;

      for ( const u of this.squad ) if ( u.skillCooldown > 0 ) u.skillCooldown = Math.max( 0, u.skillCooldown - dt );

      this.director.update( dt );
    }

    // Squad centroid, recomputed once per frame and shared with every unit's
    // think step so cohesion is measured against the same point.
    const alive = this.squad.filter( ( u ) => !u.dead );
    if ( alive.length ) {
      _centre.set( 0, 0, 0 );
      for ( const u of alive ) _centre.add( u.position );
      _centre.divideScalar( alive.length );
      this.squadCentre.copy( _centre );
    }

    const ctx = {
      level: this.level,
      rally: this.rally,
      centre: this.squadCentre,
      cohesion: 7.5,
    };

    for ( const u of this.units ) {
      ctx.enemies = u.team === TEAM.SQUAD ? this.hostiles : this.squad;
      u.update( dt, elapsed, ctx );
    }

    this.physics.step( dt );
    this.ballistics.step( dt );
    this.vfx.update( dt, this.camera );

    this._reapDead();
    this._updateCamera( dt );
    this._checkEndConditions();
  }

  _reapDead() {
    for ( let i = this.units.length - 1; i >= 0; i-- ) {
      const u = this.units[ i ];
      if ( !u.dead || u.downedTimer < 4 ) continue;
      // Hostiles clear out; downed squad members stay on the field so the
      // player can see who is left standing.
      if ( u.team !== TEAM.HOSTILE ) continue;
      if ( u === this.boss ) this.boss = null;

      u.dispose();
      this.units.splice( i, 1 );
      const j = this.hostiles.indexOf( u );
      if ( j >= 0 ) this.hostiles.splice( j, 1 );
    }
  }

  _updateCamera( dt ) {
    const alive = this.squad.filter( ( u ) => !u.dead );
    if ( !alive.length ) return;

    _centre.set( 0, 0, 0 );
    for ( const u of alive ) _centre.add( u.position );
    _centre.divideScalar( alive.length );

    let spread = 0;
    for ( const u of alive ) spread = Math.max( spread, u.position.distanceTo( _centre ) );

    // Frame toward the nearest live threat, if there is one.
    let nearest = null, nearestDist = Infinity;
    for ( const h of this.hostiles ) {
      if ( h.dead ) continue;
      const d = h.position.distanceTo( _centre );
      if ( d < nearestDist ) { nearestDist = d; nearest = h; }
    }

    if ( nearest && nearestDist < 30 ) {
      _engage.copy( nearest.position );
      this.cameraRig.update( dt, _centre, _engage, spread );
    } else {
      this.cameraRig.update( dt, _centre, null, spread );
    }
  }

  _checkEndConditions() {
    if ( this.phase !== 'playing' ) return;

    if ( this.squad.every( ( u ) => u.dead ) ) {
      this.phase = 'results';
      this.failed = true;
      this.audio?.setState?.( 'defeat' );
      this.audio?.play?.( 'missionFailed' );
      return;
    }
    if ( this.director.finished && this.hostiles.every( ( h ) => h.dead ) ) {
      this.phase = 'results';
      this.failed = false;
      this.audio?.setState?.( 'victory' );
      this.audio?.play?.( 'missionComplete' );
    }
  }

  /* ------------------------------------------------------------------ */
  /* HUD projection                                                      */
  /* ------------------------------------------------------------------ */

  _makeHudState() {
    return {
      phase: 'title',
      mission: {
        name: 'KIVOTOS PLAZA',
        subtitle: 'OPERATION 01-1 · NORMAL',
        objective: 'Clear all hostile waves',
        wave: 0, waves: 0, time: 0, timeLimit: this.timeLimit,
      },
      boss: { visible: false },
      squad: [],
      cost: { value: 0, max: this.costMax },
      skills: [],
      markers: [],
      feedback: { lowHp: false },
      combo: 0,
      score: 0,
      events: [],
      results: null,
    };
  }

  /** Projects the simulation into the flat object the HUD consumes. */
  hudState() {
    const s = this._hudState;

    s.phase = this.phase;
    s.mission.wave = this.director.wave;
    s.mission.waves = this.director.totalWaves;
    s.mission.time = this.time;

    s.squad.length = 0;
    for ( const u of this.squad ) {
      s.squad.push( {
        id: u.id,
        name: u.name,
        role: ROLE_BY_WEAPON[ u.stats.kind ] ?? 'ATK',
        color: u.color,
        accent: u.accent,
        hairStyle: u.character.design.hair?.style,
        hp: Math.round( u.hp ),
        maxHp: Math.round( u.maxHp ),
        tickEvery: 500,
        armor: u.armor,
        armorMax: u.armorMax,
        dead: u.dead,
        active: !u.dead,
        status: u.statuses,
      } );
    }

    s.cost.value = this.cost;
    s.cost.max = this.costMax;

    s.skills.length = 0;
    this.squad.forEach( ( u, i ) => {
      s.skills.push( {
        name: u.skill.name,
        student: u.name,
        key: String( i + 1 ),
        icon: u.skill.icon,
        color: u.color,
        cost: u.skill.cost,
        cooldown: u.skillCooldown,
        cooldownMax: u.skill.cooldown,
        locked: u.dead,
      } );
    } );

    // --- boss bar ---------------------------------------------------------
    if ( this.boss && !this.boss.dead ) {
      s.boss.visible = true;
      s.boss.name = this.boss.name;
      s.boss.tag = 'BOSS';
      s.boss.hp = Math.round( this.boss.hp );
      s.boss.maxHp = Math.round( this.boss.maxHp );
      s.boss.shield = 0;
      s.boss.ticks = 24;
      s.boss.phases = this.boss.phases ?? [];
    } else {
      s.boss.visible = false;
    }

    // Cap the plate count and prefer what is close and dangerous. A late wave
    // puts a dozen identical GRUNT plates on screen, which collapse into an
    // unreadable stripe of overlapping text.
    s.markers.length = 0;
    const live = this.hostiles.filter( ( h ) => !h.dead );
    if ( live.length > MAX_MARKERS ) {
      live.sort( ( a, b ) =>
        a.position.distanceToSquared( this.camera.position ) -
        b.position.distanceToSquared( this.camera.position ) );
      live.length = MAX_MARKERS;
    }
    for ( const h of live ) {
      s.markers.push( {
        id: h.id,
        type: 'enemy',
        position: h.position,
        offset: 1.95 * ( h.character.design.scale ?? 1 ),
        name: h.name,
        hp: Math.round( h.hp ),
        maxHp: Math.round( h.maxHp ),
        shield: 0,
        tags: h.statuses.length ? h.statuses.map( ( st ) => st.name.toUpperCase() )
          : ( h.armor > 0 ? [ 'HEAVY' ] : [ 'LIGHT' ] ),
        // Nameplates were drawing at full strength through containers and
        // planters that completely hide their owner, which reads as the UI
        // lying about what the player can see.
        occluded: !this.physics.lineOfSight( this.camera.position, h.headPoint( _v ), LAYER_STATIC ),
      } );
    }

    const alive = this.squad.filter( ( u ) => !u.dead );
    s.feedback.lowHp = alive.length > 0 && alive.some( ( u ) => u.hp / u.maxHp < 0.3 );

    s.combo = this.combo;
    s.score = this.score;
    s.events = this._events;
    this._events = [];

    if ( this.phase === 'results' ) {
      s.results = this._buildResults();
    } else {
      s.results = null;
    }

    return s;
  }

  _buildResults() {
    if ( this._results ) return this._results;

    const clearRatio = this.director.totalWaves > 0 ? this.director.clearedWaves / this.director.totalWaves : 0;
    const survivors = this.squad.filter( ( u ) => !u.dead ).length;
    const rank = this.failed ? 'C'
      : this.score > 60000 && survivors === 4 ? 'S'
      : this.score > 35000 ? 'A'
      : this.score > 18000 ? 'B' : 'C';

    this._results = {
      title: this.failed ? 'MISSION FAILED' : 'MISSION COMPLETE',
      fail: !!this.failed,
      rank,
      score: Math.round( this.score ),
      time: Math.round( this.time ),
      waves: this.director.clearedWaves,
      wavesTotal: this.director.totalWaves,
      combo: this.maxCombo,
      stats: [
        { label: 'SCORE', value: Math.round( this.score ).toLocaleString() },
        { label: 'CLEAR TIME', value: formatClock( this.time ) },
        { label: 'WAVES CLEARED', value: `${this.director.clearedWaves} / ${this.director.totalWaves}` },
        { label: 'MAX COMBO', value: String( this.maxCombo ) },
        { label: 'DAMAGE TAKEN', value: Math.round( this.damageTaken ).toLocaleString() },
        { label: 'SURVIVORS', value: `${survivors} / 4` },
      ],
      units: this.squad.map( ( u ) => ( {
        id: u.id, name: u.name, color: u.color,
        damage: Math.round( u.damageDealt ?? 0 ),
        kills: u.kills ?? 0,
        healed: Math.round( u.healingDone ?? 0 ),
      } ) ),
    };
    return this._results;
  }

  /** Damage numbers accumulated this frame, drained by the HUD feed. */
  drainDamage() {
    const out = this._pendingDamage;
    this._pendingDamage = [];
    return out;
  }

  /**
   * Restarts the mission without a page reload.
   *
   * Reloading dropped the player back through the shader-compile boot screen
   * for a retry, which is the worst possible moment to make them wait. Tearing
   * down the units and re-seeding the director keeps the level, materials and
   * compiled programs alive, so a retry is instant.
   */
  restart() {
    for ( const u of this.units ) u.dispose();
    this.units.length = 0;
    this.squad.length = 0;
    this.hostiles.length = 0;

    for ( const cp of this.level.coverPoints ) cp.occupied = null;
    this.ballistics.clear();
    this.vfx.clear();

    this.cost = 4;
    this.combo = 0;
    this.maxCombo = 0;
    this.score = 0;
    this.damageTaken = 0;
    this.time = 0;
    this.failed = false;
    this._results = null;
    this._pendingDamage.length = 0;
    this._events.length = 0;

    this.boss = null;
    this.rally.set( 0, 0, -2 );
    this.squadCentre.set( 0, 0, 14 );
    this.director = new WaveDirector( this );

    this._spawnSquad();
    this.cameraRig.enabled = true;
    this.start();
  }

  setQuality( level ) {
    this.quality = level;
    this.vfx.setQuality( level );
    this.level.setQuality( level );
    for ( const u of this.units ) u.character.setQuality( level );
  }

  onResize( w, h, pr ) {
    this.level.onResize( w, h, pr );
    this.vfx.setSize?.( w, h, pr );
    for ( const u of this.units ) u.character.onResize( w, h, pr );
  }

  dispose() {
    for ( const u of this.units ) u.dispose();
    this.level.dispose();
    this.vfx.dispose();
  }
}

const _UP = new THREE.Vector3( 0, 1, 0 );

/** Most world-space nameplates drawn at once. */
const MAX_MARKERS = 7;

/** Weapon archetype -> the role label shown on the roster card. */
// The roster chip clips to three characters, so these are authored to read
// correctly truncated rather than being cut into something unfortunate.
const ROLE_BY_WEAPON = {
  rifle: 'ATK',
  smg: 'SMG',
  shotgun: 'CQB',
  sniper: 'SNP',
};

/**
 * Matches the in-game clock's `MM:SS` exactly. The results screen previously
 * used a second formatter, so one value appeared in two shapes in a single
 * session ("0:20" on the results card, "00:25" on the HUD).
 */
function formatClock( seconds ) {
  const m = Math.floor( seconds / 60 );
  const s = Math.floor( seconds % 60 );
  return `${String( m ).padStart( 2, '0' )}:${String( s ).padStart( 2, '0' )}`;
}

export { ARENA, TEAM };
