import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Sky } from './render/Sky.js';
import { LightingRig } from './render/Lighting.js';
import { createToonMaterial, createOutlineMaterial, computeSmoothNormals } from './render/ToonMaterial.js';

const boot = document.getElementById( 'boot' );
const bootBar = boot?.querySelector( '.boot-bar i' );
const bootStatus = boot?.querySelector( '.boot-status' );

function progress( pct, label ) {
  if ( bootBar ) bootBar.style.width = `${Math.round( pct * 100 )}%`;
  if ( bootStatus && label ) bootStatus.textContent = label;
}

async function main() {
  const canvas = document.getElementById( 'viewport' );
  const engine = new Engine( canvas );
  window.__engine = engine;

  progress( 0.2, 'BUILDING ATMOSPHERE…' );
  const sky = new Sky( 'noon' );
  engine.scene.add( sky.mesh );

  progress( 0.4, 'RIGGING LIGHTS…' );
  const lighting = new LightingRig( engine.scene );
  sky.setSunDirection( lighting.sunDirection );
  engine.scene.fog = new THREE.Fog( 0x9ed4f7, 55, 165 );

  progress( 0.6, 'COMPILING SHADERS…' );

  // --- temporary calibration set: validates ramp, rim, spec and outline ---
  const outlineMat = createOutlineMaterial( { color: 0x30264a, thickness: 0.0034 } );
  const probes = new THREE.Group();

  const swatches = [
    { color: 0xf2f4f8, label: 'uniform white' },
    { color: 0xff6b7f, label: 'ribbon coral' },
    { color: 0x3fa9f5, label: 'accent blue' },
    { color: 0xffd75e, label: 'hair blonde' },
    { color: 0x2c3350, label: 'skirt navy' },
    { color: 0xffdfc7, label: 'skin' },
  ];

  swatches.forEach( ( s, i ) => {
    const geo = computeSmoothNormals( new THREE.SphereGeometry( 0.62, 48, 32 ) );
    const mat = createToonMaterial( { color: s.color, specStrength: 0.34 } );
    const mesh = new THREE.Mesh( geo, mat );
    mesh.position.set( ( i - ( swatches.length - 1 ) / 2 ) * 1.7, 1.3, 0 );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const outline = new THREE.Mesh( geo, outlineMat );
    mesh.add( outline );
    probes.add( mesh );
  } );

  const boxGeo = computeSmoothNormals( new THREE.BoxGeometry( 1.4, 1.4, 1.4 ) );
  const box = new THREE.Mesh( boxGeo, createToonMaterial( { color: 0xffffff } ) );
  box.position.set( -3, 0.7, 3.2 );
  box.rotation.y = 0.6;
  box.castShadow = true;
  box.add( new THREE.Mesh( boxGeo, outlineMat ) );
  probes.add( box );

  const capsGeo = computeSmoothNormals( new THREE.CapsuleGeometry( 0.45, 1.1, 12, 28 ) );
  const caps = new THREE.Mesh( capsGeo, createToonMaterial( { color: 0x8fe3ff, specStrength: 0.5 } ) );
  caps.position.set( 3, 1.0, 3.2 );
  caps.castShadow = true;
  caps.add( new THREE.Mesh( capsGeo, outlineMat ) );
  probes.add( caps );

  engine.scene.add( probes );

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry( 420, 420 ),
    createToonMaterial( { color: 0xb9c4d2, shadowTint: 0x8189b4, midTint: 0xa8afcd, specStrength: 0, ambient: 0.24 } )
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  engine.scene.add( ground );

  // --- camera framings for the capture harness ---------------------------
  const framings = {
    hero:    { pos: [ 0, 2.4, 8.5 ],  look: [ 0, 1.4, 0 ], fov: 34 },
    wide:    { pos: [ 0, 7, 16 ],     look: [ 0, 1.2, 0 ], fov: 38 },
    closeup: { pos: [ 1.2, 1.7, 3.4 ], look: [ 0.6, 1.35, 0 ], fov: 28 },
    back:    { pos: [ 0, 3, -9 ],     look: [ 0, 1.3, 0 ], fov: 34 },
  };

  function applyFraming( name ) {
    const f = framings[ name ] ?? framings.hero;
    engine.camera.position.set( ...f.pos );
    engine.camera.fov = f.fov;
    engine.camera.updateProjectionMatrix();
    engine.camera.lookAt( new THREE.Vector3( ...f.look ) );
    lighting.followFocus( new THREE.Vector3( ...f.look ) );
  }
  applyFraming( 'hero' );

  engine.add( {
    update( dt, t ) {
      sky.update( dt, t );
      probes.children.forEach( ( m, i ) => { m.rotation.y += dt * 0.25 * ( i % 2 ? -1 : 1 ); } );
    },
    onResize( w, h, pr ) {
      outlineMat.uniforms.uResolution.value.set( w * pr, h * pr );
    },
  } );

  // Force a synchronous shader compile so the boot screen doesn't hide over
  // a hitch, and so the capture harness fails loudly on a broken shader.
  engine.renderer.compile( engine.scene, engine.camera );

  progress( 1, 'READY');
  engine.start();

  window.__capture = applyFraming;
  window.__captureList = () => Object.keys( framings );
  window.__diagnostics = () => ( {
    renderer: engine.renderer.getContext().getParameter( engine.renderer.getContext().VERSION ),
    drawCalls: engine.renderer.info.render.calls,
    triangles: engine.renderer.info.render.triangles,
    programs: engine.renderer.info.programs?.length ?? 0,
    textures: engine.renderer.info.memory.textures,
    geometries: engine.renderer.info.memory.geometries,
  } );

  setTimeout( () => boot?.classList.add( 'hidden' ), 260 );
  window.__GAME_READY__ = true;
}

main().catch( ( err ) => {
  console.error( err );
  if ( bootStatus ) bootStatus.textContent = 'FAILED: ' + err.message;
  window.__GAME_READY__ = true; // let the harness capture the failure state
  window.__bootError = String( err && err.stack || err );
} );
