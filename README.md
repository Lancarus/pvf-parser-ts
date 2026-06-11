# PVF Code (pvf-parser-ts)

在 VS Code 中打开、解封 **PVF** 封包文件到本地并支持vscode资源管理器浏览、修改注释，以期后续agent修改pvf支持。

同时支持解析 **NPK**（Neople Pack）和 **IMG**（Neople Image）格式，并为游戏的多种脚本文件类型提供自定义语言支持。

## 功能特性

- **PVF 资源浏览器** — 侧边栏树形视图，可浏览 PVF 包内文件，显示路径注释、脚本别名和物品代码。支持新建、删除、重命名、剪切/复制/粘贴文件和文件夹。
- **虚拟文件系统** — 将包内文件以常规编辑器标签页（`pvf://` 协议）打开。编辑会被跟踪，可保存回封包。
- **目录解封 / 重新封装** — 可将 PVF 解封到普通目录，脚本、`stringtable.bin`、`.ani` 和已知文本文件会写成 UTF-8 文本，二进制资源原样保留；目录可再封装回 PVF。
- **原地保存 / 另存为** — 支持直接保存或另存为新 PVF 文件。
- **脚本语言支持** — 语法高亮、自动补全、标签悬停提示、物品/怪物/任务等数字代码悬停提示和格式化，覆盖以下文件类型：
  - `.act`（动作）、`.ani`（动画）、`.skl`（技能）
  - `.lst`（列表）、`.str`（结构）、`.equ`（装备）
  - `.ai`（AI）、`.aic`（AI 编译）、`.key`（键值）
- **ANI 动画预览** — 在 Webview 面板中基于 Canvas 预览 `.ani` 动画文件。
- **APC 编辑器** — `.aic` 文件的可视化角色动画编辑器，与源文档实时同步。
- **NPK / IMG 解析** — 打开 NPK 容器并查看 IMG 精灵表（含索引颜色表）。
- **统一搜索**（`Ctrl+Alt+P`）— 三种搜索模式：
  - 默认：模糊文件名路径搜索
  - `@` 前缀：搜索字符串引用（覆盖所有文件）
  - `#` 前缀：搜索物品代码（来自 `.lst` 映射）
- **差异对比** — 在资源树中选择两个文件进行左右对比。
- **String Table 内联提示** — 在 `stringtable.bin` 视图中显示字符串引用的 CodeLens。
- **文件引用查找** — 右键文件查找包内所有引用该文件的位置。
- **元数据解析** — 自动解析 `[name]` 和 `[icon]` 标签，用于显示文件别名和自定义图标。
- **多编码支持** — 支持韩文（cp949）、繁体中文（big5）、简体中文（gb18030）、日文（shift_jis）和 UTF8，并可自动检测。
- **解封目录编辑优化** — 解封后的磁盘脚本文件会自动切换到对应 `pvf-*` 语言模式，使用真实制表符缩进，并通过 VS Code 原生空白字符渲染显示制表符箭头。
- **解包目录资源视图** — 从 `.env` 的 `UNPACK_DIR` 读取磁盘解包目录，在 PVF 侧边栏的 **解包目录** Webview 中显示路径注释、脚本真实名称、物品代码和 NPK/任务图标，例如 `101000001.equ 古代遗骨的青铜剑[活动] <101000001>`。文件名保持默认颜色，解析出的名称按 `rarity` 或字符串颜色显示，代码使用数字颜色显示。
- **DNF-like 解包预览** — 悬停或打开解包目录中的装备、套装、道具、商店、任务、技能和技能树文件时，可显示仿 DNF 游戏内层级的预览。默认悬停使用 VS Code 原生 tooltip 显示纯文本摘要；打开文件或右键显示预览会在编辑器旁打开深色富预览面板，支持品质色标题、蓝色效果文本、任务/物品图标和保存后刷新。
- **可编辑书签视图** — PVF 侧边栏的 **书签** 视图内置常用资源路径，可新建/重命名/删除文件夹和书签、拖拽移动目录；可从 PVF 资源树或解包目录右键添加文件/目录到书签。

## 环境要求

- VS Code 1.100.0 或更高版本
- 在设置中配置 `pvf.npkRoot` 指向游戏目录下的 `ImagePacks2`（可选，NPK 索引功能需要）

## 插件配置

