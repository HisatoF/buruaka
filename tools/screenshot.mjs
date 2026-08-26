#!/usr/bin/env node
/**
 * Headless capture harness.
 *
 * Boots the dev server, loads the game in Chromium, waits for the scene to
 * report ready, then drives `window.__capture` to grab a named set of camera
 * framings. Any console error, page exception or failed shader compile is
 * collected and printed — a non-empty error list exits non-zero so the visual
 * QA loop can't silently pass on a broken build.
 *
 * Usage: node tools/screenshot.mjs [--out tools/out] [--shots a,b,c] [--width 1600] [--height 900]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice( 2 ).flatMap( ( a, i, arr ) =>
    a.startsWith( '--' ) ? [ [ a.slice( 2 ), arr[ i + 1 ]?.startsWith( '--' ) === false ? arr[ i + 1 ] : 'true' ] ] : []
  )
);

const OUT = path.resolve( args.out ?? 'tools/out' );
const WIDTH = Number( args.width ?? 1600 );
const HEIGHT = Number( args.height ?? 900 );
const PORT = Number( args.port ?? 5199 );
const CLEAN = args.clean !== 'false';

if ( CLEAN && existsSync( OUT ) ) rmSync( OUT, { recursive: true, force: true } );
mkdirSync( OUT, { recursive: true } );

async function waitForServer( url, timeoutMs = 60000 ) {
  const deadline = Date.now() + timeoutMs;
  while ( Date.now() < deadline ) {
    try {
      const r = await fetch( url, { signal: AbortSignal.timeout( 2000 ) } );
      if ( r.ok ) return true;
    } catch { /* not up yet */ }
    await sleep( 300 );
  }
  return false;
}

// `--url` attaches to an already-running dev server, which keeps the
// iteration loop fast and avoids port contention when several capture runs
// overlap.
const EXTERNAL = args.url ?? null;

const server = EXTERNAL ? null : spawn( 'npx', [ 'vite', '--host', '127.0.0.1', '--port', String( PORT ), '--strictPort' ], {
  stdio: [ 'ignore', 'pipe', 'pipe' ],
  env: { ...process.env, NO_COLOR: '1' },
} );
let serverLog = '';
server?.stdout.on( 'data', ( d ) => ( serverLog += d ) );
server?.stderr.on( 'data', ( d ) => ( serverLog += d ) );

const shutdown = () => { try { server?.kill( 'SIGTERM' ); } catch {} };
process.on( 'exit', shutdown );
process.on( 'SIGINT', () => { shutdown(); process.exit( 130 ); } );

const url = ( EXTERNAL ?? `http://127.0.0.1:${PORT}/` ).replace( /\/$/, '/' ) + ( args.page ?? '' );
if ( !( await waitForServer( url ) ) ) {
  console.error( 'Dev server never came up.\n' + serverLog );
  process.exit( 1 );
}

// The image ships Chromium at a fixed revision; pin to it rather than letting
// Playwright hunt for a build number matching its own version.
const CHROME_PATH = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch( {
  executablePath: existsSync( CHROME_PATH ) ? CHROME_PATH : undefined,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-lcd-text',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--mute-audio',
  ],
} );

const page = await browser.newPage( { viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 } );

const errors = [];
const warnings = [];
// Google Fonts is a progressive enhancement; the CSS carries full local
// fallbacks, so a blocked font fetch is not a build failure.
const IGNORABLE = [ 'fonts.googleapis', 'fonts.gstatic', 'favicon' ];
const ignorable = ( t ) => IGNORABLE.some( ( k ) => t.includes( k ) );

page.on( 'console', ( m ) => {
  const text = m.text();
  const loc = m.location?.().url ?? '';
  if ( ignorable( text ) || ignorable( loc ) ) return;
  if ( m.type() === 'error' ) errors.push( text );
  else if ( m.type() === 'warning' ) warnings.push( text );
} );
page.on( 'pageerror', ( e ) => errors.push( `PAGEERROR: ${e.message}\n${e.stack ?? ''}` ) );
page.on( 'requestfailed', ( r ) => {
  const f = r.failure()?.errorText ?? '';
  // Google Fonts is optional; the CSS has full local fallbacks.
  if ( !ignorable( r.url() ) ) errors.push( `REQUESTFAILED: ${r.url()} ${f}` );
} );

let ready = false;
try {
  await page.goto( url, { waitUntil: 'domcontentloaded', timeout: 60000 } );
  await page.waitForFunction( () => window.__GAME_READY__ === true, null, { timeout: 90000 } );
  ready = true;
} catch ( e ) {
  errors.push( `READY TIMEOUT: ${e.message}` );
}

const shots = ( args.shots ?? '' ).split( ',' ).map( ( s ) => s.trim() ).filter( Boolean );
const captured = [];

if ( ready ) {
  const available = await page.evaluate( () => window.__captureList?.() ?? [] );
  const list = shots.length ? shots : available;

  for ( const name of list ) {
    try {
      await page.evaluate( ( n ) => window.__capture?.( n ), name );
      // Let the deferred passes (bloom pyramid, SMAA) settle on the new frame.
      await page.waitForTimeout( Number( args.settle ?? 450 ) );
      const file = path.join( OUT, `${name}.png` );
      await page.screenshot( { path: file, fullPage: args.fullPage === 'true' } );
      captured.push( file );
    } catch ( e ) {
      errors.push( `CAPTURE ${name}: ${e.message}` );
    }
  }

  if ( !list.length ) {
    const file = path.join( OUT, 'default.png' );
    await page.screenshot( { path: file, fullPage: args.fullPage === 'true' } );
    captured.push( file );
  }
}

const diagnostics = ready ? await page.evaluate( () => window.__diagnostics?.() ?? null ) : null;

await browser.close();
shutdown();

console.log( '--- CAPTURED ---' );
for ( const f of captured ) console.log( f );
if ( diagnostics ) console.log( '--- DIAGNOSTICS ---\n' + JSON.stringify( diagnostics, null, 2 ) );
if ( warnings.length ) {
  console.log( `--- WARNINGS (${warnings.length}) ---` );
  for ( const w of warnings.slice( 0, 20 ) ) console.log( w.slice( 0, 600 ) );
}
if ( errors.length ) {
  console.log( `--- ERRORS (${errors.length}) ---` );
  for ( const e of errors.slice( 0, 20 ) ) console.log( e.slice( 0, 3000 ) );
  process.exit( 2 );
}
console.log( 'OK' );
