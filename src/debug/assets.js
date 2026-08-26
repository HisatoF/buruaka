/**
 * 2D asset inspector. Renders every procedurally-drawn canvas to the page so
 * the capture harness can screenshot it and the art can be judged directly,
 * without needing the 3D scene to be working first.
 */
import { makeEyeAtlas, makeBrowAtlas, makeMouthAtlas, makeHeadSkin, EYE_PRESETS } from '../gen/Face.js';

const out = document.getElementById( 'out' );

function section( title ) {
  const h = document.createElement( 'h2' );
  h.textContent = title;
  out.appendChild( h );
  const row = document.createElement( 'div' );
  row.className = 'row';
  out.appendChild( row );
  return row;
}

function show( row, texture, caption, { scale = 1, light = false } = {} ) {
  const src = texture.image ?? texture;
  const fig = document.createElement( 'figure' );
  if ( light ) fig.className = 'light';
  const c = document.createElement( 'canvas' );
  c.width = src.width * scale;
  c.height = src.height * scale;
  const ctx = c.getContext( '2d' );
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage( src, 0, 0, c.width, c.height );
  fig.appendChild( c );
  const cap = document.createElement( 'figcaption' );
  cap.textContent = caption;
  fig.appendChild( cap );
  row.appendChild( fig );
}

const palettes = [
  { name: 'hoshino-ish', iris: 0x6fb7e8, lash: 0x2b2a46, brow: 0x8090b8, shape: 'droopy' },
  { name: 'aru-ish',     iris: 0xd8465e, lash: 0x3a2030, brow: 0x2e2436, shape: 'sharp' },
  { name: 'yuuka-ish',   iris: 0x3fa05e, lash: 0x2c2a24, brow: 0x4c4436, shape: 'round' },
  { name: 'shiroko-ish', iris: 0x5b7ad8, lash: 0x2a3050, brow: 0xa8b4c8, shape: 'cool' },
];

{
  const row = section( 'eye atlases — open / half / closed / smile / wide / angry / sad / dizzy' );
  for ( const p of palettes ) {
    const a = makeEyeAtlas( { cell: 320, irisColor: p.iris, lashColor: p.lash, shape: p.shape } );
    show( row, a.texture, `${p.name} (${p.shape})`, { scale: 0.5, light: true } );
  }
}

{
  const row = section( 'eye detail — open frame at 2x' );
  for ( const p of palettes.slice( 0, 3 ) ) {
    const a = makeEyeAtlas( { cell: 320, irisColor: p.iris, lashColor: p.lash, shape: p.shape } );
    const c = document.createElement( 'canvas' );
    c.width = 512; c.height = 512;
    const ctx = c.getContext( '2d' );
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage( a.texture.image, 0, 0, 320, 320, 0, 0, 512, 512 );
    const fig = document.createElement( 'figure' );
    fig.className = 'light';
    fig.appendChild( c );
    const cap = document.createElement( 'figcaption' );
    cap.textContent = p.name;
    fig.appendChild( cap );
    row.appendChild( fig );
  }
}

{
  const row = section( 'brows' );
  for ( const p of palettes ) {
    show( row, makeBrowAtlas( { cell: 256, color: p.brow } ).texture, p.name, { scale: 0.6, light: true } );
  }
}

{
  const row = section( 'mouths' );
  show( row, makeMouthAtlas( {} ).texture, 'default', { scale: 0.9, light: true } );
}

{
  const row = section( 'head skin (front-planar UV)' );
  show( row, makeHeadSkin( { size: 512 } ), 'default', { scale: 0.7 } );
  show( row, makeHeadSkin( { size: 512, skin: 0xf6d3bd, blush: 0xf0757f, freckles: true } ), 'freckled', { scale: 0.7 } );
  show( row, makeHeadSkin( { size: 512, skin: 0xffeadd, blush: 0xffb0b8 } ), 'pale', { scale: 0.7 } );
}

window.__GAME_READY__ = true;
window.__capture = () => {};
window.__captureList = () => [ 'assets' ];
window.__diagnostics = () => ( { presets: Object.keys( EYE_PRESETS ) } );
