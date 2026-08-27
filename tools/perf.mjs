#!/usr/bin/env node
/**
 * Frame-time benchmark.
 *
 * Runs the real game loop under a heavy load (late waves, many units and
 * projectiles) and reports the frame-time distribution. Averages hide stutter,
 * so the number that matters here is the 95th percentile: one 40 ms frame per
 * second is far more noticeable than a mediocre mean.
 *
 * Note this runs on SwiftShader (software GL), so absolute numbers are a
 * floor, not a prediction of real hardware — the value is in comparing runs
 * and in catching anything that scales badly with unit count.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const args = Object.fromEntries( process.argv.slice( 2 ).flatMap( ( a, i, arr ) =>
  a.startsWith( '--' ) ? [ [ a.slice( 2 ), arr[ i + 1 ]?.startsWith( '--' ) === false ? arr[ i + 1 ] : 'true' ] ] : [] ) );

const URL = args.url ?? 'http://127.0.0.1:5210/';
const WARMUP = Number( args.warmup ?? 90 );
const FRAMES = Number( args.frames ?? 400 );
const PLAY = Number( args.play ?? 120 );

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch( {
  executablePath: existsSync( CHROME ) ? CHROME : undefined,
  args: [ '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader', '--mute-audio', '--hide-scrollbars' ],
} );

const page = await browser.newPage( { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 } );
const errors = [];
page.on( 'pageerror', ( e ) => errors.push( e.message ) );
page.on( 'console', ( m ) => { if ( m.type() === 'error' && !m.text().includes( 'fonts.g' ) ) errors.push( m.text() ); } );

await page.goto( URL, { waitUntil: 'domcontentloaded', timeout: 60000 } );
await page.waitForFunction( () => window.__GAME_READY__ === true, null, { timeout: 90000 } );
await page.evaluate( ( n ) => window.__startMission?.( n ), PLAY );

// The rendering number below is measured on SwiftShader — software
// rasterisation — so it is a floor, not a prediction. The simulation number
// is not: it is pure JavaScript and transfers directly to real hardware.
const cpu = await page.evaluate( ( iters ) => {
  const g = window.__game;
  const dt = 1 / 60;
  // Warm the JIT before measuring.
  for ( let i = 0; i < 30; i++ ) g.update( dt, i * dt );

  const samples = [];
  for ( let i = 0; i < iters; i++ ) {
    const t0 = performance.now();
    g.update( dt, i * dt );
    samples.push( performance.now() - t0 );
  }
  samples.sort( ( a, b ) => a - b );
  const mean = samples.reduce( ( a, b ) => a + b, 0 ) / samples.length;
  return {
    units: g.units.length,
    projectiles: g.ballistics.active ?? '-',
    simMeanMs: +mean.toFixed( 3 ),
    simMedianMs: +samples[ Math.floor( samples.length / 2 ) ].toFixed( 3 ),
    simP95Ms: +samples[ Math.floor( samples.length * 0.95 ) ].toFixed( 3 ),
    simWorstMs: +samples[ samples.length - 1 ].toFixed( 3 ),
    budgetPctAt60fps: +( mean / 16.67 * 100 ).toFixed( 1 ),
  };
}, Number( args.simIters ?? 240 ) );

const result = await page.evaluate( async ( { warmup, frames } ) => {
  // Draw calls accumulate across every composer pass, so the count has to be
  // reset per frame rather than read after the last fullscreen quad — which
  // is why a naive read reports "1".
  window.__engine.renderer.info.autoReset = false;
  const samples = [];
  let last = performance.now();
  let peakCalls = 0, peakTris = 0;

  await new Promise( ( resolve ) => {
    let n = 0;
    const tick = () => {
      const info = window.__engine.renderer.info;
      peakCalls = Math.max( peakCalls, info.render.calls );
      peakTris = Math.max( peakTris, info.render.triangles );
      info.reset();
      const now = performance.now();
      const dt = now - last;
      last = now;
      n++;
      if ( n > warmup ) samples.push( dt );
      if ( n >= warmup + frames ) resolve();
      else requestAnimationFrame( tick );
    };
    requestAnimationFrame( tick );
  } );

  samples.sort( ( a, b ) => a - b );
  const at = ( p ) => samples[ Math.min( samples.length - 1, Math.floor( samples.length * p ) ) ];
  const mean = samples.reduce( ( a, b ) => a + b, 0 ) / samples.length;
  return {
    frames: samples.length,
    meanMs: +mean.toFixed( 2 ),
    medianMs: +at( 0.5 ).toFixed( 2 ),
    p95Ms: +at( 0.95 ).toFixed( 2 ),
    p99Ms: +at( 0.99 ).toFixed( 2 ),
    worstMs: +samples[ samples.length - 1 ].toFixed( 2 ),
    fpsMean: +( 1000 / mean ).toFixed( 1 ),
    drawCalls: peakCalls,
    triangles: peakTris,
    programs: window.__engine.renderer.info.programs?.length ?? 0,
    geometries: window.__engine.renderer.info.memory.geometries,
    textures: window.__engine.renderer.info.memory.textures,
    units: window.__game.units.length,
    hostiles: window.__game.hostiles.filter( ( h ) => !h.dead ).length,
    wave: window.__game.director.wave,
  };
}, { warmup: WARMUP, frames: FRAMES } );

await browser.close();

console.log( JSON.stringify( { simulation: cpu, rendering: result }, null, 2 ) );
if ( errors.length ) {
  console.log( `--- ERRORS (${errors.length}) ---` );
  for ( const e of errors.slice( 0, 10 ) ) console.log( e.slice( 0, 400 ) );
  process.exit( 2 );
}
