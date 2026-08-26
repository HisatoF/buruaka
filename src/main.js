import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { Sky } from './render/Sky.js';
import { LightingRig } from './render/Lighting.js';
import { Game } from './game/Game.js';
import { HUD } from './ui/HUD.js';

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

  const game = new Game( {
    scene: engine.scene,
    camera: engine.camera,
    hud,
    audio: null,
    quality: 2,
  } );

  let paused = false;

  function applySettings( s ) {
    if ( s.quality !== undefined ) {
      engine.postfx.setQuality( s.quality );
      lighting.setQuality( s.quality );
      game.setQuality( s.quality );
    }
  }

  function startMission() {
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
    game:     null,                                   // live camera
    overview: { pos: [ 0, 26, 34 ], look: [ 0, 0, -2 ], fov: 40 },
    squad:    { pos: [ 2, 2.2, 24 ], look: [ 0, 1.1, 14 ], fov: 34 },
    action:   { pos: [ -6, 3.2, 6 ], look: [ 0, 1.1, -6 ], fov: 38 },
    street:   { pos: [ 0, 1.8, 16 ], look: [ 0, 1.4, -12 ], fov: 42 },
  };

  window.__capture = ( name ) => {
    const f = framings[ name ];
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
