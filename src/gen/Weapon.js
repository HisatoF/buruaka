import * as THREE from 'three';
import { createToonMaterial, createOutlineMaterial, computeSmoothNormals, paintGeometry } from '../render/ToonMaterial.js';
import { roundedBox, profileTube, limb, mergeGeometries, xform } from './Geometry.js';

/**
 * Procedural weapons.
 *
 * Local convention: the barrel runs along **+Z**, the grip sits near the
 * origin, and the muzzle is at `+Z * muzzleZ`. The animator's IK grips are
 * expressed in this space, so every weapon is interchangeable without
 * re-authoring a pose.
 */

const V = ( x, y, z ) => new THREE.Vector3( x, y, z );

const METAL = 0x3a4050;
const METAL_DARK = 0x272c38;
const POLYMER = 0x2e3340;
const ACCENT = 0x8fa4c8;

/** @typedef {{ geometry: THREE.BufferGeometry, muzzleZ: number, stats: object }} WeaponBuild */

function receiver( length, height, width, color ) {
  return paintGeometry( roundedBox( width, height, length, 0.008, 2 ), color );
}

function barrel( from, to, r, color ) {
  return paintGeometry( limb( from, to, [ { t: 0, r: r * 1.35 }, { t: 0.12, r }, { t: 1, r: r * 0.92 } ], {
    radial: 10, capTop: true, capBottom: false, capRound: 0.2,
  } ), color );
}

function magazine( x, y, z, w, h, d, tilt, color ) {
  const g = roundedBox( w, h, d, 0.006, 2 );
  g.rotateX( tilt );
  g.translate( x, y, z );
  return paintGeometry( g, color );
}

function grip( x, y, z, color ) {
  const g = roundedBox( 0.028, 0.088, 0.042, 0.010, 2 );
  g.rotateX( 0.32 );
  g.translate( x, y, z );
  return paintGeometry( g, color );
}

function sight( z, h, color ) {
  const g = roundedBox( 0.030, h, 0.070, 0.005, 1 );
  g.translate( 0, 0.038 + h * 0.5, z );
  return paintGeometry( g, color );
}

