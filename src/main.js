import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { Sky } from './render/Sky.js';
import { LightingRig } from './render/Lighting.js';
import { Game } from './game/Game.js';
import { HUD } from './ui/HUD.js';
import { AudioEngine } from './core/Audio.js';

const boot = document.getElementById( 'boot' );
const bootBar = boot?.querySelector( '.boot-bar i' );
const bootStatus = boot?.querySelector( '.boot-status' );

function progress( pct, label ) {
  if ( bootBar ) bootBar.style.width = `${Math.round( pct * 100 )}%`;
  if ( bootStatus && label ) bootStatus.textContent = label;
}

/** Yields to the browser so the boot screen can actually repaint between steps. */
const nextFrame = () => new Promise( ( r ) => requestAnimationFrame( () => setTimeout( r, 0 ) ) );

/**
 * Fades the boot screen out and then takes it out of the layout entirely.
 *
 * Relying on the opacity transition alone leaves a full-screen element
 * sitting over the game: if anything blocks the main thread while it is
 * mid-transition, the fade stalls part-way and the title stays visible on top
 * of live gameplay.
 */
function hideBoot( delay = 0 ) {
  const el = document.getElementById( 'boot' );
  if ( !el || el.dataset.gone ) return;
  el.dataset.gone = '1';
  setTimeout( () => {
    el.classList.add( 'hidden' );
    setTimeout( () => { el.style.display = 'none'; }, 700 );
  }, delay );
}

