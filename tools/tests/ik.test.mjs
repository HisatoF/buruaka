/**
 * Numeric check of the two-bone IK: build a synthetic shoulder/elbow/wrist
 * chain, drive the wrist at a spread of targets, and assert the solved wrist
 * actually lands on them.
 */
import * as THREE from 'three';
import { solveTwoBoneIK } from '../../src/anim/Animator.js';

const root = new THREE.Object3D();          // stands in for the chest
root.position.set( 0, 1.15, 0 );

const shoulder = new THREE.Bone();
shoulder.position.set( 0.16, 0.11, 0 );
root.add( shoulder );

const elbow = new THREE.Bone();
elbow.position.set( 0.102, -0.217, 0 );      // matches the real rig's arm
shoulder.add( elbow );

const wrist = new THREE.Bone();
wrist.position.set( 0.090, -0.193, 0 );
elbow.add( wrist );

const scene = new THREE.Scene();
scene.add( root );
scene.updateMatrixWorld( true );

const L1 = elbow.position.length();
const L2 = wrist.position.length();
const reach = L1 + L2;
console.log( `arm lengths: upper=${L1.toFixed(3)} lower=${L2.toFixed(3)} reach=${reach.toFixed(3)}` );

const targets = [
  [ 0.20, 1.20, 0.28 ],
  [ 0.10, 1.30, 0.30 ],
  [ 0.28, 1.05, 0.20 ],
  [ 0.05, 1.15, 0.34 ],
  [ 0.30, 1.35, 0.15 ],
  [ -0.05, 1.10, 0.30 ],
];

const pole = new THREE.Vector3( 0.55, 0.55, -0.30 );
let worst = 0, worstT = null;
const got = new THREE.Vector3();

for ( const t of targets ) {
  const target = new THREE.Vector3( ...t );
  const dist = target.distanceTo( new THREE.Vector3().setFromMatrixPosition( shoulder.matrixWorld ) );
  solveTwoBoneIK( shoulder, elbow, wrist, target, pole, 1 );
  scene.updateMatrixWorld( true );
  wrist.getWorldPosition( got );
  const err = got.distanceTo( target );
  const reachable = dist <= reach * 0.995;
  console.log(
    `target ${t.map(n=>n.toFixed(2)).join(',')}  dist=${dist.toFixed(3)}` +
    `  solved=${[got.x,got.y,got.z].map(n=>n.toFixed(3)).join(',')}  err=${err.toFixed(4)}` +
    `  ${reachable ? '' : '(out of reach)'}`
  );
  if ( reachable && err > worst ) { worst = err; worstT = t; }
}

// The elbow must sit on the pole side, not inverted behind the arm.
const elbowPos = new THREE.Vector3();
elbow.getWorldPosition( elbowPos );
const shoulderPos = new THREE.Vector3().setFromMatrixPosition( shoulder.matrixWorld );
const toElbow = elbowPos.clone().sub( shoulderPos ).normalize();
console.log( `elbow direction: ${[toElbow.x,toElbow.y,toElbow.z].map(n=>n.toFixed(2)).join(',')} (y should be negative — elbow hangs down)` );

console.log( `\nworst reachable error: ${worst.toFixed(4)} m` );
if ( worst > 0.01 ) { console.log( 'FAIL: IK does not reach its target' ); process.exit(1); }
if ( toElbow.y > 0 ) { console.log( 'FAIL: elbow inverted' ); process.exit(1); }
console.log( 'PASS' );
