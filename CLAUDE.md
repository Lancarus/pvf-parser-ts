# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Summary

A VS Code extension that opens, browses, and edits **PVF** (DNF/Dungeon & Fighter proprietary game pack) files. Also parses **NPK** (Neople Pack) and **IMG** (Neople Image) formats. Provides custom language support for DNF script file types.

## Build & Dev Commands

```powershell
# Compile TypeScript only (outputs to dist/)
npm run compile

# Watch mode during development
npm run watch

# Full build: compile + copy script tags + bundle webview
npm run build:all

# Production build (for packaging .vsix)
npm run vscode:prepublish

# Bundle webview React apps only
npm run build:webview

# Check icon file references
npm run check:icons
```

The webview React code (in `src/webview/`) is compiled by [esbuild](scripts/build-webview.mjs) separately from `tsc`. It bundles `reactDemo.tsx`, `aniPreview.tsx`, and `apcEditor.tsx` as IIFE bundles into `media/webview/`.

Exception: `src/webview/unpackExplorerClient.js` is the plain browser script for the unpack-directory WebviewView. It is loaded directly from `src/webview/` by `UnpackExplorerWebviewProvider`; keep it browser-safe and do not introduce CommonJS/ESM output (`exports`, `require`, imports) unless the view is explicitly moved into the esbuild pipeline.

## Architecture Overview

```
src/
├── extension.ts          # Entry point: registers FS provider, views,
│                         #   commands, language features, search, Codelens
├── pvf/                  # Core PVF pack engine
│   ├── model.ts          # PvfModel: the central data model (open/save/read/write)
│   ├── modelIO.ts        # Low-level PVF file I/O (header parsing, tree decryption)
│   ├── crypto.ts         # PvfCrypto: PVF's custom encryption (checksum-based XOR)
│   ├── pvfFile.ts        # Per-file data & metadata (decrypt, script detection)
│   ├── provider.ts       # TreeDataProvider for the packed PVF resource tree
│   ├── bookmarkProvider.ts # TreeDataProvider for the built-in bookmark view
│   ├── decorations.ts    # File status decorations (modified, etc.)
│   ├── treeComments.ts   # Built-in/user path comments keyed by PVF path/version
│   ├── unpackEnv.ts      # Resolves unpack explorer roots and legacy .env NPK/unpack settings
│   ├── unpackMetadata.ts # Lazy disk metadata/code/icon resolver for unpack tree
│   ├── unpackPreview.ts  # DNF-like typed preview parser/model for unpack files
│   ├── unpackPreviewPanel.ts # Rich preview WebviewPanel shown beside text editors
│   ├── unpackExplorerWebview.ts # WebviewViewProvider for disk unpack dir resources
│   ├── unpackExplorerProvider.ts # Legacy TreeDataProvider implementation; not the registered view
│   ├── diskTreeCommentDecorations.ts # Native Explorer hover tooltip for unpack paths
│   ├── scriptCompiler.ts / scriptDecompiler.ts  # Binary ↔ text script format
│   ├── aniCompiler.ts / binaryAni.ts            # .ani file compile/decompile
│   ├── lstDecompiler.ts  # Specialized .lst decompile (two-line-per-entry)
│   ├── stringTable.ts / stringView.ts           # stringtable.bin format
│   ├── metadata.ts       # [name]/[icon] tag parser for file display names
│   ├── searchQuickOpen.ts # Ctrl+Alt+P search: file path / @string ref / #item code
│   ├── resources/
│   │   ├── treeComments.json # Built-in path comments (moved to src/config/pvf)
│   │   └── bookmarks.json    # Cleaned built-in bookmark groups (moved to src/config/pvf)
│   └── services/         # Split-out search services, content providers, CodeLens
│       ├── fileSearchService.ts   # File name index builder & ranker
│       ├── codeSearchService.ts   # Item code search (from .lst mappings)
│       ├── stringRefSearchService.ts  # String reference lookup
│       ├── getPvfContent.ts       # Cross-pack content retrieval (RPC handler)
│       ├── getIconFrame.ts        # Icon frame extraction
│       └── stringTableCodeLens.ts # CodeLens for string references
├── npk/                  # NPK/IMG format parsing
│   ├── npkReader.ts      # NPK container parsing (XOR-encrypted file paths)
│   ├── imgReader.ts      # IMG sub-format: sprites, color tables, frames
│   ├── indexer.ts        # SQLite-based NPK file index for fast lookup
│   ├── colors.ts         # IMG color table handling
│   └── types.ts          # Album, ImgVersion, NpkEntryMeta types
├── commander/            # VS Code command registrations
│   ├── index.ts          # Aggregates all command registration modules
│   ├── openers.ts        # pvf.openFile, pvf.openFuzzyPath
│   ├── pvfFileOps.ts     # File/folder CRUD, clipboard, compare, pack open/save
│   ├── previewAni.ts     # ANI preview in webview panel
│   ├── aniEditor.ts      # ANI editor custom editor
│   ├── openNpk.ts        # NPK/IMG open & parse command
│   └── setNpkRoot.ts     # NPK root directory configuration
├── scriptLang/           # Custom language definitions
│   ├── index.ts          # Registers all 9 languages + formatters
│   ├── tagRegistry.ts    # Central tag registry, variant resolver, hover/completion docs
│   ├── act/, ani/, skl/, lst/, str/, equ/, ai/, aic/, key/
│   │   Each: language registration, formatter, TextMate grammar snippets
│   └── tagCommentEditor.ts # Markdown editor for human tag descriptions
└── webview/              # Webview apps and browser scripts
    ├── reactDemo.tsx     # Demo/test panel (ping/pong, counter)
    ├── aniPreview.tsx    # ANI animation preview (canvas-based)
    ├── apcEditor.tsx     # APC (character animation) visual editor
    ├── unpackExplorerClient.js # Plain JS client for pvfUnpackExplorerView
    └── theme.ts          # Shared FluentUI theme customization
```

