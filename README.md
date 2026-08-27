# BURUAKA — Kivotos Tactical

A cel-shaded anime tactical shooter built in Three.js.

**Every asset is generated at runtime from code.** There is not a single
image, model, or audio file in this repository — the characters, their faces,
the weapons, the arena, the textures, the sound effects and the music are all
synthesised when the page loads.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/
```

## Controls

| Input | Action |
|---|---|
| `W A S D` | Move the squad's rally point |
| Mouse drag | Orbit the camera |
| Mouse wheel | Zoom |
| `1` – `4` | Fire a student's EX skill |
| `P` / `Esc` | Pause |

The squad fights autonomously — they advance to contact, take cover, pick
targets and reload on their own. Your job is positioning and timing the EX
skills against a shared cost bar, which is the shape the genre is built on.

## What's in here

### Rendering

The look is a three-tone cel shader (`src/render/ToonMaterial.js`) with
hue-shifted violet shadows rather than flat darkening, a hard-edged specular
band for hair and gunmetal, and a fresnel rim gated to the silhouette.
Outlines are inverted hulls that hold a constant pixel width at any distance,
backed by an averaged-normal attribute so hard edges don't split open.

The post stack deliberately skips ACES. A filmic curve desaturates exactly the
flat saturated primaries that make cel shading read as cel shading, so
`src/render/PostFX.js` uses a hue-preserving highlight rolloff, a split-tone,
and a grade applied in gamma space instead.

### Characters

Characters are modelled as plain geometry in bind pose and skinned afterwards
by solving weights against per-bone capsules (`src/gen/Rig.js`), so a new
outfit piece is correctly skinned the moment it is modelled. Hair is built in
three layers — an offset skull shell with the face carved out, static clumps
welded to the head, and bone-driven chains for twintails and ponytails.

Faces are sprite cards on a shared atlas rather than baked into the head
texture, so blinking and expression are UV writes and the whole face renders
in one draw call. The eye art is drawn with variable-width filled ink strokes:
a fixed `lineWidth` stroke is what makes procedural line art look procedural.

An entire character — skin, shirt, skirt, socks, shoes — merges into a single
draw call via a vertex tint attribute, while still reading as separate
materials.

### Animation

No clips. `src/anim/Animator.js` layers breathing, locomotion, flinch, reload,
skill and downed poses as additive Euler offsets in a pose buffer applied once
per frame, so blending is order-independent. Aiming is analytic two-bone IK
onto an actual weapon transform rather than authored joint angles — one pose
then serves every weapon at every target elevation.

Hair and cloth get Verlet spring chains recovered as swing-only rotations,
with cone limits and body-sphere collision, on a fixed timestep so they behave
identically at 30 and 144 fps.

### Simulation

`src/physics/World.js` is a purpose-built collision layer: uniform-grid
broadphase, capsule collide-and-slide with step-up and ground snapping, and a
pooled ballistics system that spherecasts each substep so a 300 m/s round
cannot tunnel a thin wall.

## Verification

```bash
node tools/tests/shaders.test.mjs        # GLSL guards (see below)
node tools/tests/physics.test.mjs        # collision, ballistics, queries, bench
node tools/tests/ik.test.mjs             # two-bone IK reach and elbow orientation
node tools/tests/penetration.test.mjs    # samples a crowded wave for interpenetration
node tools/tests/gameflow.test.mjs       # boss spawn, status effects, in-process restart
node tools/perf.mjs --play 60            # simulation cost + draw calls

node tools/screenshot.mjs --play 55 --shots game,firefight,overShoulder
node tools/screenshot.mjs --play 40 --wave 8 --shots game     # the boss encounter
```

`tools/screenshot.mjs` boots a dev server, renders in headless Chromium and
exits non-zero on any console error, page exception or failed shader compile.
`--play N` fast-forwards the simulation N seconds so captures show a live
firefight rather than a menu; `--wave N` jumps the wave director. It also
refuses any frame the page reports as unhealthy — a lost WebGL context drops
back to the loading screen, and a harness that only watches the console will
happily save that and report success.

`tools/tests/shaders.test.mjs` guards two bugs that are invisible until
something looks wrong on screen: a backtick inside a `/* glsl */` template
literal, which terminates the string and leaves the rest of the shader parsed
as JavaScript; and an inverted-hull outline steering by `transformedNormal`
while using `THREE.BackSide`, which three negates under `FLIP_SIDED` so the
hull expands inward and no outline renders at all. Both have happened here.

Three debug pages exist for judging pieces in isolation: `char.html`
(character viewer, no HUD), `debug.html` (2D face atlases), and `audio.html`,
which renders every synthesised sound through an `OfflineAudioContext` and
reports peak, RMS, duration and onset taper.

### Measured

| | |
|---|---|
| Simulation | 1.2 ms mean, 2.4 ms p95 per frame at 7 units — 7% of a 60fps budget |
| Scene | ~153 draw calls, ~600k triangles |
| Physics | 0.23 ms/step for 41 bodies; no tunnelling at 300 m/s through a 0.1 m wall |
| Interpenetration | 1000 samples at up to 12 units: zero, world or unit-vs-unit |
| Audio | 32/32 sounds non-silent, none clipping; 12 s of music with no dropout |
| Bundle | 273 kB gzipped, entire game |

The rendering framerate is deliberately not quoted. This was developed in a
sandbox with no GPU, where SwiftShader reports numbers that say nothing about
real hardware. The simulation figure is pure JavaScript and does transfer.

## Layout

```
src/
  core/     Engine (renderer, frame loop, adaptive resolution), Input, Audio
  render/   ToonMaterial, PostFX, Sky, Lighting, Particles
  gen/      Geometry, Rig, Character, Hair, Face, Weapon, Level, Textures
  anim/     Animator (pose layers + two-bone IK)
  physics/  World (collision, ballistics, queries), SpringBone
  game/     Game, Unit, Skills, Waves, CameraRig
  ui/       HUD, styles
```

See `docs/ARCHITECTURE.md` for module contracts and conventions.
