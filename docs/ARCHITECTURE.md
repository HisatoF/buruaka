# BURUAKA — Architecture & Module Contracts

A cel-shaded real-time tactical action game in Three.js, art-directed after the
"Kivotos" anime key-visual look: flat saturated colours, hue-shifted violet
shadows, hard specular bands, thin dark outlines, bright high-key skies.

Everything in the game — every mesh, every texture, every sound — is generated
at runtime from code. There are no binary assets in the repository.

## Conventions

| Thing | Convention |
|---|---|
| Units | 1 unit = 1 metre. Ground plane sits at `y = 0`. |
| Up axis | `+Y` |
| Character forward | Local `+Z` (matches `Object3D.lookAt`, which aims `+Z` at the target for non-camera objects) |
| Character height | ~1.62 m, ~6.5 heads — stylised anime proportion, not chibi |
| Angles | Radians |
| Time | Seconds. Every `update(dt, elapsed)` takes clamped delta first, absolute elapsed second |
| Colour literals | Hex ints (`0xff5d6c`), converted through `THREE.Color` so colour management applies |
| Module style | ES modules, named exports, no default exports |

## Directory map

```
src/
  main.js              bootstrap + capture hooks
  core/
    Engine.js          renderer, frame loop, adaptive resolution, resize    [OWNED: core]
    Input.js           keyboard / mouse / touch                            [OWNED: core]
    Audio.js           procedural WebAudio SFX + music                     [OWNED: audio]
  render/
    ToonMaterial.js    Kivotos cel shader + outline + smooth normals        [OWNED: core]
    PostFX.js          bloom / grade / SMAA composer                        [OWNED: core]
    Sky.js             procedural anime sky                                 [OWNED: core]
    Lighting.js        key light + shadow rig                               [OWNED: core]
    Particles.js       GPU particle system + VFX presets                    [OWNED: vfx]
  gen/
    Textures.js        procedural canvas textures                           [OWNED: textures]
    Face.js            anime face textures                                  [OWNED: core]
    Character.js       skinned anime character builder                      [OWNED: core]
    Level.js           arena geometry                                       [OWNED: core]
  physics/
    World.js           collision, raycast, ballistics, spring bones         [OWNED: physics]
  anim/
    Animator.js        procedural pose graph                                [OWNED: core]
  game/
    Game.js, Combat.js, Enemy.js, Waves.js, Skills.js, Director.js
  ui/
    HUD.js, hud.css    DOM heads-up display                                 [OWNED: hud]
    styles.css         base UI system                                       [OWNED: core]
```

**File ownership is exclusive.** Do not edit a file owned by another module.

## Shared services

### `render/ToonMaterial.js`
```js
import { createToonMaterial, createOutlineMaterial, computeSmoothNormals } from '../render/ToonMaterial.js';

const mat = createToonMaterial({
  color: 0xff5d6c,        // base albedo
  map: texture|null,       // optional; alpha is respected
  shadowTint: 0x7a72a8,    // multiplier applied in the core shadow band
  midTint: 0xb9b2d4,       // multiplier applied in the mid band
  flatten: 0,              // 1 = ignore the ramp entirely (faces, eyes)
  rimColor, rimStrength, rimBacklight,
  specStrength, specGloss, specStep, specBand, specBandPos, specBandWidth,
  ambient, emissive, emissiveIntensity, opacity, alphaTest, transparent, side,
});
```
It is a `ShaderMaterial` with `lights: true`. It reads `directionalLights[0]`
only. `mat.color` and `mat.emissiveColor` are live `THREE.Color` accessors.

Outlines are inverted hulls; call `computeSmoothNormals(geometry)` first or
hard edges will split the outline open.

### Palette
```js
export const PALETTE = {
  skin: 0xffe2cf, skinShadow: 0xd9a08f,
  uniformWhite: 0xf6f8fc, uniformNavy: 0x2b3350,
  accentBlue: 0x35a3ea, accentCyan: 0x7fd6ff,
  enemyRed: 0xff5d6c, enemyDeep: 0xc8213a,
  cost: 0xffd54a, heal: 0x4ce0a4, warn: 0xffc23d,
  halo: 0x9fe8ff, ink: 0x2b2138,
};
```

## Quality levels

Every system exposes `setQuality(level)` with `0 = potato, 1 = balanced, 2 = maximum`.

## Hard-won gotchas

Two of these cost a full review round each. They are guarded by
`tools/tests/shaders.test.mjs` now, but they are worth knowing.

**A backtick inside a `/* glsl */` template literal terminates the string.**
The rest of the shader is then parsed as JavaScript and the file fails to load
in a way that points at a line of GLSL. This has happened twice in this repo.

**`THREE.BackSide` negates your normal.** three sets
`flipSided: material.side === BackSide`, which defines `FLIP_SIDED`, which
makes `<defaultnormal_vertex>` negate `transformedNormal`. An inverted-hull
outline that steers by it expands *inward*: no outline renders, and the
collapsed hull z-fights out through thin geometry, which looks like stripes on
hair and sawtooth speckle on hems. Steer by `normalMatrix * objectNormal`
instead — `objectNormal` is already skinned by `<skinnormal_vertex>` and is not
touched by the flip.

**`receiveShadow = false` does nothing for a custom `ShaderMaterial`.** In
r185 `USE_SHADOWMAP` is defined purely from `renderer.shadowMap.enabled`, with
no per-object gate. A shader that samples the shadow map samples it regardless.
Gate it yourself with a uniform.

**Ramp tints are multipliers, not colours.** Passing them through
`new THREE.Color(hex)` gamma-decodes them, so `0x999999` becomes 0.33 rather
than 0.6 and every saturated dark crushes to black. Use
`setHex(v, THREE.LinearSRGBColorSpace)`.

**Grade in gamma space, not linear.** Applying contrast around a 0.5 pivot to
linear radiance takes a navy at 0.055 down to 0.015.

## Verification

`node tools/screenshot.mjs [--shots a,b] [--width W] [--height H]` boots a dev
server, renders in headless Chromium and writes PNGs to `tools/out/`. It exits
non-zero on any console error, page exception or failed shader compile. Every
change must leave this passing.

The page exposes:
- `window.__GAME_READY__` — set true when the first frame is safe to capture
- `window.__capture(name)` — apply a named camera framing
- `window.__captureList()` — the available framing names
- `window.__diagnostics()` — draw calls, triangles, program count
