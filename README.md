# Studio Forge

A dark-themed chat app that runs **Claude Code in the background** and connects it to **Roblox Studio** through Studio's MCP server. Ask for a 3D model, a UI or a script. You see it immediately in a live 3D viewer or a pixel-accurate UI preview, and it goes into your open place with one click (or automatically).

![Chat with a live 3D preview of a generated model](docs/screenshot-model.png)

| UI preview (Roblox layout rules) | Studio connection, pull selection, Luau console |
| --- | --- |
| ![UI preview](docs/screenshot-ui.png) | ![Studio panel](docs/screenshot-studio.png) |

## What it does

- **Chat with Claude Code.** Claude Code runs as a background process with your own Claude account (Pro/Max subscription or API key). Replies stream in. Each tool call appears as a step in a collapsible timeline, and every new or edited asset gets a card with Preview and Import buttons. Each reply shows its prompt-cache hit rate, time and output tokens, and the header shows the context size.
- **A composer built for building.** Switch model and effort from the composer. Drop, paste or attach reference images, and attach the asset open in the preview so Claude knows which one you mean (`@asset`). Messages sent while Claude is working are queued and run in order; queued ones can be removed. <kbd>↑</kbd> edits your last message, <kbd>Esc</kbd> stops a reply, and any message can be copied, retried or edited and resent.
- **Command palette.** <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> searches chats and assets and runs actions: import, pull the Studio selection, connect Studio, switch model or effort, translate HTML, export. <kbd>/</kbd> focuses the message box and <kbd>?</kbd> lists every shortcut.
- **Version history.** Every edit to an asset is kept (the last 25 versions). Open the version label in the preview header to restore an earlier one; restoring creates a new version, so nothing is lost.
- **Run Luau from a reply.** Luau code blocks in Claude's replies have a *Run in Studio* button that shows the output inline.
- **Chat tools.** Rename, export as Markdown or delete a chat from its header menu. The browser tab title shows when Claude is working and when a reply finished in the background.
- **3D models.** Claude describes models as Roblox parts (blocks, balls, cylinders, wedges, 40+ materials, lights, sub-groups). The viewer renders them with Roblox-style materials, shadows, reflections and neon bloom. Click any part to inspect it or say "change this part".
- **HTML → Roblox UI translation.** Claude (or you) designs a UI in plain HTML/CSS. Studio Forge renders it in the browser at the design resolution and turns every element into a Roblox GuiObject at exactly the same position. Backgrounds, gradients, corners, borders, shadows, text, rich text, buttons, inputs, images, scrolling lists, `::before`/`::after` and list bullets all carry over. Elements stay anchored to their screen edge or centre, and the whole UI scales proportionally on phones, tablets and 4K. See [HTML → Roblox](#html--roblox-ui-translation).
- **UIs that match Studio.** Claude can also build ScreenGuis from a compact Roblox-native spec (UDim2, AnchorPoint, UICorner, UIStroke, UIGradient, UIPadding, list/grid layouts, AutomaticSize, ScrollingFrames, rich text). The browser preview re-implements Roblox's layout rules and has Desktop/Laptop/Tablet/Phone frames, so what you see is what Studio gets.
- **Scripts.** Script, LocalScript and ModuleScript assets are inserted at any path.
- **One-click import (or auto-import).** Assets are converted to Luau deterministically and run through the Studio MCP. Imports are **undoable** (ChangeHistoryService). Re-importing **updates the previous copy in place**, keeping its position, and the new object is selected in Studio.
- **Export and import.** Download any asset as `.rbxmx` (drag into Studio), `.luau` (paste into the command bar) or `.json`. Pull the current Studio selection (Parts/Models or GUIs) back into the app, let Claude improve it, then push it back.
- **Studio tools for Claude.** Claude can run Luau, search the instance tree, inspect instances, read and edit scripts, take viewport screenshots it can see, play-test and read the Output window. Luau and script edits ask for your approval first (configurable).
- **Faster games.** On import, touching identical blocks are merged (fewer parts, same look). Parts are anchored, CanTouch is turned off, and tiny or neon parts skip shadows.

## HTML → Roblox UI translation

![The same shop UI as HTML (left) and translated into Roblox GUI objects (right)](docs/html-translation.png)

Ask Claude for a UI and it designs it in HTML/CSS (`create_ui_html`). You can also paste or open any `.html` file under **Assets → HTML**. The page is rendered by your browser at the design size (1280×720 by default) with scripts disabled. The translator then reads the browser's **computed** layout and styles, so flexbox, grid, margins, percentages and fonts are resolved exactly as the browser shows them.

| HTML / CSS | Roblox |
| --- | --- |
| `div` with background / gradient | `Frame` + `UIGradient` (angle and color stops kept) |
| `border-radius` | `UICorner` (pills and circles stay round when scaled) |
| uniform `border`, `outline` | `UIStroke` (the frame is inset so the outer edge matches) |
| single-side borders (`border-bottom`) | thin divider `Frame`s |
| `box-shadow` | soft layered shadow frames that move with the element |
| text (font, size, weight, color, alignment, `uppercase`, ellipsis, `text-shadow`) | `TextLabel` with matching `FontFace`, `TextTruncate` and `TextStroke` |
| `<b>`, `<i>`, `<u>`, `<s>`, `<span style="color/font-size">` | RichText |
| `<button>`, `<a href>`, `<select>` | `TextButton` |
| `<input>`, `<textarea>` (placeholder) | `TextBox` |
| `<img src="rbxassetid://…">`, `background: url(rbxassetid://…)` | `ImageLabel` (`object-fit` → `ScaleType`) |
| `overflow: hidden` / `auto` | `ClipsDescendants` / `ScrollingFrame` with the right canvas |
| `transform: rotate()`, `opacity` | `Rotation`, transparency |
| `::before` / `::after`, list bullets, `<progress>`, checkboxes | real instances |
| `id="BuyButton"` / `data-name` | the Instance name, so scripts can find it |

**Works on every screen.** Elements touching an edge or centred on screen are anchored there (AnchorPoint + scale), full-width bars use scale sizes, and groups move together. The translated ScreenGui gets an `AutoScaleRoot` with a `UIScale` and a 15-line LocalScript that scales the design proportionally to the player's screen. The preview has a **Design** preset plus phone, tablet and desktop presets, and a **Roblox result / Original HTML** toggle for comparing them.

**Not translated:** JavaScript, SVG, canvas, video, hover states and animations (the translation is a static snapshot), CSS filters and backdrop blur, and images that aren't Roblox assets. The page background is treated as the game world and isn't exported. Text is capped at 100px, Roblox's maximum. The translator tells you when it skips something.

Example pages to try are in `examples/html/`.

## Designed to use fewer tokens

| Technique | Effect |
| --- | --- |
| Compact JSON asset specs instead of Luau or HTML | Claude writes roughly 3–5× fewer output tokens per model or UI |
| Deterministic conversion and import on the server | Converting and importing costs no tokens |
| `edit_model` / `edit_ui` partial edits, `edit_ui_html` find/replace edits | Changing one part or one CSS rule doesn't re-send the whole asset |
| Auto-import reports inside the create/edit result | No extra tool round-trip to import |
| One long-lived Claude Code process per chat, static system prompt and tool list, `--exclude-dynamic-system-prompt-sections` | The prompt prefix stays byte-identical, so after the first turn prompt caching serves most input (91% of input tokens in a test run) |
| Optional 1-hour prompt cache | Coming back from testing in Studio doesn't re-pay the whole context |
| "Studio (lean)" tool mode | Built-in Claude Code tools are left out of the prompt unless you choose "Full Claude Code" |
| Short asset ids, terse tool results, Studio results capped | Keeps tool traffic small |

## Requirements

- **Node.js 20+**
- **Claude Code CLI**: `npm i -g @anthropic-ai/claude-code` (or the native installer)
- **Roblox Studio** (Windows or macOS) with the built-in MCP server enabled. The app also runs without Studio: you can still preview, chat and download `.rbxmx` files.

## Quick start

```bash
git clone https://github.com/PELOS932/RobloxStudio.git
cd RobloxStudio
npm install
npm start          # builds the web app and serves it at http://localhost:4317
```

Or double-click **`start.bat`** (Windows) or run **`./start.sh`** (macOS/Linux).

### 1. Connect your Claude account

Open **Settings → Claude account → Sign in with Claude subscription**. This runs Claude Code's own `claude auth login` flow and shows its sign-in link. Alternatively:

- run `claude auth login` once in a terminal, or
- put `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY` in a `.env` file (see `.env.example`).

Studio Forge never sees or stores your credentials. Claude Code handles authentication.

> Studio Forge is meant to run locally for **your own** use with your own Claude account. If you share it with other people, each person should use their own Claude Code login or API key.

### 2. Connect Roblox Studio

1. Open a place in Roblox Studio.
2. Open **Assistant → … → Manage MCP Servers** and turn on **Enable Studio as MCP server**.
3. In Studio Forge, open the **Studio** tab and press **Connect**.

Studio Forge finds Studio's `StudioMCP` executable automatically:
- Windows: `%LOCALAPPDATA%\Roblox\Versions\version-*\StudioMCP.exe`, falling back to `mcp.bat`
- macOS: `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`

If it isn't found, set the command in **Settings → Roblox Studio**. The older [studio-rust-mcp-server](https://github.com/Roblox/studio-rust-mcp-server) plugin also works: use the path to `rbx-studio-mcp` with the argument `--stdio`. With the old plugin, only Luau execution, console output and play-test are available.

## How it works

```
Browser (React + three.js)  ⇄  WebSocket/REST  ⇄  Studio Forge server (Node, localhost only)
                                                   │
                     claude -p --input-format stream-json --output-format stream-json
                     (one long-lived process per chat, your Claude account)
                                                   │  HTTP MCP: "forge" tools
                                                   ▼
                     Forge MCP server ── deterministic converters (spec → Luau / .rbxmx)
                                                   │  stdio MCP client
                                                   ▼
                                     Roblox Studio built-in MCP (StudioMCP → Studio)
```

- `src/shared`: asset specs (zod), converters (`to-luau.ts`, `to-rbxmx.ts`), the part-merging optimizer and the Luau that reads selections back out of Studio. Used by both server and browser, so previews and imports come from the same code.
- `src/server`: Claude Code process manager (`claude.ts`), Forge MCP tools (`forge-mcp.ts`), Studio MCP client (`studio-bridge.ts`), storage and HTTP/WebSocket.
- `src/web`: the UI, including the 3D viewer (`ModelViewer.tsx` and `lib/materials.ts`), the Roblox layout engine for UI previews (`lib/ui-layout.ts`) and the HTML translator (`lib/html-to-ui.ts`). Translation needs a real browser layout engine, so when Claude calls `create_ui_html` the server asks your open Studio Forge tab to do it.
- Your chats, assets and settings are stored in `data/` (gitignored).

### Asset formats (what Claude writes)

```jsonc
// Model: one entry per part; Y is up and units are studs
{ "name": "Lamp", "parts": [
  { "name": "Pole", "shape": "cylinder", "axis": "y", "size": [0.4, 6, 0.4], "pos": [0, 3, 0], "material": "Metal", "color": "#222428" },
  { "name": "Bulb", "shape": "ball", "size": [1, 1, 1], "pos": [0, 6.5, 0], "material": "Neon", "color": "#ffcc66",
    "light": { "type": "point", "range": 16 } } ] }

// UI: flat node list, children reference their parent by name
{ "name": "HUD", "nodes": [
  { "name": "Panel", "type": "Frame", "pos": [0, 16, 1, -16], "anchor": [0, 1], "size": [0, 260, 0, 64], "bg": "#15161c", "corner": 12 },
  { "name": "Coins", "parent": "Panel", "type": "TextLabel", "size": [1, 0, 1, 0], "text": "🪙 1,250", "font": "GothamBold", "textSize": 24 } ] }
```

The `examples/` folder has a 76-part cabin and a full item-shop UI (add them with **Assets → + JSON**), plus HTML pages in `examples/html/` (add them with **Assets → HTML**).

## Security

- The server listens on `127.0.0.1` only and rejects requests whose `Host` or `Origin` isn't the app itself. This blocks other websites and DNS rebinding.
- Claude Code reaches the Forge MCP endpoint with a random per-launch bearer token.
- Running Luau or editing scripts in Studio shows an Allow/Deny dialog unless you turn on auto-approve. In Full mode, risky Claude Code tools (shell commands, for example) use the same dialog.

## Development

```bash
npm run dev        # API server with reload + Vite dev server on http://localhost:5173
npm test           # converter tests + end-to-end test
npm run typecheck
```

The tests that execute generated Luau need [Lune](https://lune-org.github.io/docs) (`cargo install lune`) and are skipped without it.
- Every model, UI and script fixture is converted both ways: generated Luau is executed against Roblox's instance model in Lune, the `.rbxmx` export is deserialized, and the two resulting instance trees must match property for property.
- The end-to-end test starts the real server with a fake Claude Code CLI (`test/fake-claude.mjs`) and a mock Studio MCP server (`scripts/mock-studio-mcp.ts`, which runs Luau in Lune against a persistent place file).
- The HTML translation test drives a real Chromium (via `playwright-core`; set `CHROMIUM_PATH` if it isn't found, otherwise it's skipped). It translates `test/html/hud.html` through the `create_ui_html` tool, checks anchoring, names and styling, applies an `edit_ui_html` edit, and confirms the result builds identical instances via Luau and `.rbxmx`.
- You can point **Settings → Roblox Studio** at `npm run mock-studio` to try the app without Studio.

## Status and limitations

- Not yet tested against a live Roblox Studio. Conversions are verified with Lune (Roblox's reflection database). The Studio MCP integration follows the tool schemas of Studio's built-in server and was exercised against the mock server. Please report anything that behaves differently in real Studio.
- The UI preview uses Roblox's layout rules exactly. Roblox's own fonts (Gotham, Builder Sans) are proprietary, so the preview approximates them with Montserrat and Inter. Text widths can differ slightly, and HTML text is mapped to the closest Roblox font (Inter → Builder Sans, Montserrat → Gotham, and so on).
- HTML translation is a faithful snapshot of the rendered page, not a live layout. Lists built from HTML use absolute positions, not `UIListLayout`. Layered frames only approximate soft shadows.
- Image previews load `rbxassetid://` thumbnails through Roblox's public thumbnail API. Unknown ids show a placeholder.
- Parts only (no MeshParts or unions). Pulling a selection skips unsupported objects and lists them.