## Key Architectural Patterns

### Virtual File System (`pvf:` scheme)
The extension implements `vscode.FileSystemProvider` for the `pvf:` URI scheme. All files inside a PVF pack appear as `pvf://path/to/file`. Reading/writing delegates to `PvfModel.readFileBytes()` / `writeFile()`. On write, metadata ([name]/[icon] tags) is re-parsed and the tree refreshes.

### PVF Sidebar Views
`package.json` contributes one activity bar container (`pvfExplorer`) with these views, in order:

- `pvfExplorerView`: the packed PVF resource tree backed by `PvfProvider`.
- `pvfUnpackExplorerView`: the real disk unpack directory Webview backed by `UnpackExplorerWebviewProvider`.
- `pvfBookmarkView`: the built-in bookmark tree backed by `BookmarkProvider`.

Do not add a separate "native resource tree" or alternate resource-manager view for unpack-directory metadata. The expected user-visible target for disk validation is `pvfUnpackExplorerView`.

### Disk Unpack Directory Comments
Path comments are stored in `src/config/pvf/treeComments.json` as `{ schemaVersion, version, globalJobComments, comments, versions }`. `globalJobComments` is a global job-name dictionary keyed by the current file/folder basename or file stem, such as `swordman`, `atgunner`, `creatormage`, and `knight`; it is not a path list. Keep direct job-name annotations out of path-specific `comments` and `versions` so `character/swordman`, `skill/swordman`, `equipment/character/swordman`, `passiveobject/character/swordman`, and files such as `atfighter.lay` all resolve to the same canonical job label. `PvfTreeCommentService` resolves per-version overrides first, then `globalJobComments` by full key or basename/stem, then version-gated built-in `comments`.