| 设置项 | 默认值 | 说明 |
|---------|---------|------|
| `pvf.npkRoot` | `""` | NPK 文件根目录（通常为游戏目录下的 `ImagePacks2`） |
| `pvf.unpackExplorer.npkIcon.enabled` | `true` | **解包目录** 是否显示从 NPK/IMG 解析出的真实图标 |
| `pvf.unpackExplorer.npkIcon.paths` | `[]` | **解包目录** 使用的 NPK 图包目录列表，可填写 `ImagePacks2` 或其上级目录；为空时回退到 `.env` 的 `NPK_DIR` 和 `pvf.npkRoot` |
| `pvf.unpackExplorer.npkIcon.cache.enabled` | `true` | 是否复用解码后的解包目录 PNG 图标缓存 |
| `pvf.unpackExplorer.npkIcon.size` | `16` | **解包目录** 行内图标基准尺寸；任务标签按高度等比显示为矩形 |
| `pvf.unpackExplorer.metadata.showComment` | `true` | **解包目录** 是否显示路径注释 |
| `pvf.unpackExplorer.metadata.showItemName` | `true` | **解包目录** 是否显示脚本内解析出的真实名称 |
| `pvf.unpackExplorer.metadata.showItemCode` | `true` | **解包目录** 是否显示 `.lst` 或文件名解析出的代码 |
| `pvf.unpackExplorer.metadata.itemCodeFormat` | `"<{code}>"` | **解包目录** 代码显示格式，使用 `{code}` 作为数字占位符 |
| `pvf.unpackExplorer.hoverPreview.enabled` | `true` | **解包目录** 是否启用装备、套装、道具、商店、任务、技能和技能树文件的悬停预览 |
| `pvf.unpackExplorer.hoverPreview.delayMs` | `350` | **解包目录** 悬停预览请求延迟，单位毫秒 |
| `pvf.unpackExplorer.hoverPreview.location` | `nativeTooltip` | 悬停预览位置：`nativeTooltip` 为原生纯文本 tooltip，`editorPanel` 为编辑器旁富预览面板，`inline` 为 Webview 内浮窗 |
| `pvf.unpackExplorer.preview.openWithTextEditor` | `true` | 从 **解包目录** 或 VS Code 原生 Explorer 打开可预览解包文件时，是否同时打开/刷新右侧富预览面板 |
| `pvf.encodingMode` | `AUTO` | 文本编码：`AUTO`（自动检测）、`KR`（cp949）、`TW`（big5）、`CN`（gb18030）、`JP`（shift_jis）、`UTF8` |
| `pvf.showScriptDisplayName` | `true` | 在资源树中文件后显示脚本别名（来自 `.lst` 解析） |
| `pvf.showScriptCode` | `true` | 在资源树中文件后显示物品代码（来自 `.lst` 解析） |
| `pvf.metadata.excludeExtensions` | （见默认值） | 扫描 `[name]` 标签时要排除的扩展名 |
| `pvf.script.convertStringLink` | `true` | 自动将字符串链接 `<id::name\`text\`>` 转换为 `text` |
| `pvf.closeVirtualEditorsOnStartup` | `true` | 启动时自动关闭上次遗留的 `pvf:` 虚拟文件标签页 |

## 目录工作流

1. 在 PVF 面板打开封包后执行 **解封PVF到目录**，选择目标目录。
2. 插件会写出完整目录结构和 `.pvfmanifest.json`。不要删除该 manifest，它记录原始编码、文件类型、繁简转换模式和 PVF 头信息，重新封装时用于区分脚本、二进制 ANI、文本和普通二进制。
3. 在普通工作区中编辑解封后的文件。可编辑文本统一为 UTF-8，默认会将繁体文本转换为简体；重新封装时会根据 manifest 自动转回繁体再写入 PVF。二进制文件不要用文本编辑器改写。
4. 执行 **将目录封装为PVF**，选择解封目录并指定输出 `.pvf` 文件。

解封和封装均采用受控并发处理，适合几十万小文件的 PVF 包；实际速度主要受磁盘随机写入性能、杀毒软件扫描和文本反编译/编译比例影响。

### PVF 侧边栏视图

PVF 活动栏中按顺序提供这些视图：

