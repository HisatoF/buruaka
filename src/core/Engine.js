import * as THREE from 'three';

import { PostFX } from '../render/PostFX.js';

/**
 * Owns the renderer, the render target sizing policy and the frame loop.
 * Everything else in the game is a system registered against it.
 */
export class Engine {
  constructor( canvas, options = {} ) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer( {
      canvas,
      antialias: false,          // SMAA in the composer handles this
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    } );

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Cel shading is graded by hand in PostFX; a filmic curve here would
    // desaturate the flat primaries the whole look depends on.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor( 0x0b1626, 1 );

    this.maxPixelRatio = options.maxPixelRatio ?? 2;
    this.renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, this.maxPixelRatio ) );

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera( 34, 16 / 9, 0.4, 400 );
    this.camera.position.set( 0, 9, 14 );
    this.camera.lookAt( 0, 1.2, 0 );

    this.timer = new THREE.Timer();
    this.elapsed = 0;
    this.frame = 0;

    this.systems = [];
    this._resizeHandler = () => this.resize();
    window.addEventListener( 'resize', this._resizeHandler );

    this.postfx = new PostFX( this.renderer, this.scene, this.camera, options.postfx );

    // Rolling FPS for the adaptive-resolution governor.
    this._fpsSamples = [];
    this._adaptiveScale = 1;
    this.adaptiveResolution = options.adaptiveResolution ?? true;

    this.resize();
  }

  add( system ) {
    this.systems.push( system );
    return system;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const pr = Math.min( window.devicePixelRatio || 1, this.maxPixelRatio ) * this._adaptiveScale;

    this.camera.aspect = w / h;
    // Widescreen framing: keep the vertical field stable, widen horizontally.
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio( pr );
    this.renderer.setSize( w, h, false );
    this.postfx.setSize( w, h, pr );

    this.width = w;
    this.height = h;
    this.pixelRatio = pr;

    for ( const s of this.systems ) s.onResize?.( w, h, pr );
  }

  /** Drops internal resolution if the frame budget is consistently blown. */
  _governResolution( dt ) {
    if ( !this.adaptiveResolution ) return;
    this._fpsSamples.push( 1 / Math.max( dt, 1e-4 ) );
    if ( this._fpsSamples.length < 90 ) return;

    const sorted = this._fpsSamples.slice().sort( ( a, b ) => a - b );
    const p10 = sorted[ Math.floor( sorted.length * 0.1 ) ];
    this._fpsSamples.length = 0;

    let next = this._adaptiveScale;
    if ( p10 < 40 && next > 0.65 ) next = Math.max( 0.65, next - 0.15 );
    else if ( p10 > 58 && next < 1 ) next = Math.min( 1, next + 0.1 );

    if ( next !== this._adaptiveScale ) {
      this._adaptiveScale = next;
      this.resize();
    }
  }

  start() {
    if ( this._running ) return;
    this._running = true;


    const loop = () => {
      if ( !this._running ) return;
      this._raf = requestAnimationFrame( loop );

      // Clamped so an alt-tab or a GC hitch never teleports the simulation.
      this.timer.update();
      const dt = Math.min( this.timer.getDelta(), 1 / 20 );
      this.elapsed += dt;
      this.frame++;

      for ( const s of this.systems ) s.update?.( dt, this.elapsed );
      this.postfx.render( dt, this.elapsed );
      for ( const s of this.systems ) s.postRender?.( dt, this.elapsed );

      this._governResolution( dt );
    };
    this._raf = requestAnimationFrame( loop );
  }

  stop() {
    this._running = false;
    if ( this._raf ) cancelAnimationFrame( this._raf );
  }

  dispose() {
    this.stop();
    window.removeEventListener( 'resize', this._resizeHandler );
    this.postfx.dispose();
    this.renderer.dispose();
  }
}