The disk unpack roots for `pvfUnpackExplorerView`, native Explorer decorations, and bookmark-on-disk resolution come from `pvf.unpackExplorer.roots` plus current VS Code workspace folders that contain `.pvfmanifest.json`. The extension development workspace `.env` is for local analysis/scripts and must not drive the host development window's unpack explorer. Legacy `.env` `UNPACK_DIR`/`PVF_UNPACK_DIR` remains available through `readConfiguredUnpackRoots()` for compatibility paths such as WebApi, but do not use it for the unpack explorer UI. NPK icon roots for the unpack tree come from `pvf.unpackExplorer.npkIcon.paths`, `.env` `NPK_DIR`/`PVF_NPK_DIR` from workspace folders, then legacy `pvf.npkRoot`.

Important Chinese note: 本仓库源码根目录的 `.env` 只是为了开发时方便 agent/脚本定位本机分析目录，例如 PVF、解包目录和 NPK 图包目录；它不是宿主开发窗口的用户配置。Extension Development Host 中的 **解包目录**、原生 Explorer 装饰、书签磁盘跳转等 UI 行为不应该受这个 `.env` 影响，必须使用 `pvf.unpackExplorer.roots` 或当前 VS Code 工作区中包含 `.pvfmanifest.json` 的真实解包根。

The custom `pvfUnpackExplorerView` uses `UnpackExplorerWebviewProvider` to show the real disk tree from the resolved unpack explorer roots. It renders rows in a Webview so file/folder names can remain in normal resource-tree text color while comments, parsed item names, rarity colors, item codes, and game icons are rendered as separate spans. Example row: `101000001.equ    古代遗骨的青铜剑[活动] <101000001>`.

`UnpackMetadataService` lazily reads encountered files and likely `.lst` files in the background, resolves string links from `stringtable.bin` and `.str`, parses `[name]`, `[set name]`, other `name`-like tags, `[icon]`, `rarity`, and quest `grade`, then decodes NPK/IMG frames into `globalStorage/unpack-icon-cache`. The decoded PNG is also read as a data URI and sent to the Webview; this avoids broken Webview image URLs for cached icons.

Keep directory expansion in `UnpackExplorerWebviewProvider` cheap: it should only `readdir`, map, and sort immediate children before posting rows to the Webview. Do not synchronously read `.equ` files, parse `.lst`, or decode NPK frames while handling a `children` message; large directories such as `equipment/character` and `equipment/character/partset` must remain responsive. Metadata resolution is queued with a higher concurrency than icon decoding, and row updates are batched before posting back to the client.

In the Webview row renderer:
- `row.name` is always normal file/folder label color.
- Path comments use description color.
- Parsed item/resource names use `pvf.rarity0Foreground` through `pvf.rarity7Foreground` when `rarity` is present; otherwise they use `pvf.unpackStringForeground`.
- `<code>` text uses `pvf.unpackNumberForeground`.
- Normal NPK item icons use the configured square size, default `16`.
- Quest tag icons from `Interface/Quest/quest_tag.img` are height-scaled and may remain rectangular so the label stays legible.

Native VS Code Explorer cannot append arbitrary full text after file names. Its `FileDecoration.badge` is only a very short marker and labels longer than about two characters may be clipped or omitted. Therefore `diskTreeCommentDecorations.ts` must not be used for full inline comments; it only provides native Explorer hover tooltips and the context-menu command path for disk files. Full visible comments belong in the custom `pvfUnpackExplorerView`.

When verifying hover/tooltip/floating-window behavior, test primarily against real disk files opened from an unpack explorer root, either a VS Code workspace folder containing `.pvfmanifest.json` or a path in `pvf.unpackExplorer.roots`. This covers disk path normalization, root resolution, `.lst` lookup from unpacked folders, native Explorer hover tooltip behavior, and the right-click `pvf.editTreeComment` command. Testing only `pvf:` virtual files does not validate the disk-unpack workflow.

#### DNF-like Unpack Previews
DNF-like previews for unpacked files are implemented only for the disk-unpack workflow, not editor token hover and not the packed `pvf:` resource tree. The main pieces are:

