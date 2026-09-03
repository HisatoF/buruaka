import * as THREE from 'three';

/**
 * Hostile archetypes.
 *
 * Each one is defined by the tactical problem it poses, not by its stat line.
 * More of the same grunt makes an encounter longer; a unit that has to be
 * flanked, or one that must be killed first, makes it different. Every entry
 * here changes at least one of: where the squad has to stand, which target
 * they should shoot first, or how quickly they have to react.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * @typedef {object} Archetype
 * @property {string} label            Shown on the world-space nameplate.
 * @property {string[]} tags           Nameplate chips.
 * @property {number} hp
 * @property {number} armor
 * @property {number} speedMul
 * @property {number} standoff         Multiplier on the ideal engagement range.
 * @property {number} [coverAffinity=1] 0 = ignores cover entirely.
 * @property {number} [threat=1]        Target-priority weight for squad AI.
 */

export const ARCHETYPES = {
  /** Baseline. Everything else is a departure from this. */
  grunt: {
    label: 'GRUNT', tags: [ 'LIGHT' ],
    hp: 620, armor: 0, speedMul: 1, standoff: 0.72, threat: 1,
  },

  /** Slow, armoured, soaks a magazine. Rewards focus fire. */
  heavy: {
    label: 'HEAVY', tags: [ 'ARMOR' ],
    hp: 1500, armor: 4, speedMul: 0.8, standoff: 0.55, threat: 1.4,
  },

  /**
   * Holds at the far edge of its weapon's range and telegraphs each shot with
   * a sight line. The player's counter is to break line of sight or push —
   * standing still in the open is what it punishes.
   */
  marksman: {
    label: 'MARKSMAN', tags: [ 'SNIPER' ],
    hp: 460, armor: 0, speedMul: 0.85, standoff: 1.5, threat: 2.2,
    telegraph: 0.95,
    coverAffinity: 1.3,
  },

  /**
   * No gun. Sprints the whole way in and swings. Ignores cover because cover
   * is irrelevant to it, which forces the squad to break formation and deal
   * with it before it arrives.
   */
  rusher: {
    label: 'RUSHER', tags: [ 'RUSH' ],
    hp: 520, armor: 0, speedMul: 2.0, standoff: 0.06, threat: 1.8,
    coverAffinity: 0,
    melee: { range: 2.1, damage: 210, cooldown: 1.2, windup: 0.42 },
  },

  /**
   * Carries a shield and takes almost nothing from the front, so shooting it
   * head-on is a waste of a magazine. It has to be flanked, which means
   * somebody has to leave cover.
   */
  bulwark: {
    label: 'BULWARK', tags: [ 'SHIELD' ],
    hp: 2400, armor: 5, speedMul: 0.62, standoff: 0.42, threat: 1.6,
    frontalReduction: 0.86,
    shieldArc: 0.62,          // cosine threshold; ~52 degrees either side
    coverAffinity: 0.4,
  },

  /**
   * Heals everything around it on a timer and hangs back. Ignoring it makes
   * every other hostile in the wave effectively tougher, so it is the
   * priority target — which is exactly the decision it exists to create.
   */
  mender: {
    label: 'MENDER', tags: [ 'SUPPORT' ],
    hp: 780, armor: 1, speedMul: 1.05, standoff: 1.9, threat: 2.6,
    coverAffinity: 1.4,
    heal: { radius: 8, amount: 130, interval: 2.8 },
  },

  /** The mission's climax. */
  boss: {
    label: 'HIEROMONK', tags: [ 'BOSS' ],
    hp: 26000, armor: 6, speedMul: 0.62, standoff: 0.5, threat: 4,
    frontalReduction: 0.35,
    shieldArc: 0.4,
    coverAffinity: 0.2,
  },
};

/**
 * Applies an archetype to a freshly built unit.
 * Kept separate from the Unit constructor so archetypes stay data.
 */
export function applyArchetype( unit, name ) {
  const a = ARCHETYPES[ name ] ?? ARCHETYPES.grunt;
  const scale = unit.character.design.scale ?? 1;

  unit.archetype = name;
  unit.arch = a;
  unit.name = a.label;
  unit.tags = a.tags;
  unit.threat = a.threat ?? 1;

  unit.maxHp = unit.hp = a.hp * scale;
  unit.armor = unit.armorMax = unit._armorFloat = a.armor;
  unit.moveSpeed *= a.speedMul;
  unit.coverAffinity = a.coverAffinity ?? 1;

  if ( a.melee ) {
    // `interval` is the gap between swings; `cooldown` is the live timer.
    unit.melee = { ...a.melee, interval: a.melee.cooldown, cooldown: 0, windupLeft: 0 };
    // A rusher carries no firearm, so the aim layer has nothing to solve.
    unit.character.weapon?.group?.removeFromParent?.();
    unit.character.weapon = null;
  }
  if ( a.heal ) unit.healPulse = { ...a.heal, timer: a.heal.interval * Math.random() };
  if ( a.telegraph ) unit.telegraph = { duration: a.telegraph, left: 0 };

  return unit;
}