export const WEAPONS = {
  rifle() {
    const parts = [
      receiver( 0.34, 0.062, 0.042, POLYMER ),
      barrel( V( 0, 0.006, 0.16 ), V( 0, 0.006, 0.46 ), 0.011, METAL ),
      magazine( 0, -0.072, 0.02, 0.030, 0.110, 0.050, -0.14, METAL_DARK ),
      grip( 0, -0.058, -0.055, POLYMER ),
      sight( 0.06, 0.026, METAL_DARK ),
      // Stock.
      paintGeometry( xform( roundedBox( 0.036, 0.070, 0.150, 0.014, 2 ), { position: [ 0, -0.012, -0.222 ] } ), POLYMER ),
      // Handguard rail.
      paintGeometry( xform( roundedBox( 0.046, 0.014, 0.170, 0.005, 1 ), { position: [ 0, 0.040, 0.215 ] } ), ACCENT ),
      // Muzzle brake.
      paintGeometry( xform( profileTube( [ { y: 0, rx: 0.018 }, { y: 0.044, rx: 0.019 } ], { radial: 10, capTop: false, capBottom: false } ),
        { rotation: [ Math.PI / 2, 0, 0 ], position: [ 0, 0.006, 0.462 ] } ), METAL_DARK ),
    ];
    return {
      geometry: mergeGeometries( parts ),
      muzzleZ: 0.508,
      stats: { name: 'AR', damage: 11, rpm: 640, spread: 0.016, range: 22, mag: 30, reload: 1.9, burst: 0, speed: 190 },
    };
  },

  smg() {
    const parts = [
      receiver( 0.24, 0.058, 0.040, POLYMER ),
      barrel( V( 0, 0.004, 0.11 ), V( 0, 0.004, 0.30 ), 0.009, METAL ),
      magazine( 0, -0.088, 0.01, 0.028, 0.140, 0.044, -0.06, METAL_DARK ),
      grip( 0, -0.056, -0.048, POLYMER ),
      sight( 0.03, 0.020, METAL_DARK ),
      paintGeometry( xform( roundedBox( 0.030, 0.052, 0.100, 0.012, 2 ), { position: [ 0, -0.006, -0.168 ] } ), METAL_DARK ),
      paintGeometry( xform( roundedBox( 0.042, 0.012, 0.110, 0.004, 1 ), { position: [ 0, 0.036, 0.150 ] } ), ACCENT ),
    ];
    return {
      geometry: mergeGeometries( parts ),
      muzzleZ: 0.318,
      stats: { name: 'SMG', damage: 6, rpm: 940, spread: 0.034, range: 14, mag: 40, reload: 1.6, burst: 0, speed: 160 },
    };
  },

  shotgun() {
    const parts = [
      receiver( 0.30, 0.070, 0.050, 0x4a3a2e ),
      barrel( V( 0, 0.010, 0.14 ), V( 0, 0.010, 0.44 ), 0.019, METAL_DARK ),
      // Tube magazine slung under the barrel.
      barrel( V( 0, -0.024, 0.14 ), V( 0, -0.024, 0.40 ), 0.014, METAL ),
      grip( 0, -0.058, -0.050, 0x4a3a2e ),
      paintGeometry( xform( roundedBox( 0.044, 0.078, 0.160, 0.018, 2 ), { position: [ 0, -0.020, -0.216 ] } ), 0x4a3a2e ),
      paintGeometry( xform( roundedBox( 0.050, 0.028, 0.100, 0.010, 2 ), { position: [ 0, -0.028, 0.230 ] } ), 0x5b4838 ),
    ];
    return {
      geometry: mergeGeometries( parts ),
      muzzleZ: 0.462,
      stats: { name: 'SG', damage: 7, pellets: 8, rpm: 85, spread: 0.10, range: 9, mag: 6, reload: 2.6, burst: 0, speed: 140 },
    };
  },

  sniper() {
    const parts = [
      receiver( 0.40, 0.058, 0.040, 0x2b3346 ),
      barrel( V( 0, 0.004, 0.19 ), V( 0, 0.004, 0.62 ), 0.012, METAL_DARK ),
      magazine( 0, -0.058, 0.03, 0.026, 0.070, 0.044, -0.10, METAL_DARK ),
      grip( 0, -0.058, -0.062, 0x2b3346 ),
      paintGeometry( xform( roundedBox( 0.038, 0.078, 0.190, 0.016, 2 ), { position: [ 0, -0.014, -0.268 ] } ), 0x2b3346 ),
      // Scope.
      paintGeometry( xform( profileTube( [ { y: 0, rx: 0.024 }, { y: 0.05, rx: 0.020 }, { y: 0.15, rx: 0.020 }, { y: 0.20, rx: 0.026 } ],
        { radial: 12, capTop: true, capBottom: true } ), { rotation: [ Math.PI / 2, 0, 0 ], position: [ 0, 0.062, -0.02 ] } ), METAL_DARK ),
      paintGeometry( xform( roundedBox( 0.014, 0.030, 0.014, 0.004, 1 ), { position: [ 0, 0.040, 0.02 ] } ), METAL ),
      paintGeometry( xform( roundedBox( 0.014, 0.030, 0.014, 0.004, 1 ), { position: [ 0, 0.040, 0.13 ] } ), METAL ),
      paintGeometry( xform( profileTube( [ { y: 0, rx: 0.022 }, { y: 0.050, rx: 0.023 } ], { radial: 10, capTop: false, capBottom: false } ),
        { rotation: [ Math.PI / 2, 0, 0 ], position: [ 0, 0.004, 0.622 ] } ), METAL_DARK ),
    ];
    return {
      geometry: mergeGeometries( parts ),
      muzzleZ: 0.688,
      stats: { name: 'SR', damage: 62, rpm: 48, spread: 0.002, range: 40, mag: 5, reload: 2.8, burst: 0, speed: 320 },
    };
  },
};

/**
 * Builds a weapon as a self-contained object with its own outline pass and a
 * muzzle anchor for VFX.
 *
 * @param {'rifle'|'smg'|'shotgun'|'sniper'} kind
 * @returns {{ group: THREE.Group, muzzle: THREE.Object3D, stats: object, dispose(): void }}
 */
export function buildWeapon( kind, opts = {} ) {
  const build = ( WEAPONS[ kind ] ?? WEAPONS.rifle )();
  const geometry = computeSmoothNormals( build.geometry );

  const material = createToonMaterial( {
    color: 0xffffff,
    vertexTint: true,
    shadowStrength: 0,
    // Gunmetal wants a tight, bright band — it is the only hard surface on a
    // character otherwise made of cloth and skin.
    specStrength: 0.55,
    specGloss: 90,
    specStep: 0.42,
    specSoft: 0.06,
    rimStrength: 0.5,
    rimColor: opts.rimColor ?? 0xbfe8ff,
  } );

  const outlineMaterial = createOutlineMaterial( {
    color: 0x1c2130, thickness: 0.0044, vertexTint: true, tintMix: 0.40,
  } );

  const group = new THREE.Group();
  group.name = `weapon_${kind}`;

  const mesh = new THREE.Mesh( geometry, material );
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  group.add( mesh );

  const outline = new THREE.Mesh( geometry, outlineMaterial );
  outline.castShadow = false;
  outline.frustumCulled = false;
  group.add( outline );

  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set( 0, 0.006, build.muzzleZ );
  group.add( muzzle );

  const ejectPort = new THREE.Object3D();
  ejectPort.position.set( 0.030, 0.020, 0.02 );
  group.add( ejectPort );

  return {
    group,
    mesh,
    muzzle,
    ejectPort,
    material,
    outlineMaterial,
    stats: { ...build.stats, kind },
    onResize( w, h, pr ) { outlineMaterial.uniforms.uResolution.value.set( w * pr, h * pr ); },
    dispose() {
      geometry.dispose();
      material.dispose();
      outlineMaterial.dispose();
    },
  };
}