- `UnpackPreviewService` (`src/pvf/unpackPreview.ts`): host-side parser and typed preview model. It reads the unpacked file, parses PVF tags, resolves names/codes/icons through `UnpackMetadataService`, resolves item/skill references from `.lst` files, and returns one of `equipment`, `equipmentSet`, `stackable`, `shop`, `quest`, `skill`, `skillTree`, or `error`.
- `UnpackHoverPreviewPanel` (`src/pvf/unpackPreviewPanel.ts`): rich DNF-like WebviewPanel shown in `ViewColumn.Beside`. Keep this as a single preview frame; the user explicitly rejected the two-frame split layout.
- `UnpackExplorerWebviewProvider` (`src/pvf/unpackExplorerWebview.ts`): wires custom unpack-view messages, native Explorer active-editor detection, open-with-preview behavior, save refresh, and conversion to plain native tooltip text.
- `src/webview/unpackExplorerClient.js`: plain browser client for row hover timing, native tooltip text, inline fallback, context menu `显示预览`, and opening files with preview.

Supported preview triggers:

- Custom `pvfUnpackExplorerView` hover requests send `{ type: 'preview', id, requestId }`.
- Custom `pvfUnpackExplorerView` open/right-click preview sends `showPreview` or opens the file and then shows the panel.
- Native VS Code Explorer opening a real file under configured unpack roots opens/refreshes the side preview when `pvf.unpackExplorer.preview.openWithTextEditor` is true.
- Saving the currently previewed disk file invalidates that preview cache, refreshes the row metadata, and re-renders the side preview.

Preview location is controlled by `pvf.unpackExplorer.hoverPreview.location`:

- `nativeTooltip` is the default. It sets the row `title` to a plain-text summary so Chromium/VS Code can draw a tooltip outside the sidebar bounds. Native tooltip cannot render colors or images.
- `editorPanel` opens/reuses the rich side panel.
- `inline` is the old in-Webview floating tooltip and can be clipped by the sidebar Webview boundary.

Keep native hover fast. `UnpackPreviewService.resolvePreview(input)` defaults to not waiting for NPK icon decoding. Rich panel rendering must call `resolvePreview(input, { resolveIcon: true })`; this prevents save-triggered refreshes from rendering a freshly rebuilt metadata object before `iconDataUri` is available. The preview cache stores whether icons have settled, so a fast native-tooltip cache is not reused as a final rich-panel preview.

Do not make unsupported `.co`/`.etc` files display "no preview" on hover in the custom view; preserve normal path tooltips unless the file is a real preview candidate. Skill-tree detection is path-based for `clientonly/skilltree/*_sp.co`, `*_tp.co`, `clientonly/skillshoptreespindex.co`, `clientonly/skillshoptreetpindex.co`, `etc/pvpskilltree/*.etc`, and content-based for files containing `[character job]`, `[skill info]`, and `[icon pos]`.

Skill and animation related-resource discovery must not depend only on `.nut` scripts or static `[skill preloading image]` data. `UnpackPreviewService` traces `.skl`, `.act`, `.obj`, `.ani`, and `.als` chains and inserts IMG references found in ANI `[IMAGE]` blocks as logical related resources even when the `.img` file is not present in the unpacked tree. `parseAniText` must keep the image path and frame index separate, including inline syntax such as `` `Character/Fighter/.../fm_body%04d.img` 91 ``, path-only lines followed by numeric frame lines, frame-only lines inheriting the last image path, and empty image markers such as `` `` 3 ``.

`scripts/generate-skill-animation-resources.cjs` should mirror that runtime discovery model when refreshing the built-in skill animation resource map: follow `.act/.obj` animation fields, `.als` `[use animation]` links, and `.ani` image blocks, then collect IMG paths from the resulting animation chain. Do not regenerate the large JSON resource map just because parser code changed; regenerate it only when the source PVF data or shipped resource map intentionally needs updating.

### Built-In Bookmarks
Built-in bookmarks are stored in `src/config/pvf/bookmarks.json` as a cleaned tree:

```json
{
  "schemaVersion": 1,
  "roots": [
    { "label": "我的书签", "children": [{ "label": "商城", "path": "etc/newcashshop.etc" }] }
  ]
}
```

The source import was `temporary file/BookMarkGroup.json`, but that directory is ignored by Git and should not be treated as runtime data. The committed resource intentionally drops legacy fields such as `FilePath`, `IsFile`, `Sort`, and `CutStatus`; `Sort` is applied before writing the final array order.

`BookmarkProvider` exposes folders and file bookmarks in `pvfBookmarkView`. It loads built-in bookmarks on first use, then persists user edits to `context.globalStorageUri/bookmarks.json`. Register the view with `vscode.window.createTreeView(..., { dragAndDropController: bookmarkTree })`, not `registerTreeDataProvider`, otherwise drag/drop reordering will not work. File bookmarks use `TreeItem.resourceUri = pvf:/...` for PVF-style decorations and call these commands:

- `pvf.openBookmark`: first tries a real disk file under configured unpack roots, then falls back to `pvf.openFuzzyPath`.
- `pvf.openBookmarkOnDisk`: opens only the matching disk file from unpack explorer roots.
- `pvf.openBookmarkInPack`: opens only the current PVF pack entry.
- `pvf.copyBookmarkPath`: copies the normalized PVF path.
- `pvf.createBookmarkFolder`, `pvf.renameBookmark`, `pvf.deleteBookmark`, `pvf.resetBookmarks`: edit the persisted bookmark tree.
- `pvf.addPvfToBookmarks`: adds a `PvfFileEntry` from `pvfExplorerView`; folder entries create bookmark folders.
- `pvf.addUnpackToBookmarks`: adds an `UnpackExplorerEntry` from `pvfUnpackExplorerView`; folder entries create bookmark folders.

Disk lookup uses `readUnpackExplorerRoots()` and a case-insensitive path walk so bookmarks with mixed-case legacy PVF paths can still resolve on Windows unpack directories. Keep bookmark paths normalized with `/` separators and no leading slash.

### Core Data Model (`PvfModel`)
- Holds a `Map<string, PvfFile>` (key = normalized path), plus caches for children, encodings, display names, and codes
- `open()` decrypts the PVF header/file tree, or opens the newer `nkpi` archive when the user selects that format, then builds LST indices and auto-detects encoding from `stringtable.bin`
- `save()` encrypts all changed files and writes back the PVF; directory repack compares the output MD5 against the source/template MD5 recorded in `.pvfmanifest.json` and reports the result
- `readFileBytes()` returns different representations based on file type:
  - Script files (magic `0xd0b0`) → decompiled to text
  - `nkpi` type-1 script files → decoded to editable text, with `.lst` entries and `.skl` `[level info]` blocks split across readable lines
  - `.nut` files → decoded as cp949 text
  - `stringtable.bin` → rendered as human-readable table
  - Everything else → raw bytes

For directory unpack/repack, `.pvfmanifest.json` records `archiveFormat`, `sourcePvfPath`, `sourcePvfMd5`, encoding, conversion mode, and archive-specific metadata. New `nkpi` repack relies on the original/template archive metadata for chunking and header details. Whole-file MD5 equality is a diagnostic result, not a guarantee, because zlib recompression can produce byte-different chunks even when decoded file content round-trips correctly.

### Encoding Model
Files are decoded based on `pvf.encodingMode` (AUTO/KR/TW/CN/JP/UTF8). AUTO mode detects encoding from stringtable.bin by scoring printable-character ratios across candidate codecs. `.nut` files always use cp949 independent of the mode setting. Decoding uses `iconv-lite`.

### PVF Encryption
Custom XOR-based encryption with a CRC32-like checksum dictionary (`PvfCrypto`). Key operations:
- `decrypt(source, len, checksum)` — XOR with key `0x81A79011` and CRC32 checksum, then rotate right 6
- `encrypt(source, len, checksum)` — rotate left 6, XOR with checksum and key
- Filename checksums use `createBuffKey()` with a 256-entry CRC32 table