- **PVF 资源树**：浏览当前打开的 PVF 封包内容。
- **解包目录**：读取 `.env` 中的 `UNPACK_DIR` / `PVF_UNPACK_DIR` / `pvf_unpack_dir`，展示真实磁盘目录，并通过 Webview 行渲染异步补齐路径注释、脚本名称、物品代码和 NPK/任务图标。
- **书签**：内置常用 PVF 路径分组，并支持用户自定义整理，用于快速跳转到解包目录或当前 PVF 封包中的文件。

### 解包目录注释

项目根目录的 `.env` 可配置解包目录位置：

```env
# 解包文件所在位置
UNPACK_DIR=G:\dnfsifu\develop\pvf-jie\
```

插件会读取 `UNPACK_DIR`，并在 PVF 活动栏里的 **解包目录** 视图展示该目录的真实磁盘结构。命中内置路径注释或用户自定义注释时，节点会显示为文件/文件夹名加说明文字，例如：

```text
equipment    (装备)
creature     (NPC卖的宠物)
```

其中 `equipment`、`creature` 使用正常文件名颜色，括号里的注释使用 VS Code 的说明文字颜色。视图标题栏的刷新按钮会重新读取 `.env`、磁盘目录和解包目录元数据缓存。

对于 `.equ`、`.qst` 等脚本文件，**解包目录** 会先立即显示文件名，再在后台解析脚本、字符串链接和 `.lst` 映射，补齐脚本内 `[name]` / `[set name]` / 其它带 `name` 的字段、物品代码、`rarity`、任务 `grade` 和图标。例如：

```text
[NPK icon] 101000001.equ  古代遗骨的青铜剑[活动]  <101000001>
```

文件名保持 VS Code 默认资源树颜色；解析出的真实名称会按 `rarity` 对齐 DNF 游戏配色（`0` 普通、`1` 高级、`2` 稀有、`3` 神器、`4` 史诗、`5` 勇者、`6` 传说、`7` 神话），没有 `rarity` 时使用编辑器字符串颜色；后面的 `<code>` 使用数字颜色。颜色可通过 `pvf.unpackStringForeground`、`pvf.unpackNumberForeground` 和 `pvf.rarity0Foreground` 到 `pvf.rarity7Foreground` 覆盖。

图标路径优先读取设置 `pvf.unpackExplorer.npkIcon.paths`，为空时读取 `.env` 的 `NPK_DIR` / `PVF_NPK_DIR`，再回退到旧设置 `pvf.npkRoot`。`[icon]` 会解析到对应 IMG 帧并以 PNG data URI 发给 Webview；普通装备图标按 `pvf.unpackExplorer.npkIcon.size` 显示为正方形，任务图标根据 `grade` 或任务类型查找 `Interface/Quest/quest_tag.img`，并按高度等比显示为矩形，避免被压成看不清的正方块。

解包目录 Webview 的目录展开只做当前层级的 `readdir`、排序和渲染，不会在展开大目录时同步解析所有脚本或解码所有 NPK 图标；脚本元数据和图标会限流异步补齐，适合 `equipment/character`、`equipment/character/partset` 这类大目录。

### 解包目录 DNF-like 预览

**解包目录** 的预览支持七类模板：装备 `.equ`、套装 `.equ`、道具 `.stk`、商店 `.shp`、任务 `.qst`、技能 `.skl` 和技能树配置。技能树会匹配 `clientonly/skilltree/*_sp.co`、`clientonly/skilltree/*_tp.co`、`clientonly/skillshoptreespindex.co`、`clientonly/skillshoptreetpindex.co`、`etc/pvpskilltree/*.etc`，以及内容包含 `[character job]`、`[skill info]` 和 `[icon pos]` 的 `.co` / `.etc` 文件。

默认设置 `pvf.unpackExplorer.hoverPreview.location = nativeTooltip` 会在鼠标悬停时更新行的原生 tooltip。原生 tooltip 可以越过侧边栏边界，但只能显示纯文本，因此它用于快速摘要：名称、代码、路径、字段、说明和条目列表。它不会渲染颜色或图片，也不会为了悬停而等待 NPK 图标解码。

富预览使用编辑器旁的 Webview 面板显示，打开方式包括：

- 在 **解包目录** 左键打开可预览文件。
- 在 **解包目录** 右键选择 **显示预览**。
- 在 VS Code 原生 Explorer 中打开位于已配置解包根目录下的可预览文件。
- 将 `pvf.unpackExplorer.hoverPreview.location` 改为 `editorPanel` 后悬停触发。

