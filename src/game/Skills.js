import * as THREE from 'three';
import { TEAM } from './Unit.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * EX skills.
 *
 * Each is a cost, a cooldown, and a resolve function. Keeping them as plain
 * data plus one function means a skill can be added without touching the
 * combat loop, and the HUD reads the same objects it displays.
 */

export const SKILLS = {
  hoshi: {
    name: 'COVERING FIRE',
    icon: 'burst',
    cost: 3,
    cooldown: 14,
    flash: 'rgba(127,214,255,.9)',
    description: 'A sustained burst at the current target, ignoring cover.',
    resolve( game, caster ) {
      const target = caster.target ?? nearestHostile( game, caster );
      if ( !target ) return;

      // Twelve rounds over 1.2 s, fired straight from the muzzle regardless of
      // line of sight — the point of the skill is that it beats cover.
      let fired = 0;
      const tick = () => {
        if ( fired++ >= 12 || caster.dead || target.dead ) return;
        caster.character.weapon?.muzzle?.getWorldPosition( _v );
        target.chestPoint( _v2 );
        _v2.sub( _v ).normalize();
        game.spawnBullet( caster, _v, _v2 );
        caster.animator.fire( 1 );
        game.onFire( caster, _v, _v2 );
        setTimeout( tick, 100 );
      };
      tick();
      game.cameraRig.shake( 0.3, 4 );
    },
  },

  aoi: {
    name: 'SUPPRESSION NET',
    icon: 'aoe',
    cost: 4,
    cooldown: 18,
    flash: 'rgba(255,213,74,.85)',
    description: 'Slows and damages every hostile in a wide radius.',
    resolve( game, caster ) {
      const centre = caster.target ? caster.target.position.clone() : _v.copy( caster.position ).addScaledVector( forward( caster, _v2 ), 8 ).clone();

      game.vfx.emit( 'skillCast', { position: centre, scale: 2.2, count: 1.6, color: 0xffd54a } );
      game.vfx.rings?.spawn?.( centre, { radius: 7, color: 0xffd54a } );

      for ( const h of game.hostiles ) {
        if ( h.dead ) continue;
        const d = h.position.distanceTo( centre );
        if ( d > 7 ) continue;
        const falloff = 1 - ( d / 7 ) * 0.55;
        const dealt = h.takeDamage( 260 * falloff, forward( caster, _v2 ), 'weakness' );
        h.moveSpeed *= 0.55;
        setTimeout( () => { if ( h ) h.moveSpeed /= 0.55; }, 4000 );
        game._pendingDamage.push( { value: Math.round( dealt ), kind: 'weakness', position: h.chestPoint( new THREE.Vector3() ) } );
      }
    },
  },

  rei: {
    name: 'BREACH SHOT',
    icon: 'shot',
    cost: 4,
    cooldown: 16,
    flash: 'rgba(255,93,108,.85)',
    description: 'A single piercing slug that punches through everything in a line.',
    resolve( game, caster ) {
      const target = caster.target ?? nearestHostile( game, caster );
      caster.character.weapon?.muzzle?.getWorldPosition( _v );

      if ( target ) target.chestPoint( _v2 ).sub( _v ).normalize();
      else forward( caster, _v2 );

      game.ballistics.spawn( {
        origin: _v,
        direction: _v2,
        speed: 420,
        gravityScale: 0,
        radius: 0.35,
        damage: 900,
        owner: caster.body,
        ownerId: caster.body.id,
        mask: 1 | ( caster.team === TEAM.SQUAD ? 1 << 2 : 1 << 1 ),
        pierce: 6,
        maxLife: 1.5,
        onHit: ( hit ) => game._onBulletHit( caster, hit, _v2 ),
      } );

      game.vfx.emit( 'skillCast', { position: _v, direction: _v2, scale: 1.6, color: 0xff5d6c } );
      game.cameraRig.shake( 0.55, 3 );
    },
  },

  yuki: {
    name: 'FIELD REPAIR',
    icon: 'heal',
    cost: 3,
    cooldown: 20,
    flash: 'rgba(76,224,164,.85)',
    description: 'Restores the squad and grants a short damage shield.',
    resolve( game, caster ) {
      for ( const u of game.squad ) {
        if ( u.dead ) continue;
        const healed = u.heal( u.maxHp * 0.32 );
        u.armor += 2;
        setTimeout( () => { if ( u ) u.armor = Math.max( u.armorMax, u.armor - 2 ); }, 8000 );

        game.vfx.emit( 'healPulse', { position: u.position, scale: 1.2 } );
        if ( healed > 0 ) {
          game._pendingDamage.push( { value: Math.round( healed ), kind: 'heal', position: u.chestPoint( new THREE.Vector3() ) } );
        }
        caster.healingDone = ( caster.healingDone ?? 0 ) + healed;
      }
      game.vfx.rings?.spawn?.( caster.position, { radius: 5, color: 0x4ce0a4 } );
    },
  },

  default: {
    name: 'FOCUS FIRE',
    icon: 'burst',
    cost: 2,
    cooldown: 10,
    flash: 'rgba(127,214,255,.85)',
    description: 'A short accurate burst.',
    resolve( game, caster ) {
      const target = caster.target ?? nearestHostile( game, caster );
      if ( !target ) return;
      for ( let i = 0; i < 5; i++ ) {
        setTimeout( () => {
          if ( caster.dead || target.dead ) return;
          caster.character.weapon?.muzzle?.getWorldPosition( _v );
          target.chestPoint( _v2 ).sub( _v ).normalize();
          game.spawnBullet( caster, _v, _v2 );
        }, i * 90 );
      }
    },
  },
};

export function applySkill( game, caster, skill ) {
  skill.resolve( game, caster );
}

function forward( unit, out ) {
  return out.set( Math.sin( unit._facing ), 0, Math.cos( unit._facing ) ).normalize();
}

function nearestHostile( game, from ) {
  let best = null, bestDist = Infinity;
  const list = from.team === TEAM.SQUAD ? game.hostiles : game.squad;
  for ( const h of list ) {
    if ( h.dead ) continue;
    const d = h.position.distanceTo( from.position );
    if ( d < bestDist ) { bestDist = d; best = h; }
  }
  return best;
}