### NPK/IMG Format
NPK files are containers with XOR-encrypted file paths (key derived from "puchikon@neople dungeon and fighter"). IMG is a sub-format containing sprite albums with indexed color tables and compressed/uncompressed frames.

### Search System (Ctrl+Alt+P)
Three search modes triggered by prefix:
- Default: fuzzy file path search (ranks by path segments)
- `@query`: search string references across all files (binary script `flag=5/7/10` fields)
- `#query`: search item codes (from `.lst` file code→name mappings)

### Webview Apps
React + FluentUI v9, bundled by esbuild as IIFE. Communication uses VS Code's `postMessage` + an RPC-style protocol (`{type:'rpc', id, method, params}`). The APC editor maintains a live sync between text document changes and the webview.

### Script Languages
Each language (`act`, `ani`, `skl`, `lst`, `str`, `equ`, `ai`, `aic`, `key`) has:
- A TextMate grammar in `src/config/syntaxes/` (`.tmLanguage.json`)
- A language configuration in the scriptLang subdirectories
- Optional: a formatter, hover provider, completion provider
- Tag definitions in `src/config/scriptLang/scriptTags/`

Tag metadata is JSON-driven. Runtime code reads `src/config/scriptLang/scriptTags/<short>.json` or the copied `dist/config/scriptLang/scriptTags/<short>.json`, plus `global.json`. `npm run compile` triggers `scripts/copy-script-tags.cjs`, so keep source-of-truth edits under `src/config/scriptLang/scriptTags/`; `dist/` is generated.

`ScriptTagInfo` deliberately separates human/community comments from official PVF sample comments:

- `description` and `authors` store human/community comments.
- `officialDescription` and `officialAuthors` store official PVF sample snippets. The tag comment editor provides a second editable Markdown field for `officialDescription`; keep `title` shared and do not introduce a separate official title.
- Hover and completion documentation should append `officialDescription` content after `description` without extra "官方注释" or "来源官方PVF" labels. Do not append official text into `description`, and do not add `官方PVF` to `authors`. Official source attribution belongs in `officialAuthors`.

Same-extension files can have different tag semantics. Variant configs live in `src/config/scriptLang/scriptTags/variants/<short>/<variant>.json` and use the same `{ "tags": [...] }` format. `src/config/scriptLang/scriptTags/variantRules.json` declares path/content rules. `tagRegistry.ts` resolves variants per document, then merges tags as:

1. Base `<short>.json`
2. Matched variant JSON, appending descriptions/official descriptions for same-name tags
3. `global.json` fallback only for missing tag names

Current variant families are:

- `.equ`: `avatar`, `creature`, `equipment`, `piece-set`
- `.stk`: `stackable`, `booster`, `legacy`, `monster-card`, `pandora`, `recipe`, `stackable-legacy`, `throwitem`
- `.etc`: `cashshop`, `compoundavatar`, `disjoint`, `questparameter`, `tutorialtip`, `ultimateskillcutscene`

When editing tag comments from hover/quick fix, pass the resolved `variant` argument to `pvf.editScriptTagComment`; otherwise edits to an avatar/equipment-specific tag may be saved to the base file.

Official PVF comments are imported with:

```powershell
node scripts/import-official-tag-comments.cjs --dry-run
node scripts/import-official-tag-comments.cjs
```

The default source is `temporary file/官方pvf注释/翻译后`, which is ignored by Git and is not runtime data. The importer trusts parseable official sample comments and writes the related PVF snippet to `officialDescription`, not just the isolated comment text. It must capture same-line comments, comments inside closable blocks, and contiguous continuation comment lines after scalar tags, while ignoring bracket-like values inside backticks when identifying tag names. It also migrates legacy `#### 官方示例` sections out of `description`. After a successful sync, running the dry-run again should show `updated = 0`.

Validation checklist after changing tag configs or the importer:

```powershell
node scripts/import-official-tag-comments.cjs --dry-run
npm run compile
git diff --check
```
