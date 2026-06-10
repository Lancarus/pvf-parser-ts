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

## Architecture Overview

```
src/
├── extension.ts          # Entry point: registers FS provider, tree view,
│                         #   commands, language features, search, Codelens
├── pvf/                  # Core PVF pack engine
│   ├── model.ts          # PvfModel: the central data model (open/save/read/write)
│   ├── modelIO.ts        # Low-level PVF file I/O (header parsing, tree decryption)
│   ├── crypto.ts         # PvfCrypto: PVF's custom encryption (checksum-based XOR)
│   ├── pvfFile.ts        # Per-file data & metadata (decrypt, script detection)
│   ├── provider.ts       # TreeDataProvider for the "PVF Explorer" sidebar
│   ├── decorations.ts    # File status decorations (modified, etc.)
│   ├── treeComments.ts   # Built-in/user path comments keyed by PVF path/version
│   ├── unpackEnv.ts      # Reads .env UNPACK_DIR/PVF_UNPACK_DIR for disk unpack roots
│   ├── unpackExplorerProvider.ts # TreeDataProvider for disk unpack dir comments
│   ├── diskTreeCommentDecorations.ts # Native Explorer hover tooltip for unpack paths
│   ├── scriptCompiler.ts / scriptDecompiler.ts  # Binary ↔ text script format
│   ├── aniCompiler.ts / binaryAni.ts            # .ani file compile/decompile
│   ├── lstDecompiler.ts  # Specialized .lst decompile (two-line-per-entry)
│   ├── stringTable.ts / stringView.ts           # stringtable.bin format
│   ├── metadata.ts       # [name]/[icon] tag parser for file display names
│   ├── searchQuickOpen.ts # Ctrl+Alt+P search: file path / @string ref / #item code
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
│   ├── tagRegistry.ts    # Central tag definitions shared across languages
│   ├── act/, ani/, skl/, lst/, str/, equ/, ai/, aic/, key/
│   │   Each: language registration, formatter, TextMate grammar snippets
│   └── scriptTags/       # Tag metadata (hover info, completion items)
│       ├── actTags.ts, aniTags.ts, sklTags.ts, ...
│       └── ... (tag files for each language)
└── webview/              # React apps rendered in webview panels
    ├── reactDemo.tsx     # Demo/test panel (ping/pong, counter)
    ├── aniPreview.tsx    # ANI animation preview (canvas-based)
    ├── apcEditor.tsx     # APC (character animation) visual editor
    └── theme.ts          # Shared FluentUI theme customization
```

## Key Architectural Patterns

### Virtual File System (`pvf:` scheme)
The extension implements `vscode.FileSystemProvider` for the `pvf:` URI scheme. All files inside a PVF pack appear as `pvf://path/to/file`. Reading/writing delegates to `PvfModel.readFileBytes()` / `writeFile()`. On write, metadata ([name]/[icon] tags) is re-parsed and the tree refreshes.

### Disk Unpack Directory Comments
Path comments are stored in `src/pvf/resources/treeComments.json` as `{ schemaVersion, version, comments }`, with user overrides persisted under VS Code `globalStorage` by PVF `fileVersion`. `PvfTreeCommentService` merges built-in comments with per-version user edits.

The disk unpack root is configured through `.env` (`UNPACK_DIR`, `PVF_UNPACK_DIR`, or `pvf_unpack_dir`) and resolved by `unpackEnv.ts`. The custom `pvfUnpackExplorerView` uses `UnpackExplorerProvider` to show the real disk tree from `UNPACK_DIR`; file/folder names remain in normal tree text color, while path comments are placed in `TreeItem.description` so VS Code renders them in description/comment color, e.g. `equipment    (装备)`.

Native VS Code Explorer cannot append arbitrary full text after file names. Its `FileDecoration.badge` is only a very short marker and labels longer than about two characters may be clipped or omitted. Therefore `diskTreeCommentDecorations.ts` must not be used for full inline comments; it only provides native Explorer hover tooltips and the context-menu command path for disk files. Full visible comments belong in the custom `pvfUnpackExplorerView`.

When verifying hover/tooltip/floating-window behavior, test primarily against real disk files opened from the configured `UNPACK_DIR`. This covers disk path normalization, `.env` root resolution, `.lst` lookup from unpacked folders, native Explorer hover tooltip behavior, and the right-click `pvf.editTreeComment` command. Testing only `pvf:` virtual files does not validate the disk-unpack workflow.

### Core Data Model (`PvfModel`)
- Holds a `Map<string, PvfFile>` (key = normalized path), plus caches for children, encodings, display names, and codes
- `open()` decrypts the PVF header/file tree, then builds LST indices and auto-detects encoding from `stringtable.bin`
- `save()` encrypts all changed files and writes back the PVF
- `readFileBytes()` returns different representations based on file type:
  - Script files (magic `0xd0b0`) → decompiled to text
  - `.nut` files → decoded as cp949 text
  - `stringtable.bin` → rendered as human-readable table
  - Everything else → raw bytes

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
- A TextMate grammar in `syntaxes/` (`.tmLanguage.json`)
- A language configuration in the scriptLang subdirectories
- Optional: a formatter, hover provider, completion provider
- Tag definitions in `scriptTags/` subdirectory