async function main() {
  const canvas = document.getElementById( 'viewport' );
  const uiRoot = document.getElementById( 'ui-root' );

  progress( 0.08, 'STARTING RENDERER…' );
  await nextFrame();

  const engine = new Engine( canvas );
  const input = new Input( canvas );

  progress( 0.20, 'BUILDING ATMOSPHERE…' );
  await nextFrame();

  const sky = new Sky( 'noon' );
  engine.scene.add( sky.mesh );

  const lighting = new LightingRig( engine.scene, { shadowExtent: 22, shadowMapSize: 2048 } );
  sky.setSunDirection( lighting.sunDirection );
  engine.scene.fog = new THREE.Fog( 0x9ed4f7, 45, 190 );

  progress( 0.34, 'GENERATING KIVOTOS PLAZA…' );
  await nextFrame();

  progress( 0.55, 'DEPLOYING SQUAD…' );
  await nextFrame();

  const hud = new HUD( uiRoot, {
    onSkill: ( i ) => game.useSkill( i ),
    onStart: () => startMission(),
    onRestart: () => { game.restart(); hud.banner( 'OPERATION START', 'KIVOTOS PLAZA', 'wave' ); },
    onSettings: ( s ) => applySettings( s ),
    onStick: ( v ) => { input.stick.set( v.x, v.y ); },
    onPause: () => { paused = !paused; },
  } );

  const audio = new AudioEngine();

  const game = new Game( {
    scene: engine.scene,
    camera: engine.camera,
    hud,
    audio,
    quality: 2,
  } );

  let paused = false;

  function setPaused( on ) {
    paused = on;
    hud.setPaused?.( on );
    if ( on ) audio.duck( 'music', 0.5, 200 );
  }

  function applySettings( s ) {
    if ( s.quality !== undefined ) {
      engine.postfx.setQuality( s.quality );
      lighting.setQuality( s.quality );
      game.setQuality( s.quality );
    }
    if ( s.master !== undefined ) audio.setVolume( 'master', s.master );
    if ( s.sfx !== undefined ) audio.setVolume( 'sfx', s.sfx );
  }

  function startMission() {
    // Browsers only allow audio to begin from a user gesture, and the PLAY
    // button is the first one this game gets.
    audio.unlock().then( () => audio.music.start( 'combat' ) );
    game.start();
    hud.banner( 'OPERATION START', 'KIVOTOS PLAZA', 'wave' );
  }

  progress( 0.78, 'COMPILING SHADERS…' );
  await nextFrame();

  // Force the whole shader set to compile now, so the first seconds of play
  // aren't a slideshow of stalls as each new material is first drawn.
  engine.renderer.compile( engine.scene, engine.camera );

  progress( 0.92, 'READY' );
  await nextFrame();

  /* ------------------------------------------------------------------ */

  engine.add( {
    update( dt, elapsed ) {
      sky.update( dt, elapsed );

      // --- input --------------------------------------------------------
      if ( input.pointerDown && ( input.dragDelta.x || input.dragDelta.y ) ) {
        game.cameraRig.orbit( input.dragDelta.x, input.dragDelta.y );
      }
      if ( input.wheel ) game.cameraRig.zoom( input.wheel );

      // Skill keys are bound by the HUD, which also drives the card's punch
      // animation. Polling them here as well fired every skill twice: the
      // second call failed the cost guard and played the error sting, so
      // every keyboard cast came with a beep.
      if ( input.wasPressed( 'KeyP' ) || input.wasPressed( 'Escape' ) ) setPaused( !paused );

      // Move the squad's rally point, in camera-relative space.
      const axis = input.readMoveAxis();
      if ( axis.lengthSq() > 0.001 ) {
        const yaw = game.cameraRig.yaw;
        game.rally.x += ( Math.sin( yaw ) * -axis.y + Math.cos( yaw ) * axis.x ) * dt * 9;
        game.rally.z += ( Math.cos( yaw ) * -axis.y - Math.sin( yaw ) * axis.x ) * dt * 9;
        game.rally.x = THREE.MathUtils.clamp( game.rally.x, -24, 24 );
        game.rally.z = THREE.MathUtils.clamp( game.rally.z, -28, 28 );
      }

      // --- simulate -----------------------------------------------------
      if ( !paused ) game.update( dt, elapsed );

      audio.setListener( engine.camera );
      audio.update( dt );

      lighting.followFocus( game.cameraRig.smoothed );

      // --- present ------------------------------------------------------
      const state = game.hudState();
      hud.update( state, engine.camera, engine.renderer );
      for ( const d of game.drainDamage() ) hud.damage( d.value, d.kind, d.position );

      input.endFrame();
    },

    onResize( w, h, pr ) {
      game.onResize( w, h, pr );
    },
  } );

  engine.resize();
  engine.start();

  /* --- capture / diagnostics hooks ---------------------------------- */

  const framings = {
    game:     null,                                   // live gameplay camera
    overview: { pos: [ 0, 26, 34 ], look: [ 0, 0, -2 ], fov: 40 },
    street:   { pos: [ 0, 1.8, 16 ], look: [ 0, 1.4, -12 ], fov: 42 },
    // Framings that follow the fight, resolved at capture time.
    firefight: 'nearestContact',
    portrait:  'squadCloseup',
    overShoulder: 'behindLead',
  };

  /** Resolves the dynamic framings against the current simulation state. */
  function dynamicFraming( kind ) {
    const alive = game.squad.filter( ( u ) => !u.dead );
    if ( !alive.length ) return null;

    const centre = new THREE.Vector3();
    for ( const u of alive ) centre.add( u.position );
    centre.divideScalar( alive.length );

    if ( kind === 'squadCloseup' ) {
      const u = alive[ 0 ];
      const f = new THREE.Vector3( Math.sin( u.character.root.rotation.y ), 0, Math.cos( u.character.root.rotation.y ) );
      return {
        pos: [ u.position.x + f.x * 2.6 + 0.75, 1.56, u.position.z + f.z * 2.6 ],
        look: [ u.position.x, 1.47, u.position.z ],
        fov: 15,
      };
    }

    let nearest = null, d = Infinity;
    for ( const h of game.hostiles ) {
      if ( h.dead ) continue;
      const dd = h.position.distanceTo( centre );
      if ( dd < d ) { d = dd; nearest = h; }
    }

    if ( kind === 'behindLead' ) {
      const u = alive[ 0 ];
      const t = nearest ? nearest.position : new THREE.Vector3( centre.x, 0, centre.z - 12 );
      const back = new THREE.Vector3().subVectors( u.position, t ).setY( 0 ).normalize();
      const look = new THREE.Vector3( t.x, 1.2, t.z );
      for ( const d of [ 2.6, 3.6, 5.0 ] ) {
        const pos = new THREE.Vector3(
          u.position.x + back.x * d + 0.8, 1.95 + ( d - 2.6 ) * 0.4, u.position.z + back.z * d
        );
        if ( game.physics.lineOfSight( pos, look, 1 ) ) {
          return { pos: [ pos.x, pos.y, pos.z ], look: [ look.x, look.y, look.z ], fov: 40 };
        }
      }
      return {
        pos: [ u.position.x + back.x * 3.2 + 0.8, 3.4, u.position.z + back.z * 3.2 ],
        look: [ look.x, look.y, look.z ],
        fov: 40,
      };
    }

    // nearestContact: side-on view of the closest engagement.
    const mid = nearest ? centre.clone().lerp( nearest.position, 0.5 ) : centre;
    const axis = nearest
      ? new THREE.Vector3().subVectors( nearest.position, centre ).setY( 0 ).normalize()
      : new THREE.Vector3( 0, 0, -1 );
    const side = new THREE.Vector3( axis.z, 0, -axis.x );
    const look = new THREE.Vector3( mid.x, 1.1, mid.z );

    // Try both flanks and rising heights until the subject is actually
    // visible. A fixed side-on offset happily parks the camera inside a
    // shipping container, and a review shot of the inside of a container
    // tells nobody anything.
    for ( const flank of [ 1, -1 ] ) {
      for ( const dist of [ 7, 9, 11.5 ] ) {
      for ( const height of [ 2.8, 3.6, 4.8, 6.4 ] ) {
        const pos = new THREE.Vector3(
          mid.x + side.x * dist * flank - axis.x * 3,
          height,
          mid.z + side.z * dist * flank - axis.z * 3
        );
        if ( game.physics.lineOfSight( pos, look, 1 /* LAYER_STATIC */ ) ) {
          return { pos: [ pos.x, pos.y, pos.z ], look: [ look.x, look.y, look.z ], fov: 40 };
        }
      }
      }
    }
    // Nothing clear: fall back to straight overhead, which always is.
    return { pos: [ mid.x, 11, mid.z + 7 ], look: [ look.x, look.y, look.z ], fov: 40 };
  }

  window.__capture = ( name ) => {
    let f = framings[ name ];
    if ( typeof f === 'string' ) f = dynamicFraming( f );
    if ( !f ) return;
    game.cameraRig.enabled = false;
    engine.camera.position.set( ...f.pos );
    engine.camera.fov = f.fov;
    engine.camera.updateProjectionMatrix();
    engine.camera.lookAt( new THREE.Vector3( ...f.look ) );
    lighting.followFocus( new THREE.Vector3( ...f.look ) );
  };
  window.__captureList = () => Object.keys( framings );

  // Lets the capture harness drop straight into a live firefight instead of
  // photographing the title screen.
  window.__startMission = ( fastForwardSeconds = 0, opts = {} ) => {
    // A long fast-forward blocks the main thread, which can strand the boot
    // fade part-way; take it out of the layout before starting.
    const b = document.getElementById( 'boot' );
    if ( b ) { b.classList.add( 'hidden' ); b.style.display = 'none'; }
    if ( game.phase === 'title' ) startMission();
    if ( opts.wave ) {
      // Jump the director so a capture can reach a late wave (or the boss)
      // without simulating every earlier one.
      game.director.wave = Math.max( 0, opts.wave - 1 );
      game.director._state = 'between';
      game.director._timer = 0.01;
    }
    // Step the simulation forward in fixed slices so waves spawn and units
    // engage before the screenshot is taken.
    const step = 1 / 60;
    for ( let t = 0; t < fastForwardSeconds; t += step ) {
      game.update( step, t );
    }
  };
  window.__game = game;
  window.__audio = audio;
  window.__engine = engine;
  /**
   * Counts units whose capsule is actually intersecting a static collider.
   * Standing tight against a crate and clipping through it look identical
   * from an elevated camera, so this measures it instead of guessing.
   */
  window.__penetration = () => {
    const out = [];
    for ( const u of game.units ) {
      const p = u.body.position;
      const r = u.body.radius;
      const top = p.y + u.body.height;
      for ( const c of game.physics.colliders ) {
        if ( c.tag === 'world' ) continue;   // arena shell and buildings
        // Closest point on the box to the capsule's vertical axis.
        const cx = Math.max( c.minX, Math.min( p.x, c.maxX ) );
        const cz = Math.max( c.minZ, Math.min( p.z, c.maxZ ) );
        const cy = Math.max( c.minY, Math.min( ( p.y + top ) * 0.5, c.maxY ) );
        if ( cy < c.minY || cy > c.maxY ) continue;
        if ( top < c.minY || p.y > c.maxY ) continue;
        const d = Math.hypot( p.x - cx, p.z - cz );
        if ( d < r - 0.02 ) {
          out.push( { unit: u.name, tag: c.tag, depth: +( r - d ).toFixed( 3 ) } );
        }
      }
    }
    return out;
  };

  window.__diagnostics = () => ( {
    penetrating: window.__penetration(),
    drawCalls: engine.renderer.info.render.calls,
    triangles: engine.renderer.info.render.triangles,
    programs: engine.renderer.info.programs?.length ?? 0,
    textures: engine.renderer.info.memory.textures,
    squad: game.squad.length,
    hostiles: game.hostiles.length,
    phase: game.phase,
    wave: game.director.wave,
  } );

  // The title screen owns the first interaction; the HUD calls back into
  // startMission when the player commits.
  hud.update( game.hudState(), engine.camera, engine.renderer );

  progress( 1, 'READY' );
  hideBoot( 240 );
  window.__GAME_READY__ = true;
}

main().catch( ( err ) => {
  console.error( err );
  if ( bootStatus ) bootStatus.textContent = 'FAILED: ' + err.message;
  window.__bootError = String( err?.stack ?? err );
  window.__GAME_READY__ = true;   // let the harness capture the failure state
} );
