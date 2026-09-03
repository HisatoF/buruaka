#!/usr/bin/env node
/**
 * Verifies each hostile archetype does the distinct thing it exists to do.
 *
 * A stat table is easy to get wrong quietly — a "shield" that reduces nothing,
 * a "healer" that never heals, a "rusher" that stands at rifle range because
 * it inherited the generic standoff. Each assertion below is the behaviour the
 * archetype was added for, not its numbers.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch( {
  executablePath: existsSync( CHROME ) ? CHROME : undefined,
  args: [ '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader', '--mute-audio' ],
} );
const page = await browser.newPage( { viewport: { width: 1000, height: 600 } } );
const errs = [];
page.on( 'pageerror', ( e ) => errs.push( e.message ) );
page.on( 'console', ( m ) => {
  const t = m.text();
  if ( m.type() === 'error' && !/fonts\.g|favicon|ERR_CONNECTION_RESET|Failed to load resource/.test( t ) ) errs.push( t );
} );

await page.goto( 'http://127.0.0.1:5210/', { waitUntil: 'domcontentloaded', timeout: 60000 } );
await page.waitForFunction( () => window.__GAME_READY__ === true, null, { timeout: 90000 } );

const out = await page.evaluate( async () => {
  const g = window.__game;
  const THREE = g.cameraRig.camera.position.constructor;
  const r = {};
  g.phase = 'playing';

  const spawn = ( kind, x, z ) => g.spawnHostile( kind, new THREE( x, 0, z ) );
  const step = ( n ) => { for ( let i = 0; i < n; i++ ) g.update( 1 / 60, i / 60 ); };

  // --- every archetype builds and carries its own identity --------------
  r.built = {};
  for ( const kind of [ 'grunt', 'heavy', 'marksman', 'rusher', 'bulwark', 'mender' ] ) {
    const u = spawn( kind, 40 + Math.random(), 40 );
    r.built[ kind ] = {
      name: u.name, hp: Math.round( u.maxHp ), armor: u.armor,
      tags: u.tags, speed: +u.moveSpeed.toFixed( 2 ),
      hasWeapon: !!u.character.weapon,
      meshes: u.character.meshes.map( ( m ) => m.name ),
    };
  }
  step( 30 );

  // --- bulwark: frontal hits must be mitigated, flank hits must not -----
  const bw = spawn( 'bulwark', 0, 0 );
  bw._facing = 0;                                   // facing +Z
  const front = new THREE( 0, 0, -1 );              // travelling -Z, into its face
  const flank = new THREE( 1, 0, 0 );
  const hpStart = bw.hp;
  const frontDealt = bw.takeDamage( 1000, front, 'normal' );
  const flankDealt = bw.takeDamage( 1000, flank, 'normal' );
  r.bulwark = {
    frontDealt: Math.round( frontDealt ),
    flankDealt: Math.round( flankDealt ),
    ratio: +( frontDealt / flankDealt ).toFixed( 3 ),
    hpStart: Math.round( hpStart ),
  };

  // --- mender: heals wounded neighbours ---------------------------------
  const md = spawn( 'mender', 60, 60 );
  const patient = spawn( 'grunt', 61, 60 );
  patient.hp = patient.maxHp * 0.4;
  const patientBefore = patient.hp;
  step( 60 * 6 );
  r.mender = {
    patientBefore: Math.round( patientBefore ),
    patientAfter: Math.round( patient.hp ),
    healed: Math.round( patient.hp - patientBefore ),
  };

  // --- rusher: closes to melee and lands a hit --------------------------
  // Measured across the whole squad: the rusher picks its own target, so
  // watching one member only proves whether that member was chosen.
  const anchor = g.squad[ 0 ];
  const rush = spawn( 'rusher', anchor.position.x + 9, anchor.position.z );
  const squadHpBefore = g.squad.reduce( ( t, u ) => t + u.hp, 0 );
  const startDist = rush.position.distanceTo( anchor.position );

  // Closest approach over the run, not the distance at the final frame: the
  // target keeps moving, so an end-of-run sample says as much about where the
  // squad went as about whether the rusher got there.
  let minDist = Infinity;
  for ( let i = 0; i < 60 * 12; i++ ) {
    g.update( 1 / 60, i / 60 );
    if ( rush.target && !rush.dead ) {
      minDist = Math.min( minDist, rush.position.distanceTo( rush.target.position ) );
    }
  }
  r.rusher = {
    startDist: +startDist.toFixed( 2 ),
    closestApproach: +minDist.toFixed( 2 ),
    squadDamageTaken: Math.round( squadHpBefore - g.squad.reduce( ( t, u ) => t + u.hp, 0 ) ),
    hasMelee: !!rush.melee,
    targeted: rush.target?.name ?? null,
  };

  // --- marksman: telegraphs before it fires -----------------------------
  let telegraphs = 0;
  const origTel = g.onTelegraph.bind( g );
  g.onTelegraph = ( u, p ) => { telegraphs++; return origTel( u, p ); };
  const mk = spawn( 'marksman', g.squad[ 1 ].position.x, g.squad[ 1 ].position.z - 16 );
  step( 60 * 14 );
  r.marksman = { telegraphs, standoff: mk.arch.standoff, alive: !mk.dead };

  return r;
} );

await browser.close();
console.log( JSON.stringify( out, null, 2 ) );

const fails = [];
const kinds = [ 'grunt', 'heavy', 'marksman', 'rusher', 'bulwark', 'mender' ];
for ( const k of kinds ) if ( !out.built[ k ] ) fails.push( `${k} failed to build` );
if ( out.built.rusher?.hasWeapon ) fails.push( 'rusher should carry no firearm' );
if ( !out.built.bulwark?.meshes.includes( 'shield' ) ) fails.push( 'bulwark has no shield mesh' );
if ( !( out.bulwark.ratio < 0.3 ) ) fails.push( `bulwark frontal mitigation not applied (ratio ${out.bulwark.ratio})` );
if ( !( out.mender.healed > 0 ) ) fails.push( 'mender healed nobody' );
if ( !( out.rusher.closestApproach <= 2.1 ) ) fails.push( `rusher did not reach melee range (closest ${out.rusher.closestApproach} m)` );
if ( !( out.rusher.squadDamageTaken > 0 ) ) fails.push( 'rusher never landed a melee hit' );
if ( !( out.marksman.telegraphs > 0 ) ) fails.push( 'marksman never telegraphed a shot' );

if ( errs.length ) fails.push( `console errors: ${errs.slice( 0, 3 ).join( ' | ' )}` );

if ( fails.length ) { console.log( 'FAIL:\n - ' + fails.join( '\n - ' ) ); process.exit( 1 ); }
console.log( 'PASS: every archetype exhibits its defining behaviour' );