当 `pvf.unpackExplorer.preview.openWithTextEditor` 为 `true` 时，打开可预览文件会同时显示原始文本编辑器和右侧 DNF-like 富预览面板。富预览会按类型分别渲染，不把道具、商店、任务或技能强行套用装备/套装模板；技能树预览会显示类型、职业、节点列表和基于 `[icon pos]` 的简化 mini-map。

保存当前预览文件后，插件会失效该文件的预览缓存并刷新右侧面板。面板刷新会等待当前文件图标解析完成或失败后再渲染，所以已配置 NPK 根目录时，保存后的装备、道具、任务和技能预览仍应保留图标；未配置 NPK 根目录时文本预览仍可用，只是图标区域为空。

原生 VS Code Explorer 不能通过扩展 API 在文件名后追加完整说明文字，且 `FileDecoration.badge` 超过 2 个字符会被 VS Code 直接截断或不显示。因此插件不会在原生 Explorer 中显示注释 badge；原生 Explorer 只保留完整注释的 hover tooltip 和右键菜单 **编辑路径注释**。需要完整行内注释时，请使用 PVF 侧边栏的 **解包目录** 视图。

路径注释来自内置文件 `src/pvf/resources/treeComments.json`。用户通过 **编辑路径注释** 保存的覆盖项会直接写回这个内置路径注释文件，并按 PVF `fileVersion` 写入 `versions` 覆盖段；旧版本曾保存到 VS Code `globalStorage/tree-comments.user.json` 的覆盖项会在首次加载时迁移进内置文件。若解包目录里存在 `.pvfmanifest.json`，插件会读取其中的 `fileVersion`；没有 manifest 时使用通用版本 `0`。

### 书签视图

**书签** 视图首次加载时使用插件内置的 `src/pvf/resources/bookmarks.json`，按“我的书签”分组保存常见 PVF 资源路径，例如商城、深渊、装备列表、技能树和各类系统参数文件。原始 `BookMarkGroup.json` 中的旧字段已经清洗掉，仅保留视图需要的 `label`、`path` 和 `children`。

用户修改后的书签会保存到 VS Code `globalStorage/bookmarks.json`，不会改写插件内置资源。可以在书签视图标题栏新建书签文件夹或重置为内置默认；也可以在书签项右键重命名、删除，或把书签/文件夹拖到其它目录下改变分组。

在 **PVF 资源浏览器** 或 **解包目录** 视图中右键文件可选择 **添加到书签**；右键目录时会在选定书签目录下创建同名书签文件夹，便于把常用路径按业务重新分组。

单击书签文件时，插件会先根据 `.env` 解析解包目录并尝试打开真实磁盘文件，例如：

```text
UNPACK_DIR=G:\dnfsifu\develop\pvf-jie\
书签路径=etc/newcashshop.etc
实际打开=G:\dnfsifu\develop\pvf-jie\etc\newcashshop.etc
```

如果解包目录未配置、目录中没有对应文件，或只想查看封包内容，可通过右键菜单选择：

- **打开书签**：优先打开解包目录文件，找不到则回退到当前 PVF 封包。
- **在 PVF 中打开**：直接打开 `pvf:` 虚拟文件。
- **在解包目录中打开**：只查找并打开磁盘解包目录文件。
- **复制书签路径**：复制规范化后的 PVF 路径。

### 解封目录中的脚本编辑

解封后的 `.equ`、`.skl`、`.act`、`.dgn`、`.map` 等脚本文件是普通磁盘文件，可以直接被 VS Code、agent 和其他文本工具读取。插件会在打开这些文件时按扩展名自动切换到对应的 `pvf-*` 语言模式，例如 `.equ` 会切到 `pvf-equ`。

脚本文件中的列分隔会保留为真实的制表符 `\t`，不会把制表符写成箭头或空格。为了方便辨认列结构，插件给 PVF 语言默认启用 VS Code 原生 `editor.renderWhitespace: boundary`，并将 `editor.tabSize` 设为 `4`、`editor.insertSpaces` 设为 `false`。你在编辑器里看到的箭头只是空白字符渲染效果，保存和重新封装时仍然是原始制表符。

