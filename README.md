# PVF Code (pvf-parser-ts)

在 VS Code 中打开、浏览和编辑 **PVF** 封包文件——DNF（地下城与勇士）的游戏资源包格式。

同时支持解析 **NPK**（Neople Pack）和 **IMG**（Neople Image）格式，并为游戏的多种脚本文件类型提供自定义语言支持。

## 功能特性

- **PVF 资源浏览器** — 侧边栏树形视图，可浏览 PVF 包内文件。支持新建、删除、重命名、剪切/复制/粘贴文件和文件夹。
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
- **解包目录注释视图** — 从 `.env` 的 `UNPACK_DIR` 读取磁盘解包目录，在 PVF 侧边栏的 **解包目录** 视图中显示路径注释，例如 `equipment (装备)`。注释使用 VS Code 的说明文字颜色，和文件/文件夹名区分显示。

## 环境要求

- VS Code 1.100.0 或更高版本
- 在设置中配置 `pvf.npkRoot` 指向游戏目录下的 `ImagePacks2`（可选，NPK 索引功能需要）

## 插件配置

| 设置项 | 默认值 | 说明 |
|---------|---------|------|
| `pvf.npkRoot` | `""` | NPK 文件根目录（通常为游戏目录下的 `ImagePacks2`） |
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

其中 `equipment`、`creature` 使用正常文件名颜色，括号里的注释使用 VS Code 的 `description` 说明文字颜色。视图标题栏的刷新按钮会重新读取 `.env` 和磁盘目录。

原生 VS Code Explorer 不能通过扩展 API 在文件名后追加完整说明文字，且 `FileDecoration.badge` 超过 2 个字符会被 VS Code 直接截断或不显示。因此插件不会在原生 Explorer 中显示注释 badge；原生 Explorer 只保留完整注释的 hover tooltip 和右键菜单 **编辑路径注释**。需要完整行内注释时，请使用 PVF 侧边栏的 **解包目录** 视图。

路径注释默认来自 `src/pvf/resources/treeComments.json`，用户通过 **编辑路径注释** 保存的覆盖项会写入 VS Code `globalStorage`，并按 PVF `fileVersion` 区分版本。若解包目录里存在 `.pvfmanifest.json`，插件会读取其中的 `fileVersion`；没有 manifest 时使用通用版本 `0`。

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
