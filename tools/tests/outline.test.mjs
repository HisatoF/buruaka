#!/usr/bin/env node
/**
 * Proves the outline pass edges surfaces rather than painting over them.
 *
 * An inverted hull that is not biased backwards in depth ties with the surface
 * it surrounds, and on thin shells — a hair strand, a skirt pleat — it wins
 * often enough to render the whole garment as ink. That failure is invisible
 * in code review and easy to mistake for "the shading is too dark", so it is
 * measured: sample the same pixels with the outline meshes shown and hidden,
 * and assert the colour barely moves.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync( 'tools/out/outline', { recursive: true } );

const browser = await chromium.launch( {
  executablePath: existsSync( CHROME ) ? CHROME : undefined,
  args: [ '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader', '--mute-audio' ],
} );
const page = await browser.newPage( { viewport: { width: 1000, height: 700 } } );
await page.goto( 'http://127.0.0.1:5210/char.html', { waitUntil: 'domcontentloaded', timeout: 60000 } );
await page.waitForFunction( () => window.__GAME_READY__ === true, null, { timeout: 90000 } );

const setOutlines = ( on ) => page.evaluate( ( v ) => {
  let n = 0;
  window.__engine.scene.traverse( ( o ) => {
    if ( o.name && o.name.endsWith( '_outline' ) ) { o.visible = v; n++; }
  } );
  window.__engine.postfx.render( 0.016, 1 );
  return n;
}, on );

await page.evaluate( () => window.__capture( 'full' ) );
await page.waitForTimeout( 500 );

/*
 * Sample many points inside the character silhouette and take the MEDIAN
 * change when the outline meshes are hidden.
 *
 * A whole-frame diff cannot tell "edging" from "overpainting" — a correct
 * outline still repaints every silhouette, pleat and strand at this framing.
 * And a handful of hand-placed probes land on edges by luck. The median over
 * a dense interior grid is decided by the bulk of the surface: if the outline
 * is edging, most interior pixels do not move at all.
 */
const probes = await page.evaluate( () => {
  const cam = window.__engine.camera;
  const chars = window.__chars.filter( ( c ) => c.root.visible );
  const pts = [];

  for ( const c of chars ) {
    const box = new ( window.__engine.scene.constructor.prototype.constructor ) ? null : null;
    // Screen-space bounds from the skeleton, which is cheap and always posed.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const v = c.bones.hips.position.clone();
    for ( const name of Object.keys( c.bones ) ) {
      c.bones[ name ].getWorldPosition( v );
      const p = v.clone().project( cam );
      const x = ( p.x * 0.5 + 0.5 ) * window.innerWidth;
      const y = ( -p.y * 0.5 + 0.5 ) * window.innerHeight;
      minX = Math.min( minX, x ); maxX = Math.max( maxX, x );
      minY = Math.min( minY, y ); maxY = Math.max( maxY, y );
    }
    // Inset hard so the grid stays well clear of the silhouette edge.
    const ix = ( maxX - minX ) * 0.22, iy = ( maxY - minY ) * 0.12;
    for ( let gy = 0; gy < 9; gy++ ) for ( let gx = 0; gx < 5; gx++ ) {
      pts.push( {
        label: c.design.name,
        x: Math.round( minX + ix + ( maxX - minX - ix * 2 ) * ( gx / 4 ) ),
        y: Math.round( minY + iy + ( maxY - minY - iy * 2 ) * ( gy / 8 ) ),
      } );
    }
  }
  return pts;
} );

const count = await setOutlines( true );
await page.waitForTimeout( 350 );
await page.screenshot( { path: 'tools/out/outline/on.png' } );
const on = await page.screenshot();

await setOutlines( false );
await page.waitForTimeout( 350 );
await page.screenshot( { path: 'tools/out/outline/off.png' } );
const off = await page.screenshot();

await browser.close();

