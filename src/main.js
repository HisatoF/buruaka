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
    onRestart: () => location.reload(),
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

      for ( let i = 0; i < 4; i++ ) {
        if ( input.wasPressed( `Digit${i + 1}` ) ) game.useSkill( i );
      }
      if ( input.wasPressed( 'KeyP' ) || input.wasPressed( 'Escape' ) ) paused = !paused;

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
        pos: [ u.position.x + f.x * 1.5 + 0.5, 1.52, u.position.z + f.z * 1.5 ],
        look: [ u.position.x, 1.44, u.position.z ],
        fov: 26,
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
      return {
        pos: [ u.position.x + back.x * 2.6 + 0.8, 1.95, u.position.z + back.z * 2.6 ],
        look: [ t.x, 1.2, t.z ],
        fov: 40,
      };
    }

    // nearestContact: side-on view of the closest engagement.
    const mid = nearest ? centre.clone().lerp( nearest.position, 0.5 ) : centre;
    const axis = nearest
      ? new THREE.Vector3().subVectors( nearest.position, centre ).setY( 0 ).normalize()
      : new THREE.Vector3( 0, 0, -1 );
    const side = new THREE.Vector3( axis.z, 0, -axis.x );
    return {
      pos: [ mid.x + side.x * 9 + axis.x * -3, 3.4, mid.z + side.z * 9 + axis.z * -3 ],
      look: [ mid.x, 1.1, mid.z ],
      fov: 40,
    };
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
  window.__startMission = ( fastForwardSeconds = 0 ) => {
    if ( game.phase === 'title' ) startMission();
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
  window.__diagnostics = () => ( {
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
  setTimeout( () => boot?.classList.add( 'hidden' ), 240 );
  window.__GAME_READY__ = true;
}

main().catch( ( err ) => {
  console.error( err );
  if ( bootStatus ) bootStatus.textContent = 'FAILED: ' + err.message;
  window.__bootError = String( err?.stack ?? err );
  window.__GAME_READY__ = true;   // let the harness capture the failure state
} );
