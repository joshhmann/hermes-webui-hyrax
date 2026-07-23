# Hyrax 3D bundle

This directory is an isolated Vite library package for the existing Tai
Synthesis Loft implementation. It does not add a build step or dependencies to
the Hermes WebUI root.

## ES module API

Import the production module and mount it into a host element:

```js
import { mountTaiLoft } from '/static/hyrax/3d/embodiment-bundle.js'

const cleanup = await mountTaiLoft(host, returnToVisualNovel)
// Later:
cleanup()
```

`mountTaiLoft(host, onExit, options?)` accepts:

- `vrmUrl`: avatar URL. Defaults to
  `/api/hyrax/assets/tai.embodiment.vrm`.
- `development`: enables the lighting selector, rig and motion workbench,
  diagnostic controls, and Shift+T shortcut. Defaults to `false`.

The returned cleanup callback preserves the room's listener and renderer
cleanup behavior. The module does not install a global browser API.

## Package checks

Run `npm install` and `npm run check` from this directory. The build emits only:

- `../static/hyrax/3d/embodiment-bundle.js`
- `../static/hyrax/3d/embodiment-bundle.css`
