import * as THREE from 'three';

/**
 * Wave director.
 *
 * Waves escalate in composition rather than in raw count: adding more of the
 * same grunt makes an encounter longer, whereas introducing an armoured unit
 * makes it different. Spawn points are picked away from the squad so hostiles
 * never materialise inside the player's field of view.
 */

const WAVES = [
  { grunts: 3, heavies: 0, delay: 2.0 },
  { grunts: 4, heavies: 0, delay: 3.5 },
  { grunts: 4, heavies: 1, delay: 3.5 },
  { grunts: 5, heavies: 1, delay: 4.0 },
  { grunts: 5, heavies: 2, delay: 4.0 },
  { grunts: 6, heavies: 2, delay: 4.5 },
  { grunts: 6, heavies: 3, delay: 4.5 },
  { grunts: 8, heavies: 3, delay: 5.0 },
];

const _v = new THREE.Vector3();

export class WaveDirector {
  constructor( game ) {
    this.game = game;
    this.wave = 0;
    this.clearedWaves = 0;
    this.totalWaves = WAVES.length;
    this.finished = false;
    this._timer = 0;
    this._state = 'idle';
    this._spawnQueue = [];
    this._spawnTimer = 0;
  }

  start() {
    this._state = 'between';
    this._timer = 1.5;
  }

  update( dt ) {
    if ( this._state === 'idle' || this.finished ) return;

    // Trickle the queue in rather than popping a whole wave at once — a row
    // of units appearing on the same frame reads as a spawner, not a push.
    if ( this._spawnQueue.length ) {
      this._spawnTimer -= dt;
      if ( this._spawnTimer <= 0 ) {
        this._spawnOne( this._spawnQueue.shift() );
        this._spawnTimer = 0.28;
      }
      return;
    }

    if ( this._state === 'between' ) {
      this._timer -= dt;
      if ( this._timer <= 0 ) this._beginWave();
      return;
    }

    if ( this._state === 'active' ) {
      const remaining = this.game.hostiles.filter( ( h ) => !h.dead ).length;
      if ( remaining === 0 ) {
        this.clearedWaves = this.wave;
        if ( this.wave >= WAVES.length ) {
          this.finished = true;
          this._state = 'idle';
        } else {
          this._state = 'between';
          this._timer = WAVES[ this.wave ].delay;
          this.game._events.push( { type: 'waveCleared', wave: this.wave } );
        }
      }
    }
  }

  _beginWave() {
    const spec = WAVES[ this.wave ];
    this.wave++;
    this._state = 'active';

    for ( let i = 0; i < spec.grunts; i++ ) this._spawnQueue.push( 'grunt' );
    for ( let i = 0; i < spec.heavies; i++ ) this._spawnQueue.push( 'heavy' );

    // Interleave so heavies don't all arrive last.
    this._spawnQueue.sort( () => Math.random() - 0.5 );
    this._spawnTimer = 0;

    this.game._events.push( { type: 'wave', wave: this.wave, total: this.totalWaves } );
    this.game.hud?.banner?.( `WAVE ${String( this.wave ).padStart( 2, '0' )}`, 'HOSTILES INBOUND', 'wave' );
    this.game.audio?.play?.( 'waveIncoming' );
    this.game.audio?.setIntensity?.( 0.4 + ( this.wave / this.totalWaves ) * 0.6 );
  }

  _spawnOne( kind ) {
    const spawns = this.game.level.spawns.hostile;

    // Pick the spawn furthest from the squad, with jitter so repeat waves
    // don't file in through the same door.
    let best = spawns[ 0 ], bestDist = -Infinity;
    const centre = this._squadCentre( _v );
    for ( const s of spawns ) {
      const d = s.distanceTo( centre ) + Math.random() * 6;
      if ( d > bestDist ) { bestDist = d; best = s; }
    }

    const pos = best.clone();
    pos.x += ( Math.random() - 0.5 ) * 3.5;
    pos.z += ( Math.random() - 0.5 ) * 2.5;

    const unit = this.game.spawnHostile( kind, pos );
    this.game.vfx.emit( 'dust', { position: pos, scale: 1.4 } );
    return unit;
  }

  _squadCentre( out ) {
    const alive = this.game.squad.filter( ( u ) => !u.dead );
    out.set( 0, 0, 0 );
    if ( !alive.length ) return out;
    for ( const u of alive ) out.add( u.position );
    return out.divideScalar( alive.length );
  }
}