/**
 * Directional damage reduction for shield-carrying archetypes.
 *
 * @param {object} unit
 * @param {THREE.Vector3} fromDirection  Travel direction of the incoming shot.
 * @returns {number} Multiplier in [0,1].
 */
export function frontalMitigation( unit, fromDirection ) {
  const a = unit.arch;
  if ( !a || !a.frontalReduction || !fromDirection ) return 1;

  // The unit's own facing, and the direction the shot came *from*.
  _v.set( Math.sin( unit._facing ), 0, Math.cos( unit._facing ) ).normalize();
  _v2.copy( fromDirection ).setY( 0 );
  if ( _v2.lengthSq() < 1e-6 ) return 1;
  _v2.normalize().negate();

  // Facing into the shot means the shield is between them.
  return _v.dot( _v2 ) >= a.shieldArc ? 1 - a.frontalReduction : 1;
}

/**
 * Per-frame archetype behaviour that does not belong in the generic unit
 * update: melee swings, heal pulses, and shot telegraphs.
 */
export function updateArchetype( unit, dt, game ) {
  if ( unit.dead ) return;

  // --- melee ------------------------------------------------------------
  if ( unit.melee ) {
    const m = unit.melee;
    m.cooldown = Math.max( 0, m.cooldown - dt );

    if ( m.windupLeft > 0 ) {
      m.windupLeft -= dt;
      if ( m.windupLeft <= 0 ) _resolveMelee( unit, game );
    } else if ( m.cooldown <= 0 && unit.target && !unit.target.dead ) {
      const d = unit.position.distanceTo( unit.target.position );
      if ( d <= m.range ) {
        // Wind up visibly before connecting, so a swing can be reacted to
        // rather than simply happening.
        m.windupLeft = m.windup;
        m.cooldown = m.windup + m.interval;
        unit.animator.castSkill();
        game.audio?.playAt?.( 'dashWhoosh', unit.position );
      }
    }
  }

  // --- heal pulse -------------------------------------------------------
  if ( unit.healPulse ) {
    const h = unit.healPulse;
    h.timer -= dt;
    if ( h.timer <= 0 ) {
      h.timer = h.interval;
      let healed = 0;
      for ( const other of game.hostiles ) {
        if ( other.dead || other === unit ) continue;
        if ( other.position.distanceTo( unit.position ) > h.radius ) continue;
        const before = other.hp;
        other.heal( h.amount );
        if ( other.hp > before ) {
          healed++;
          game._pendingDamage.push( {
            value: Math.round( other.hp - before ),
            kind: 'heal',
            position: other.chestPoint( new THREE.Vector3() ),
          } );
        }
      }
      if ( healed ) {
        game.vfx.emit( 'healPulse', { position: unit.position, scale: 1.5, count: 1.2 } );
        game.vfx.rings?.spawn?.( unit.position, { radius: h.radius * 0.8, color: 0x4ce0a4 } );
        game.audio?.playAt?.( 'healPulse', unit.position );
      }
    }
  }

  // --- shot telegraph ---------------------------------------------------
  if ( unit.telegraph ) unit.telegraph.left = Math.max( 0, unit.telegraph.left - dt );
}

function _resolveMelee( unit, game ) {
  const target = unit.target;
  if ( !target || target.dead ) return;
  const m = unit.melee;
  if ( unit.position.distanceTo( target.position ) > m.range * 1.35 ) return;

  _v.subVectors( target.position, unit.position ).setY( 0 ).normalize();
  const dealt = target.takeDamage( m.damage, _v, 'normal' );

  game._pendingDamage.push( {
    value: Math.round( dealt ),
    kind: 'normal',
    position: target.chestPoint( new THREE.Vector3() ),
  } );
  game.vfx.emit( 'impactFlesh', { position: target.chestPoint( _v2 ), direction: _v, scale: 1.0, count: 1.1 } );
  game.cameraRig.shake( 0.30 );
  game.damageTaken += dealt;
  game.hud?.hit?.( game._screenAngleTo( unit.position ), Math.min( 1, dealt / 240 ) );
  game.audio?.playAt?.( 'impactBody', target.position );
}
