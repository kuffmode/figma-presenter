# Figma Presenter

Present Figma Slides decks outside Figma, with shader effects running live on the GPU.

Design in Figma, press **Publish** in the plugin, present here.

- `index.html`, `app/` — the presenter (a static web app; needs a browser with WebGPU, e.g. Chrome).
- `plugin/` — the Figma plugin that publishes a deck.
- `test/` — a synthetic two-slide deck for checking the renderer.

## How it fits together

1. The **Publish to Presenter** plugin exports each slide as layers: pictures for ordinary layers, and for layers
   with a shader effect the unshaded picture plus the shader's settings. It also records transitions, speaker notes
   and thumbnails.
2. The plugin uploads the deck to a private GitHub repository (the "decks repository").
3. The presenter reads decks from that repository, keeps a copy in the browser for offline use, and renders them.
   Shader code lives in the decks repository under `shaders/<version>.js` and is run unmodified.

## Setting up

1. Create a private repository for decks (with a README so it is not empty).
2. Create a fine-grained GitHub access token limited to that repository with **Contents: read and write**.
3. In the Figma desktop app: Plugins → Development → Import plugin from manifest… → choose `plugin/manifest.json`.
4. Open a Slides deck, run the plugin, enter the repository (`owner/name`) and token, press Publish.
5. Open the presenter, enter the same repository and token, open the deck.

## Presenting

| Key | Action |
| --- | --- |
| → / Space | next slide |
| ← | previous slide (plays the transition in reverse) |
| F | full screen |
| P | presenter window: notes, next slide, timer, laser pointer |
| L | laser pointer in this window |
| T | timer |
| D | frame times of the last transition |
| Esc | back to the deck list |

## Known limits

- Transitions: smart animate and dissolve are implemented; other styles fall back to dissolve.
- Smart animate matches layers by name and position in the layer tree; rotation is not tweened.
- Blend modes other than normal, multiply, screen and add are approximated.
- Only the first shader effect on a layer is used.