// The browser is the PNG decoder.
const b2 = await chromium.launch( {
  executablePath: existsSync( CHROME ) ? CHROME : undefined,
  args: [ '--no-sandbox', '--disable-dev-shm-usage' ],
} );
const p2 = await b2.newPage();
const diff = await p2.evaluate( async ( [ a, b, pts ] ) => {
  const load = ( d ) => new Promise( ( res ) => {
    const img = new Image();
    img.onload = () => res( img );
    img.src = 'data:image/png;base64,' + d;
  } );
  const [ ia, ib ] = await Promise.all( [ load( a ), load( b ) ] );
  const c = document.createElement( 'canvas' );
  c.width = ia.width; c.height = ia.height;
  const ctx = c.getContext( '2d' );
  ctx.drawImage( ia, 0, 0 );
  const da = ctx.getImageData( 0, 0, c.width, c.height ).data;
  ctx.clearRect( 0, 0, c.width, c.height );
  ctx.drawImage( ib, 0, 0 );
  const db = ctx.getImageData( 0, 0, c.width, c.height ).data;

  const hex = ( d, i ) => '#' + [ d[ i ], d[ i + 1 ], d[ i + 2 ] ]
    .map( ( n ) => n.toString( 16 ).padStart( 2, '0' ) ).join( '' );

  // Average a small patch so a single stray edge pixel can't decide the test.
  const patch = ( data, px, py ) => {
    let r = 0, g = 0, bl = 0, n = 0;
    for ( let dy = -2; dy <= 2; dy++ ) for ( let dx = -2; dx <= 2; dx++ ) {
      const x = px + dx, y = py + dy;
      if ( x < 0 || y < 0 || x >= c.width || y >= c.height ) continue;
      const i = ( y * c.width + x ) * 4;
      r += data[ i ]; g += data[ i + 1 ]; bl += data[ i + 2 ]; n++;
    }
    return n ? [ r / n, g / n, bl / n ] : [ 0, 0, 0 ];
  };

  // A bone can project outside the viewport (an off-screen arm swing), so
  // every probe is clamped before it indexes the pixel buffer.
  const clamp = ( v, hi ) => Math.max( 0, Math.min( hi - 1, v | 0 ) );
  const samples = pts.map( ( raw ) => {
    const p = { label: raw.label, x: clamp( raw.x, c.width ), y: clamp( raw.y, c.height ) };
    const A = patch( da, p.x, p.y );
    const B = patch( db, p.x, p.y );
    const delta = Math.round( Math.abs( A[ 0 ] - B[ 0 ] ) + Math.abs( A[ 1 ] - B[ 1 ] ) + Math.abs( A[ 2 ] - B[ 2 ] ) );
    const idx = ( p.y * c.width + p.x ) * 4;
    return { label: p.label, x: p.x, y: p.y, withOutline: hex( da, idx ), without: hex( db, idx ), delta };
  } );

  const sorted = samples.map( ( s ) => s.delta ).sort( ( a, b ) => a - b );
  const median = sorted[ Math.floor( sorted.length / 2 ) ] ?? 0;
  const p90 = sorted[ Math.floor( sorted.length * 0.9 ) ] ?? 0;
  const worstSamples = samples.slice().sort( ( a, b ) => b.delta - a.delta ).slice( 0, 4 );
  return { count: samples.length, median, p90, worstSamples };
}, [ on.toString( 'base64' ), off.toString( 'base64' ), probes ] );
await b2.close();

console.log( JSON.stringify( { outlineMeshes: count, ...diff }, null, 2 ) );

// Most interior pixels must not move at all when the outline is hidden. A
// median above a few units means the hull is covering surfaces; the p90 is
// allowed to be larger because some grid points inevitably land on a real
// internal edge — a pleat crease, a strand boundary.
const failed = diff.median > 12 || diff.p90 > 220;
console.log( failed
  ? 'FAIL: outline is repainting surfaces, not edging them'
  : 'PASS: outline confined to silhouette edges' );
process.exit( failed ? 1 : 0 );
