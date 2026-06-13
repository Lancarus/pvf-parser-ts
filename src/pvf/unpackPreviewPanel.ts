import * as vscode from 'vscode';
import type { UnpackHoverPreview, UnpackPreviewSection, UnpackPreviewSkillTreeGroup, UnpackPreviewSkillTreeNode } from './unpackPreview';
import { normalizeUnpackKey } from './unpackMetadata';

export class UnpackHoverPreviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private currentPreview: UnpackHoverPreview | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  showLoading(title: string, key: string, preserveFocus = true): void {
    const panel = this.ensurePanel(preserveFocus);
    panel.title = title ? `预览: ${title}` : '解包预览';
    panel.webview.html = this.html(panel.webview, loadingMarkup(title, key));
  }

  show(preview: UnpackHoverPreview, preserveFocus = true): void {
    const panel = this.ensurePanel(preserveFocus);
    this.currentPreview = preview;
    panel.title = preview.title ? `预览: ${preview.title}` : '解包预览';
    panel.webview.html = this.html(panel.webview, renderPreview(preview));
  }

  clear(message = '将鼠标悬停到解包目录中的装备、道具、商店、任务、技能或技能树文件。'): void {
    if (!this.panel) return;
    this.currentPreview = undefined;
    this.panel.webview.html = this.html(this.panel.webview, `<div class="preview-frame"><div class="preview-loading">${escapeHtml(message)}</div></div>`);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(preserveFocus = true): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      'pvfUnpackHoverPreview',
      '解包预览',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri, this.context.globalStorageUri],
      },
    );
    panel.webview.onDidReceiveMessage(message => {
      if (!message || typeof message !== 'object') return;
      if ((message as any).type === 'openTag' && typeof (message as any).tagName === 'string') {
        void this.openCurrentPreviewTag((message as any).tagName);
        return;
      }
      if ((message as any).type === 'openSkill') {
        const key = typeof (message as any).key === 'string' ? (message as any).key : '';
        const code = typeof (message as any).code === 'number' ? (message as any).code : undefined;
        void this.openCurrentPreviewSkill(key, code);
      }
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.currentPreview = undefined;
      }
    });
    this.panel = panel;
    return panel;
  }

  private async openCurrentPreviewTag(tagName: string): Promise<void> {
    const preview = this.currentPreview;
    if (!preview?.fsPath || !tagName.trim()) return;
    try {
      const uri = vscode.Uri.file(preview.fsPath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One, false);
      const found = findTagRange(document, tagName);
      if (found) {
        editor.selection = new vscode.Selection(found.start, found.end);
        editor.revealRange(found, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (err: any) {
      vscode.window.showWarningMessage(`无法跳转到 [${tagName}]: ${String(err && err.message || err)}`);
    }
  }

  private async openCurrentPreviewSkill(key: string, code: number | undefined): Promise<void> {
    const node = findSkillTreeNode(this.currentPreview, key, code);
    if (!node?.fsPath) {
      vscode.window.showWarningMessage('无法跳转：这个技能节点没有解析到对应的 .skl 文件。');
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(node.fsPath));
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One, false);
    } catch (err: any) {
      vscode.window.showWarningMessage(`无法打开技能文件: ${String(err && err.message || err)}`);
    }
  }

  private html(webview: vscode.Webview, body: string): string {
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  --rarity-0: var(--vscode-pvf-rarity0Foreground, #d4d4d4);
  --rarity-1: var(--vscode-pvf-rarity1Foreground, #68d5ed);
  --rarity-2: var(--vscode-pvf-rarity2Foreground, #b36bff);
  --rarity-3: var(--vscode-pvf-rarity3Foreground, #ff4df2);
  --rarity-4: var(--vscode-pvf-rarity4Foreground, #ffb100);
  --rarity-5: var(--vscode-pvf-rarity5Foreground, #ff6666);
  --rarity-6: var(--vscode-pvf-rarity6Foreground, #ff7800);
  --rarity-7: var(--vscode-pvf-rarity7Foreground, #36e6ff);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
body {
  background: var(--vscode-editor-background);
  color: #ded8ca;
  font: 12px/1.42 var(--vscode-font-family);
}
.preview-stage {
  min-height: 100vh;
  padding: 12px 14px;
}
.hover-preview {
  display: grid;
  grid-template-columns: minmax(280px, 360px);
  gap: 8px;
  width: max-content;
  max-width: 100%;
  color: #ded8ca;
  user-select: text;
}
.hover-preview.split {
  grid-template-columns: repeat(2, minmax(280px, 360px));
}
.hover-preview.skill-tree {
  grid-template-columns: minmax(520px, 1fr);
  width: 100%;
}
.hover-preview.skill {
  grid-template-columns: minmax(360px, 620px);
}
.hover-preview.skill-tree.split {
  grid-template-columns: repeat(2, minmax(340px, 420px));
}
.preview-frame {
  min-width: 0;
  padding: 8px 9px 9px;
  background:
    linear-gradient(180deg, rgba(38,42,56,.82), rgba(10,11,17,.96) 34px, rgba(5,6,10,.98)),
    #07080c;
  border: 1px solid #74716a;
  box-shadow: 0 8px 22px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.05);
}
.preview-loading {
  color: var(--vscode-descriptionForeground);
  padding: 4px 2px;
}
.preview-head {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 8px;
  align-items: start;
  min-height: 34px;
}
.preview-icon {
  width: 32px;
  height: 32px;
  border: 1px solid #4a4a4a;
  background: #1b1b1b;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #777;
}
.preview-icon img,
.preview-entry-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.preview-title {
  font-size: 14px;
  line-height: 1.25;
  font-weight: 600;
  color: #f1f1f1;
  overflow-wrap: anywhere;
}
.preview-title.rarity-0 { color: var(--rarity-0); }
.preview-title.rarity-1 { color: var(--rarity-1); }
.preview-title.rarity-2 { color: var(--rarity-2); }
.preview-title.rarity-3 { color: var(--rarity-3); }
.preview-title.rarity-4 { color: var(--rarity-4); }
.preview-title.rarity-5 { color: var(--rarity-5); }
.preview-title.rarity-6 { color: var(--rarity-6); }
.preview-title.rarity-7 { color: var(--rarity-7); }
.preview-subtitle {
  margin-top: 2px;
  color: #aaa39a;
  font-size: 11px;
}
.preview-badges {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.preview-badge {
  border: 1px solid #5f574a;
  color: #d5be7a;
  padding: 0 5px;
  font-size: 10px;
}
.preview-path {
  margin-top: 6px;
  color: #777;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.preview-sep {
  height: 1px;
  background: #303033;
  margin: 7px 0;
}
.preview-section {
  margin-top: 7px;
}
.preview-section-title {
  color: #d9c27a;
  font-size: 11px;
  margin-bottom: 3px;
}
.preview-section.blue .preview-line,
.preview-section.blue .preview-field-value,
.preview-section.skill .preview-line,
.preview-section.skill .preview-field-value {
  color: #7db4ff;
}
.preview-section.flavor .preview-line {
  color: #8c8c8c;
}
.preview-section.set .preview-line,
.preview-section.set .preview-entry-name {
  color: #d4b1ff;
}
.preview-field {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px;
  min-height: 16px;
}
.preview-field-label {
  color: #9b948b;
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: default;
}
.preview-field-label.clickable {
  cursor: pointer;
}
.preview-field-label.clickable:hover {
  color: #d9c27a;
  text-decoration: underline;
}
.preview-field-value {
  color: #e1ded8;
  overflow-wrap: anywhere;
}
.preview-field-value.magic { color: #77aaff; }
.preview-line {
  white-space: pre-wrap;
  color: #ddd8cc;
  overflow-wrap: anywhere;
}
.preview-table-caption {
  margin: 6px 0 3px;
  color: #b7b0a4;
  font-size: 10px;
}
.preview-table-caption.clickable {
  border: 0;
  padding: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.preview-table-caption.clickable:hover {
  color: #d9c27a;
  text-decoration: underline;
}
.preview-table-wrap {
  max-width: 100%;
  max-height: 260px;
  overflow: auto;
  border: 1px solid #343943;
  background: rgba(7, 9, 14, .42);
}
.preview-table {
  min-width: 100%;
  width: max-content;
  border-collapse: collapse;
  font-size: 11px;
  line-height: 1.35;
}
.preview-table th,
.preview-table td {
  border-right: 1px solid #303641;
  border-bottom: 1px solid #303641;
  padding: 2px 6px;
  white-space: nowrap;
  text-align: left;
}
.preview-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  color: #d9c27a;
  background: #171b24;
}
.preview-table td {
  color: #d6dfef;
}
.preview-table td:first-child {
  color: #aaa39a;
}
.preview-entry {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 6px;
  align-items: center;
  min-height: 26px;
  padding: 2px 0;
}
.preview-entry-icon {
  width: 24px;
  height: 24px;
  border: 1px solid #383838;
  background: #171717;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview-entry-name {
  color: #e8e0d0;
  overflow-wrap: anywhere;
}
.preview-entry-detail {
  color: #8f8f8f;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.preview-minimap {
  position: relative;
  height: 130px;
  border: 1px solid #3f3f45;
  background:
    linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px),
    #111318;
  background-size: 24px 24px;
  margin-top: 7px;
  overflow: hidden;
}
.preview-map-point {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: #4da3ff;
  box-shadow: 0 0 5px rgba(77,163,255,.7);
}
.preview-map-point.unresolved { background: #6a6a6a; box-shadow: none; }
.preview-map-point.common { background: #d8b657; box-shadow: 0 0 5px rgba(216,182,87,.7); }
.skill-tree-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: 10px;
}
.skill-tree-card {
  min-width: 0;
  border: 1px solid #4f4b41;
  background:
    linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.024) 1px, transparent 1px),
    #0d0f15;
  background-size: 36px 36px;
}
.skill-tree-title {
  height: 25px;
  padding: 4px 8px;
  border-bottom: 1px solid #38352f;
  color: #d9c27a;
  background: rgba(0,0,0,.34);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-tree-canvas {
  position: relative;
  height: var(--skill-tree-height, 300px);
  min-height: 220px;
  overflow: hidden;
}
.skill-tree-lines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.skill-tree-line {
  stroke: rgba(132, 147, 168, .44);
  stroke-width: 1.5;
}
.skill-tree-node {
  position: absolute;
  left: var(--node-left);
  top: var(--node-top);
  width: 34px;
  height: 34px;
  padding: 1px;
  transform: translate(-50%, -50%);
  border: 1px solid #84735a;
  background: #111;
  font: inherit;
  appearance: none;
  box-shadow: 0 1px 0 rgba(255,255,255,.12) inset, 0 4px 10px rgba(0,0,0,.45);
}
.skill-tree-node.resolved {
  cursor: pointer;
}
.skill-tree-node.common {
  border-color: #d8b657;
}
.skill-tree-node.unresolved {
  border-color: #575757;
  background: #1b1b1b;
  color: #8b8b8b;
}
.skill-tree-node:hover {
  outline: 1px solid #e4c66f;
  z-index: 2;
}
.skill-tree-node img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.skill-tree-fallback {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  color: #aaa39a;
  font-size: 10px;
  line-height: 1;
}
@media (max-width: 820px) {
  .hover-preview.split,
  .hover-preview.skill-tree.split {
    grid-template-columns: minmax(280px, 1fr);
    width: 100%;
  }
  .hover-preview,
  .hover-preview.skill,
  .hover-preview.skill-tree {
    grid-template-columns: minmax(280px, 1fr);
    width: 100%;
  }
  .skill-tree-list {
    grid-template-columns: minmax(280px, 1fr);
  }
}
</style>
</head>
<body>
<main class="preview-stage">${body}</main>
<script>
const vscode = acquireVsCodeApi();
document.addEventListener('click', event => {
  const skillTarget = event.target && event.target.closest ? event.target.closest('[data-skill-key]') : null;
  if (skillTarget) {
    event.preventDefault();
    const rawCode = Number(skillTarget.getAttribute('data-skill-code') || '');
    vscode.postMessage({
      type: 'openSkill',
      key: skillTarget.getAttribute('data-skill-key') || '',
      code: Number.isFinite(rawCode) ? rawCode : undefined,
    });
    return;
  }
  const target = event.target && event.target.closest ? event.target.closest('[data-tag-name]') : null;
  if (!target) return;
  event.preventDefault();
  vscode.postMessage({ type: 'openTag', tagName: target.getAttribute('data-tag-name') || '' });
});
</script>
</body>
</html>`;
  }
}

function loadingMarkup(title: string, key: string): string {
  return `<div class="hover-preview"><div class="preview-frame"><div class="preview-loading">载入预览...</div><div class="preview-path">${escapeHtml(title)}${key ? `<br>${escapeHtml(key)}` : ''}</div></div></div>`;
}

function renderPreview(preview: UnpackHoverPreview): string {
  const classes = [
    'hover-preview',
    preview.kind === 'skill' ? 'skill' : '',
    preview.kind === 'skillTree' ? 'skill-tree' : '',
  ].filter(Boolean).join(' ');
  return `<div class="${classes}">${renderFrame(preview, preview.sections || [], true)}</div>`;
}

function renderFrame(preview: UnpackHoverPreview, sections: UnpackPreviewSection[], primary: boolean): string {
  const chunks: string[] = ['<div class="preview-frame">'];
  if (primary) {
    chunks.push(renderHeader(preview));
    if (preview.key) chunks.push(`<div class="preview-path">${escapeHtml(preview.key)}</div>`);
    chunks.push('<div class="preview-sep"></div>');
    if (preview.message) chunks.push(`<div class="preview-line">${escapeHtml(preview.message)}</div>`);
    if (preview.miniMap?.points?.length) {
      chunks.push(renderMiniMap(preview));
      chunks.push('<div class="preview-sep"></div>');
    }
    if (preview.skillTrees?.length) {
      chunks.push(renderSkillTrees(preview.skillTrees));
    }
  }
  for (const section of sections) chunks.push(renderSection(section));
  chunks.push('</div>');
  return chunks.join('');
}

function renderHeader(preview: UnpackHoverPreview): string {
  const icon = preview.icon?.src
    ? `<img src="${escapeAttr(preview.icon.src)}" alt="">`
    : '';
  const rarity = typeof preview.rarity === 'number' ? ` rarity-${preview.rarity}` : '';
  const subtitleParts = [preview.subtitle, typeof preview.itemCode === 'number' ? `<${preview.itemCode}>` : '', preview.rarityLabel].filter(Boolean);
  const subtitle = subtitleParts.length ? `<div class="preview-subtitle">${escapeHtml(subtitleParts.join('  '))}</div>` : '';
  const badges = preview.badges?.length
    ? `<div class="preview-badges">${preview.badges.map(item => `<span class="preview-badge">${escapeHtml(item)}</span>`).join('')}</div>`
    : '';
  return `<div class="preview-head">
<div class="preview-icon">${icon}</div>
<div>
<div class="preview-title${rarity}">${escapeHtml(preview.title || preview.key || '')}</div>
${subtitle}${badges}
</div>
</div>`;
}

function renderSection(section: UnpackPreviewSection): string {
  const tone = section.tone ? ` ${section.tone}` : '';
  const chunks = [`<section class="preview-section${tone}">`, `<div class="preview-section-title">${escapeHtml(section.title || '')}</div>`];
  for (const field of section.fields || []) {
    const fieldTone = field.tone ? ` ${field.tone}` : '';
    const tagAttrs = field.tagName ? ` title="${escapeAttr(field.tagName)}" data-tag-name="${escapeAttr(field.tagName)}"` : '';
    const labelClass = `preview-field-label${field.tagName ? ' clickable' : ''}`;
    chunks.push(`<div class="preview-field"><button type="button" class="${labelClass}"${tagAttrs}>${escapeHtml(field.label || '')}</button><div class="preview-field-value${fieldTone}">${escapeHtml(field.value || '')}</div></div>`);
  }
  for (const line of section.lines || []) {
    chunks.push(`<div class="preview-line">${escapeHtml(line)}</div>`);
  }
  for (const table of section.tables || []) {
    chunks.push(renderTable(table));
  }
  for (const entry of section.entries || []) {
    chunks.push(renderEntry(entry));
  }
  chunks.push('</section>');
  return chunks.join('');
}

function renderTable(table: NonNullable<UnpackPreviewSection['tables']>[number]): string {
  const tagAttrs = table.tagName ? ` title="${escapeAttr(table.tagName)}" data-tag-name="${escapeAttr(table.tagName)}"` : '';
  const caption = table.caption
    ? table.tagName
      ? `<button type="button" class="preview-table-caption clickable"${tagAttrs}>${escapeHtml(table.caption)}</button>`
      : `<div class="preview-table-caption">${escapeHtml(table.caption)}</div>`
    : '';
  const headers = `<tr>${(table.headers || []).map(value => `<th>${escapeHtml(value || '')}</th>`).join('')}</tr>`;
  const rows = (table.rows || []).map(row => `<tr>${row.map(value => `<td>${escapeHtml(value || '')}</td>`).join('')}</tr>`).join('');
  return `${caption}<div class="preview-table-wrap"><table class="preview-table"><thead>${headers}</thead><tbody>${rows}</tbody></table></div>`;
}

function renderEntry(entry: NonNullable<UnpackPreviewSection['entries']>[number]): string {
  const icon = entry.icon?.src ? `<img src="${escapeAttr(entry.icon.src)}" alt="">` : '';
  const prefix = typeof entry.code === 'number' ? `${entry.code}  ` : '';
  const qty = typeof entry.quantity === 'number' ? ` x${entry.quantity}` : '';
  const name = `${prefix}${entry.name || (entry.unresolved ? '未解析' : '')}${qty}`;
  const details = [
    entry.branch,
    typeof entry.x === 'number' && typeof entry.y === 'number' ? `坐标 ${entry.x}, ${entry.y}` : '',
    entry.common ? '通用' : '',
    entry.key,
    entry.detail,
  ].filter(Boolean).join('  ');
  return `<div class="preview-entry">
<div class="preview-entry-icon">${icon}</div>
<div>
<div class="preview-entry-name">${escapeHtml(name)}</div>
${details ? `<div class="preview-entry-detail">${escapeHtml(details)}</div>` : ''}
</div>
</div>`;
}

function renderMiniMap(preview: UnpackHoverPreview): string {
  const points = preview.miniMap?.points || [];
  const xs = points.map(point => Number(point.x)).filter(Number.isFinite);
  const ys = points.map(point => Number(point.y)).filter(Number.isFinite);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const dots = points.map(point => {
    const left = 8 + ((Number(point.x) - minX) / spanX) * 84;
    const top = 10 + ((Number(point.y) - minY) / spanY) * 80;
    const cls = `preview-map-point${point.resolved ? '' : ' unresolved'}${point.common ? ' common' : ''}`;
    return `<span class="${cls}" style="left:${left}%;top:${top}%" title="${escapeAttr(point.label || '')}"></span>`;
  }).join('');
  return `<div class="preview-minimap">${dots}</div>`;
}

function renderSkillTrees(groups: UnpackPreviewSkillTreeGroup[]): string {
  return `<div class="skill-tree-list">${groups.map(renderSkillTreeGroup).join('')}</div>`;
}

function renderSkillTreeGroup(group: UnpackPreviewSkillTreeGroup): string {
  const positioned = skillTreePositions(group.nodes || []);
  const lines = renderSkillTreeLines(group.nodes || [], positioned);
  const nodes = (group.nodes || []).map((node, idx) => renderSkillTreeNode(node, positioned.get(nodePositionKey(node, idx)))).join('');
  const title = group.title || [group.jobLabel, group.branchLabel].filter(Boolean).join(' / ') || '技能树';
  return `<section class="skill-tree-card">
<div class="skill-tree-title" title="${escapeAttr(title)}">${escapeHtml(title)}</div>
<div class="skill-tree-canvas" style="--skill-tree-height:${skillTreeHeight(group.nodes || [])}px">
<svg class="skill-tree-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
${nodes}
</div>
</section>`;
}

function renderSkillTreeLines(nodes: UnpackPreviewSkillTreeNode[], positions: Map<string, SkillTreePosition>): string {
  const byCode = new Map<number, SkillTreePosition>();
  nodes.forEach((node, idx) => {
    const pos = positions.get(nodePositionKey(node, idx));
    if (pos && typeof node.code === 'number') byCode.set(node.code, pos);
  });
  const lines: string[] = [];
  nodes.forEach((node, idx) => {
    const from = positions.get(nodePositionKey(node, idx));
    if (!from) return;
    for (const next of node.nextSkills || []) {
      const to = byCode.get(next);
      if (!to) continue;
      lines.push(`<line class="skill-tree-line" x1="${trimNumber(from.left)}" y1="${trimNumber(from.top)}" x2="${trimNumber(to.left)}" y2="${trimNumber(to.top)}"></line>`);
    }
  });
  return lines.join('');
}

function renderSkillTreeNode(node: UnpackPreviewSkillTreeNode, position: SkillTreePosition | undefined): string {
  const pos = position || { left: 8, top: 8 };
  const cls = `skill-tree-node${node.key ? ' resolved' : ''}${node.unresolved ? ' unresolved' : ''}${node.common ? ' common' : ''}`;
  const label = skillTreeNodeLabel(node);
  const icon = node.icon?.src
    ? `<img src="${escapeAttr(node.icon.src)}" alt="">`
    : `<span class="skill-tree-fallback">${escapeHtml(String(node.code))}</span>`;
  const style = `--node-left:${trimNumber(pos.left)}%;--node-top:${trimNumber(pos.top)}%`;
  if (node.key) {
    return `<button type="button" class="${cls}" style="${style}" title="${escapeAttr(label)}" data-skill-key="${escapeAttr(node.key)}" data-skill-code="${escapeAttr(String(node.code))}">${icon}</button>`;
  }
  return `<span class="${cls}" style="${style}" title="${escapeAttr(label)}">${icon}</span>`;
}

interface SkillTreePosition {
  left: number;
  top: number;
}

function skillTreePositions(nodes: UnpackPreviewSkillTreeNode[]): Map<string, SkillTreePosition> {
  const positioned = nodes.filter(node => Number.isFinite(node.x) && Number.isFinite(node.y));
  const xs = positioned.map(node => Number(node.x));
  const ys = positioned.map(node => Number(node.y));
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 1;
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxY = ys.length ? Math.max(...ys) : 1;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const fallbackColumns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, nodes.length))));
  const map = new Map<string, SkillTreePosition>();
  nodes.forEach((node, idx) => {
    if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
      map.set(nodePositionKey(node, idx), {
        left: 6 + ((Number(node.x) - minX) / spanX) * 88,
        top: 8 + ((Number(node.y) - minY) / spanY) * 82,
      });
      return;
    }
    const col = idx % fallbackColumns;
    const row = Math.floor(idx / fallbackColumns);
    map.set(nodePositionKey(node, idx), {
      left: 8 + (col / Math.max(1, fallbackColumns - 1)) * 84,
      top: 12 + row * 12,
    });
  });
  return map;
}

function skillTreeHeight(nodes: UnpackPreviewSkillTreeNode[]): number {
  const ys = nodes.map(node => Number(node.y)).filter(Number.isFinite);
  if (!ys.length) return Math.min(620, Math.max(260, Math.ceil(nodes.length / 8) * 62));
  const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));
  return Math.min(760, Math.max(260, Math.round(spanY + 120)));
}

function nodePositionKey(node: UnpackPreviewSkillTreeNode, index: number): string {
  return `${index}:${node.code}`;
}

function skillTreeNodeLabel(node: UnpackPreviewSkillTreeNode): string {
  const parts = [
    `ID: ${node.code}`,
    node.name ? `名称: ${node.name}` : undefined,
    node.key,
  ].filter((part): part is string => !!part);
  return parts.join('\n');
}

function trimNumber(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findSkillTreeNode(preview: UnpackHoverPreview | undefined, key: string, code: number | undefined): UnpackPreviewSkillTreeNode | undefined {
  if (!preview?.skillTrees?.length) return undefined;
  const normalized = key ? normalizeUnpackKey(key) : '';
  for (const group of preview.skillTrees) {
    for (const node of group.nodes || []) {
      if (normalized && node.key && normalizeUnpackKey(node.key) === normalized) return node;
      if (!normalized && typeof code === 'number' && node.code === code && node.fsPath) return node;
    }
  }
  return undefined;
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function findTagRange(document: vscode.TextDocument, tagName: string): vscode.Range | undefined {
  const escaped = tagName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return undefined;
  const pattern = new RegExp(`\\[\\s*${escaped}\\s*\\]`, 'i');
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    const match = pattern.exec(text);
    if (!match) continue;
    const start = text.indexOf('[', match.index) + 1;
    const end = match.index + match[0].lastIndexOf(']');
    return new vscode.Range(line, start, line, Math.max(start, end));
  }
  return undefined;
}
