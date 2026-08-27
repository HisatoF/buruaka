#!/usr/bin/env node
/**
 * Guards against two classes of bug that are silent until something looks
 * wrong on screen:
 *
 *  1. A backtick inside a `/* glsl *\/` template literal terminates the string
 *     early and leaves the rest of the shader being parsed as JavaScript. This
 *     shipped once in the VFX module and cost 2000 lines of dead code.
 *  2. An outline material that reads `transformedNormal` while using
 *     THREE.BackSide, which three negates under FLIP_SIDED — expanding the
 *     inverted hull inward and rendering no outline at all.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve( 'src' );
const files = [];
( function walk( dir ) {
  for ( const e of readdirSync( dir, { withFileTypes: true } ) ) {
    const p = path.join( dir, e.name );
    if ( e.isDirectory() ) walk( p );
    else if ( e.name.endsWith( '.js' ) ) files.push( p );
  }
} )( ROOT );

let failures = 0;
const fail = ( msg ) => { console.log( 'FAIL: ' + msg ); failures++; };

const GLSL_BLOCK = /\/\* glsl \*\/ `([\s\S]*?)`;/g;

for ( const file of files ) {
  const src = readFileSync( file, 'utf8' );
  const rel = path.relative( process.cwd(), file );

  for ( const m of src.matchAll( GLSL_BLOCK ) ) {
    if ( m[ 1 ].includes( '`' ) ) fail( `${rel}: backtick inside a GLSL template literal` );
  }

  // An inverted-hull expansion (identified by its thickness uniform) must not
  // steer by transformedNormal: those materials are BackSide, and three
  // negates the normal under FLIP_SIDED, so the hull collapses inward and no
  // outline renders at all. Scoped to the hull block specifically, since the
  // surface shaders in the same file use transformedNormal correctly.
  for ( const m of src.matchAll( GLSL_BLOCK ) ) {
    if ( !/uThickness/.test( m[ 1 ] ) ) continue;
    if ( /normalize\(\s*transformedNormal\s*\)/.test( m[ 1 ] ) ) {
      fail( `${rel}: inverted-hull shader steers by transformedNormal — negated under FLIP_SIDED` );
    }
  }
}

console.log( failures ? `${failures} shader guard failure(s)` : `shader guards clean (${files.length} files)` );
process.exit( failures ? 1 : 0 );
