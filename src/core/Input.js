import * as THREE from 'three';

/**
 * Unified keyboard / mouse / touch input.
 *
 * Exposes edge-triggered state (`pressed`) alongside level state (`down`) so
 * gameplay code never has to track "was this key already held last frame"
 * itself — the single most common source of double-fired abilities.
 */
export class Input {
  constructor( element, opts = {} ) {
    this.element = element;
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();

    this.pointer = new THREE.Vector2();      // normalised device coords
    this.pointerPixels = new THREE.Vector2();
    this.dragDelta = new THREE.Vector2();
    this.wheel = 0;
    this.pointerDown = false;
    this.pointerJustDown = false;
    this.pointerJustUp = false;

    this.stick = new THREE.Vector2();         // virtual stick / WASD, -1..1
    this.isTouch = matchMedia?.( '(pointer: coarse)' )?.matches ?? false;

    this._lastPointer = new THREE.Vector2();
    this._handlers = [];
    this._enabled = true;

    const on = ( target, type, fn, options ) => {
      target.addEventListener( type, fn, options );
      this._handlers.push( [ target, type, fn ] );
    };

    on( window, 'keydown', ( e ) => {
      if ( e.repeat ) return;
      // Let the browser keep its own shortcuts; only swallow keys we bind.
      const code = e.code;
      if ( !this._enabled ) return;
      this.down.add( code );
      this.pressed.add( code );
      if ( opts.preventDefault !== false && PREVENT.has( code ) ) e.preventDefault();
    } );

    on( window, 'keyup', ( e ) => {
      this.down.delete( e.code );
      this.released.add( e.code );
    } );

    // A window blur while a key is held would otherwise leave it stuck down.
    on( window, 'blur', () => { this.down.clear(); this.stick.set( 0, 0 ); } );

    on( element, 'pointerdown', ( e ) => {
      if ( !this._enabled ) return;
      element.setPointerCapture?.( e.pointerId );
      this.pointerDown = true;
      this.pointerJustDown = true;
      this._lastPointer.set( e.clientX, e.clientY );
      this._updatePointer( e );
    } );

    on( element, 'pointermove', ( e ) => {
      this._updatePointer( e );
      if ( this.pointerDown ) {
        this.dragDelta.x += e.clientX - this._lastPointer.x;
        this.dragDelta.y += e.clientY - this._lastPointer.y;
      }
      this._lastPointer.set( e.clientX, e.clientY );
    } );

    const endPointer = ( e ) => {
      if ( !this.pointerDown ) return;
      this.pointerDown = false;
      this.pointerJustUp = true;
      element.releasePointerCapture?.( e.pointerId );
    };
    on( element, 'pointerup', endPointer );
    on( element, 'pointercancel', endPointer );

    on( element, 'wheel', ( e ) => {
      if ( !this._enabled ) return;
      this.wheel += Math.sign( e.deltaY );
      e.preventDefault();
    }, { passive: false } );

    on( element, 'contextmenu', ( e ) => e.preventDefault() );
  }

  _updatePointer( e ) {
    const r = this.element.getBoundingClientRect();
    this.pointerPixels.set( e.clientX - r.left, e.clientY - r.top );
    this.pointer.set(
      ( this.pointerPixels.x / r.width ) * 2 - 1,
      -( this.pointerPixels.y / r.height ) * 2 + 1
    );
  }

  setEnabled( on ) {
    this._enabled = on;
    if ( !on ) { this.down.clear(); this.stick.set( 0, 0 ); }
  }

  isDown( code ) { return this.down.has( code ); }
  wasPressed( code ) { return this.pressed.has( code ); }
  wasReleased( code ) { return this.released.has( code ); }

  /** Call once per frame, after all systems have read this frame's input. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.dragDelta.set( 0, 0 );
    this.wheel = 0;
    this.pointerJustDown = false;
    this.pointerJustUp = false;
  }

  /** WASD / arrows folded into the same vector a virtual stick writes to. */
  readMoveAxis() {
    let x = 0, y = 0;
    if ( this.isDown( 'KeyA' ) || this.isDown( 'ArrowLeft' ) ) x -= 1;
    if ( this.isDown( 'KeyD' ) || this.isDown( 'ArrowRight' ) ) x += 1;
    if ( this.isDown( 'KeyW' ) || this.isDown( 'ArrowUp' ) ) y += 1;
    if ( this.isDown( 'KeyS' ) || this.isDown( 'ArrowDown' ) ) y -= 1;

    const v = this._axis ?? ( this._axis = new THREE.Vector2() );
    v.set( x + this.stick.x, y + this.stick.y );
    if ( v.lengthSq() > 1 ) v.normalize();
    return v;
  }

  dispose() {
    for ( const [ target, type, fn ] of this._handlers ) target.removeEventListener( type, fn );
    this._handlers.length = 0;
  }
}

const PREVENT = new Set( [
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Tab',
] );
