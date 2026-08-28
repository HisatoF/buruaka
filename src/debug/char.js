/**
 * Character viewer. Renders the roster against the real lighting and post
 * stack so the models can be judged the way they will actually appear,
 * rather than in a flat preview.
 */
import * as THREE from 'three';
import { Engine } from '../core/Engine.js';
import { Sky } from '../render/Sky.js';
import { LightingRig } from '../render/Lighting.js';
import { createToonMaterial } from '../render/ToonMaterial.js';
import { buildCharacter, STUDENT_PRESETS, ENEMY_PRESETS } from '../gen/Character.js';

const engine = new Engine( document.getElementById( 'viewport' ) );
const sky = new Sky( 'noon' );
engine.scene.add( sky.mesh );
const lighting = new LightingRig( engine.scene );
sky.setSunDirection( lighting.sunDirection );
engine.scene.fog = new THREE.Fog( 0x9ed4f7, 24, 90 );

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry( 200, 200 ),
  createToonMaterial( { color: 0xb9c4d2, shadowTint: 0x8189b4, midTint: 0xa8afcd, specStrength: 0, ambient: 0.24 } )
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
engine.scene.add( ground );

const roster = [ ...Object.keys( STUDENT_PRESETS ), ...Object.keys( ENEMY_PRESETS ) ];
const chars = [];
roster.forEach( ( key, i ) => {
  const c = buildCharacter( key );
  c.root.position.set( ( i - ( roster.length - 1 ) / 2 ) * 0.95, 0, 0 );
  engine.scene.add( c.root );
  // Alternate between an idle stance and an aiming run so both animation
  // layers are visible in one capture.
  if ( i % 2 === 0 ) {
    c.animator.setAim( new THREE.Vector3( c.root.position.x, 1.25, 8 ), 1 );
    c.animator.setSpeed( 0 );
  } else {
    c.animator.setSpeed( 0.85 );
    c.animator.setAim( null, 0 );
  }
  chars.push( c );
} );

/** X position of roster member `i`, so framings can never drift off-target. */
const at = ( i ) => chars[ Math.min( i, chars.length - 1 ) ].root.position.x;

const framings = {
  lineup:  { pos: [ 0, 1.35, 4.4 ], look: [ 0, 0.95, 0 ], fov: 38 },
  back:    { pos: [ 0, 1.35, -3.4 ], look: [ 0, 0.95, 0 ], fov: 38 },
  get hero()   { return { pos: [ at( 1 ) + 0.05, 1.30, 1.5 ], look: [ at( 1 ), 1.05, 0 ], fov: 30 }; },
  get full()   { return { pos: [ at( 1 ), 0.95, 2.5 ], look: [ at( 1 ), 0.85, 0 ], fov: 34 }; },
  get face()   { return { pos: [ at( 1 ), 1.50, 1.30 ], look: [ at( 1 ), 1.47, 0 ], fov: 13 }; },
  get face2()  { return { pos: [ at( 2 ) + 0.30, 1.52, 1.30 ], look: [ at( 2 ), 1.47, 0 ], fov: 13 }; },
  get threeq() { return { pos: [ at( 2 ) + 1.0, 1.35, 1.7 ], look: [ at( 2 ), 1.02, 0 ], fov: 32 }; },
};

function applyFraming( name ) {
  const f = framings[ name ] ?? framings.lineup;
  engine.camera.position.set( ...f.pos );
  engine.camera.fov = f.fov;
  engine.camera.updateProjectionMatrix();
  engine.camera.lookAt( new THREE.Vector3( ...f.look ) );
  lighting.followFocus( new THREE.Vector3( ...f.look ) );
}
applyFraming( 'lineup' );

engine.add( {
  update( dt, t ) {
    sky.update( dt, t );
    for ( const c of chars ) c.update( dt, t );
  },
  onResize( w, h, pr ) { for ( const c of chars ) c.onResize( w, h, pr ); },
} );

engine.renderer.compile( engine.scene, engine.camera );
engine.start();

window.__capture = applyFraming;
window.__captureList = () => Object.keys( framings );
window.__diagnostics = () => ( {
  drawCalls: engine.renderer.info.render.calls,
  triangles: engine.renderer.info.render.triangles,
  programs: engine.renderer.info.programs?.length ?? 0,
  characters: chars.length,
  trisPerChar: Math.round( engine.renderer.info.render.triangles / chars.length ),
} );
window.__engine = engine;
window.__chars = chars;
window.__captureHealth = () => ( {
  ok: !engine.renderer.getContext().isContextLost(),
  contextLost: engine.renderer.getContext().isContextLost(),
  characters: chars.length,
} );
window.__GAME_READY__ = true;