如果打开解封目录后没有看到制表符箭头，先确认右下角语言模式是 `pvf-equ`、`pvf-skl` 等 PVF 语言；也可以手动切换语言模式或重新打开文件。插件会为原生空白字符设置一个略亮的 `editorWhitespace.foreground` 默认颜色，便于在深色背景下看清，但不会使用自绘装饰覆盖文本。

默认的简繁转换适合“解包目录给 agent/编辑器直接读”的工作流：解封时将繁体脚本文本写成简体，便于理解和修改；重新封装时根据 `.pvfmanifest.json` 把这些文本转回繁体，再按 PVF 格式写入封包。关闭 `pvf.unpack.chineseConversion` 后，解封文本会尽量保持原文字形，不再执行繁简互转。

悬停提示、悬浮窗和原生资源管理器 hover 效果主要在打开磁盘解包后的真实文件时验证。也就是说，应在 VS Code 中打开 `UNPACK_DIR` 指向的目录，再从原生 Explorer 或 **解包目录** 视图打开 `.equ`、`.skl`、`.act` 等磁盘文件进行测试；仅查看 PVF 包内 `pvf:` 虚拟文件或未配置 `UNPACK_DIR` 的目录，不能完整覆盖磁盘路径解析、`.lst` 查找、Explorer hover tooltip 和右键编辑入口。

### 数字代码悬停

在已支持的脚本位置悬停数字代码时，插件会根据 `src/scriptLang/itemCodeHoverConfig.json` 中的规则判断该数字属于哪类资源，并通过 `.lst` 映射解析名称和脚本路径。例如副本、地图、怪物、NPC、任务、装备、消耗品、对象等代码会在匹配的标签上下文中显示来源类型、名称、LST 路径和可跳转的脚本路径。

代码悬停同时支持两种来源：从 PVF 资源树打开的 `pvf:` 虚拟文件会优先查询当前已打开封包内的 `.lst`；从普通资源管理器打开的解封目录文件会从当前文件目录向上查找候选 `.lst`，例如 `stackable/stackable.lst`、`equipment/equipment.lst`。只有在配置规则能判断该数字属于哪类资源时才会显示，普通数值、注释、反引号字符串中的数字不会被误判。规则命中但查不到代码时，悬停提示会显示候选 LST 和失败原因，便于排查路径或代码映射问题。

### 大包性能调优

解封/封装完成后会在 **PVF 输出面板**打印阶段耗时，例如 `prepare/mkdir/pipelineWrite/manifest`。如果 `pipelineWrite` 占绝大多数时间，瓶颈是 Windows 小文件写盘、杀毒扫描或 VS Code/Git 文件监听，不是 PVF 解析。

可在设置中调整：

| 设置项 | 默认值 | 说明 |
|---------|---------|------|
| `pvf.unpack.writeConcurrency` | `512` | 解封时并发写文件数量。SSD/NVMe 可试 `256-512`，机械盘建议 `64-128`。 |
| `pvf.unpack.workerCount` | `12` | 解封写盘 worker 数量。不同磁盘差异很大，可试 `8/12/16`；机械盘可降低。 |
| `pvf.unpack.writeBatchSize` | `64` | 每个 worker 消息包含的文件数量。小文件很多时建议 `64-128`。 |
| `pvf.unpack.chineseConversion` | `tw2cn` | 解封时将繁体文本写成简体，重新封装时根据 manifest 自动转回繁体；设为 `off` 可关闭。 |
| `pvf.unpack.mkdirConcurrency` | `128` | 并发创建目录数量。 |
| `pvf.repack.readConcurrency` | `192` | 重新封装时并发读取和转换文件数量。 |

目标目录建议放在 SSD/NVMe 上，并尽量不要选在当前 VS Code 工作区或 Git 仓库内部；否则 VS Code 文件监听、搜索索引、Git 扫描和 Windows Defender 可能会显著拖慢 36 万个小文件的创建。

## 开发

```powershell
# 安装依赖
npm install

# 监视模式（仅 TypeScript 编译）
npm run watch

# 完整开发构建
npm run build:all

# 生产构建
npm run vscode:prepublish
```

扩展先将 TypeScript 编译至 `dist/` 目录，然后运行后置脚本复制脚本标签定义文件，并通过 esbuild 将 Webview React 应用打包到 `media/webview/`。
