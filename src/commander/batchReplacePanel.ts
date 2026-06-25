import * as vscode from 'vscode';
import { Deps } from './types';

export function registerBatchReplacePanel(context: vscode.ExtensionContext, deps: Deps) {
  let panel: vscode.WebviewPanel | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand('pvf.batchReplace', async () => {
      const model = deps.model;
      if (!model || model.getAllKeys().length === 0) {
        vscode.window.showErrorMessage('请先打开一个 PVF 文件');
        return;
      }

      if (panel) { panel.reveal(); return; }

      panel = vscode.window.createWebviewPanel(
        'pvfBatchReplace',
        'PVF 批量替换',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'pvf-icon.svg');

      // ─── 构建根级文件夹列表 ──────────────────────────────
      const rootEntries = model.getChildren();

      panel.webview.html = htmlFor(panel.webview);

      const rootDirs = rootEntries.filter(e => !e.isFile).map(e => ({
        key: e.key || '',
        label: e.name || '',
      }));

      panel.webview.onDidReceiveMessage(async msg => {
        switch (msg.type) {
          case 'ready':
            panel!.webview.postMessage({ type: 'roots', dirs: rootDirs });
            return;
          case 'getChildren': {
            const parentKey: string = msg.key || '';
            const children = model.getChildren(parentKey);
            const dirs = children.filter(e => !e.isFile).map(e => ({
              key: e.key || '',
              label: e.name || '',
            }));
            panel!.webview.postMessage({ type: 'children', parentKey, dirs });
            return;
          }
          case 'openFile': {
            const uri = vscode.Uri.parse('pvf:/' + (msg.key || ''));
            vscode.commands.executeCommand('vscode.open', uri);
            return;
          }
          case 'execute': {
            const folderKeys: string[] = msg.folders || [];
            let search: string = msg.search || '';
            const replace: string = msg.replace || '';
            const useRegex: boolean = !!msg.useRegex;

            if (!search) { vscode.window.showWarningMessage('请输入搜索模式'); return; }
            if (!useRegex) search = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            let regex: RegExp;
            try { regex = new RegExp(search, 'g'); }
            catch { vscode.window.showErrorMessage('无效的正则表达式'); return; }

            // 收集选定文件夹下所有文件
            const allKeys = model.getAllKeys();
            let targetKeys: string[];
            if (folderKeys.length === 0) {
              targetKeys = allKeys;
            } else {
              const prefixes = folderKeys.map(k => k.endsWith('/') ? k : k + '/');
              targetKeys = allKeys.filter(k => prefixes.some(p => k.startsWith(p)));
            }

            if (targetKeys.length === 0) {
              panel!.webview.postMessage({ type: 'progress', text: '选定范围内没有文件', done: true });
              return;
            }

            panel!.webview.postMessage({ type: 'progress', text: `正在扫描 ${targetKeys.length} 个文件…`, done: false });
            const matched: { key: string; count: number }[] = [];
            const batchSize = 50;
            for (let start = 0; start < targetKeys.length; start += batchSize) {
              const batch = targetKeys.slice(start, start + batchSize);
              for (const key of batch) {
                try {
                  const bytes = await model.readFileBytes(key);
                  const text = Buffer.from(bytes).toString('utf8');
                  regex.lastIndex = 0;
                  const matches = text.match(regex);
                  if (matches && matches.length > 0) matched.push({ key, count: matches.length });
                } catch { /* 二进制或不可读跳过 */ }
              }
              panel!.webview.postMessage({
                type: 'progress',
                text: `扫描中 ${Math.min(start + batchSize, targetKeys.length)}/${targetKeys.length}，已发现 ${matched.length} 个文件有匹配`,
                done: false,
              });
            }

            panel!.webview.postMessage({ type: 'scanResult', matched, totalFiles: targetKeys.length });
            return;
          }
          case 'apply': {
            const matched: { key: string; count: number }[] = msg.matched || [];
            let search: string = msg.search || '';
            const replace: string = msg.replace || '';
            const useRegex: boolean = !!msg.useRegex;
            if (!useRegex) search = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            let regex: RegExp;
            try { regex = new RegExp(search, 'g'); } catch { return; }

            let replaced = 0;
            let errors = 0;
            const batchSize = 20;
            for (let start = 0; start < matched.length; start += batchSize) {
              const batch = matched.slice(start, start + batchSize);
              for (const { key } of batch) {
                try {
                  const bytes = await model.readFileBytes(key);
                  let text = Buffer.from(bytes).toString('utf8');
                  let hadBom = false;
                  if (text.charCodeAt(0) === 0xFEFF) { hadBom = true; text = text.slice(1); }
                  const newText = text.replace(regex, replace);
                  if (newText !== text) {
                    const withBom = hadBom ? '\uFEFF' + newText : newText;
                    model.updateFileData(key, Buffer.from(withBom, 'utf8'));
                    replaced++;
                  }
                } catch { errors++; }
              }
              panel!.webview.postMessage({
                type: 'progress',
                text: `替换中 ${Math.min(start + batchSize, matched.length)}/${matched.length}，已替换 ${replaced} 个文件${errors ? `，${errors} 个出错` : ''}`,
                done: false,
              });
            }
            panel!.webview.postMessage({ type: 'applyDone', replaced, errors, total: matched.length });
            return;
          }
        }
      });

      panel.onDidDispose(() => { panel = undefined; });
    }),
  );
}

function htmlFor(webview: vscode.Webview): string {
  const csp = webview.cspSource;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp} 'unsafe-inline';">
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;font-size:13px}
body{display:flex;height:100vh;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}
.sidebar{width:280px;min-width:200px;border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;background:var(--vscode-sideBar-background)}
.sidebar h3{padding:8px 12px;font-weight:600;font-size:12px;text-transform:uppercase;color:var(--vscode-sideBarTitle-foreground)}
.tree{flex:1;overflow-y:auto;padding:2px 0}
.tree-item{cursor:pointer;user-select:none;display:flex;align-items:center;gap:4px;white-space:nowrap;height:22px}
.tree-item:hover{background:var(--vscode-list-hoverBackground)}
.tree-item .arrow{width:14px;flex-shrink:0;text-align:center;color:var(--vscode-list-treeIndentGuidesStroke)}
.tree-item .arrow.empty{visibility:hidden}
.tree-item input[type="checkbox"]{flex-shrink:0;cursor:pointer}
.tree-item .label{overflow:hidden;text-overflow:ellipsis}
.tree-item.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.main{flex:1;display:flex;flex-direction:column;padding:16px;gap:12px;overflow:auto}
.form-row{display:flex;flex-direction:column;gap:4px}
.form-row label{font-size:11px;font-weight:600;text-transform:uppercase;color:var(--vscode-input-placeholderForeground)}
.form-row input,.form-row textarea{padding:4px 8px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:2px;resize:vertical;font-family:monospace}
.form-row input:focus,.form-row textarea:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.btn-row{display:flex;gap:8px;align-items:center}
.btn{padding:4px 16px;border:none;cursor:pointer;border-radius:2px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn:disabled{opacity:.5;cursor:default}
.btn.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn.danger{background:var(--vscode-errorForeground);color:white}
.progress{font-size:12px;color:var(--vscode-descriptionForeground);min-height:18px}
.results{flex:1;overflow-y:auto;border:1px solid var(--vscode-panel-border);border-radius:2px;padding:4px}
.result-item{padding:2px 4px;display:flex;justify-content:space-between;gap:8px;font-size:12px}
.result-item:hover{background:var(--vscode-list-hoverBackground)}
.result-item .key{overflow:hidden;text-overflow:ellipsis}
.result-item .count{flex-shrink:0;color:var(--vscode-descriptionForeground)}
.result-item.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
</style>
</head>
<body>
<div class="sidebar">
  <h3>文件夹</h3>
  <div class="tree" id="tree"></div>
</div>
<div class="main">
  <div class="form-row">
    <label for="search">搜索</label>
    <textarea id="search" rows="3" placeholder="[part set index]&#10;&#9;30183"></textarea>
  </div>
  <div class="form-row">
    <label for="replace">替换为</label>
    <textarea id="replace" rows="3" placeholder=""></textarea>
  </div>
  <div class="btn-row">
    <button class="btn" id="regexToggle">正则: OFF</button>
  </div>
  <div class="btn-row">
    <button class="btn" id="scanBtn">扫描</button>
    <button class="btn danger" id="applyBtn" disabled>执行替换</button>
  </div>
  <div class="progress" id="progress"></div>
  <div class="results" id="results"></div>
</div>
<script>
(function(){
  const vscode = acquireVsCodeApi();
  const treeEl = document.getElementById('tree');
  const progressEl = document.getElementById('progress');
  const resultsEl = document.getElementById('results');
  const scanBtn = document.getElementById('scanBtn');
  const applyBtn = document.getElementById('applyBtn');
  const regexToggle = document.getElementById('regexToggle');

  let useRegex = false;
  regexToggle.addEventListener('click', () => {
    useRegex = !useRegex;
    regexToggle.textContent = useRegex ? '正则: ON' : '正则: OFF';
    regexToggle.className = useRegex ? 'btn secondary' : 'btn';
  });

  let checked = {};       // key -> true
  let lastMatched = [];

  // ─── Tree ────────────────────────────────────────────────
  function treeItemHTML(key, label, depth) {
    const pad = depth * 16;
    const ck = checked[key] ? ' checked' : '';
    return \`<div class="tree-item" data-key="\${key}" data-depth="\${depth}" style="padding-left:\${pad}px">
      <span class="arrow">▶</span>
      <input type="checkbox"\${ck}>
      <span class="label">\${label}</span>
    </div>\`;
  }

  function addChildren(parentEl, dirs, depth) {
    const parentDepth = parseInt(parentEl.dataset.depth);
    const childDepth = parentDepth + 1;
    let html = '';
    for (const d of dirs) {
      html += treeItemHTML(d.key, d.label, childDepth);
    }
    parentEl.insertAdjacentHTML('afterend', html);
    // 绑定事件
    let el = parentEl.nextElementSibling;
    for (const d of dirs) {
      if (!el) break;
      if (el.dataset.key !== d.key) { el = el.nextElementSibling; continue; }
      bindTreeItem(el);
      el = el.nextElementSibling;
    }
  }

  function removeDescendants(el) {
    const depth = parseInt(el.dataset.depth);
    let next = el.nextElementSibling;
    while (next && next.classList.contains('tree-item')) {
      const n = next;
      next = n.nextElementSibling;
      if (parseInt(n.dataset.depth) <= depth) break;
      n.remove();
    }
  }

  function bindTreeItem(el) {
    const key = el.dataset.key;
    const cb = el.querySelector('input[type="checkbox"]');
    const arrow = el.querySelector('.arrow');

    el.addEventListener('click', e => {
      if (e.target === cb) {
        checked[key] = cb.checked;
        // 同步所有子文件夹
        const prefix = key + '/';
        const depth = parseInt(el.dataset.depth);
        let next = el.nextElementSibling;
        while (next && next.classList.contains('tree-item') && parseInt(next.dataset.depth) > depth) {
          if (next.dataset.key.startsWith(prefix)) {
            const childCb = next.querySelector('input[type="checkbox"]');
            childCb.checked = cb.checked;
            checked[next.dataset.key] = cb.checked;
          }
          next = next.nextElementSibling;
        }
        return;
      }
      if (e.target === arrow || e.target.closest('.tree-item') === el) {
        if (arrow.textContent === '▶') {
          // 展开请求子文件夹
          arrow.textContent = '▼';
          vscode.postMessage({ type: 'getChildren', key });
        } else {
          arrow.textContent = '▶';
          removeDescendants(el);
        }
      }
    });
  }

  // ─── Messages ────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'roots': {
        treeEl.innerHTML = '';
        let html = '';
        for (const d of msg.dirs) {
          html += treeItemHTML(d.key, d.label, 0);
        }
        treeEl.innerHTML = html;
        for (const el of treeEl.children) {
          if (el.classList.contains('tree-item')) bindTreeItem(el);
        }
        break;
      }
      case 'children': {
        const parentEl = treeEl.querySelector(\`.tree-item[data-key="\${msg.parentKey}"]\`);
        if (!parentEl) break;
        // 子项已存在则跳过
        const next = parentEl.nextElementSibling;
        if (next && next.dataset.key && next.dataset.key.startsWith(msg.parentKey + '/')) break;
        addChildren(parentEl, msg.dirs, parseInt(parentEl.dataset.depth));
        // parent 未勾选时，新子项按自身存储状态
        break;
      }
      case 'progress': {
        progressEl.textContent = msg.text || '';
        scanBtn.disabled = !msg.done && msg.text ? true : false;
        break;
      }
      case 'scanResult': {
        lastMatched = msg.matched || [];
        const total = msg.totalFiles || 0;
        progressEl.textContent = \`扫描完成：\${lastMatched.length} 个文件匹配（共扫描 \${total} 个文件）\`;
        scanBtn.disabled = false;
        if (lastMatched.length > 0) applyBtn.disabled = false;
        renderResults(lastMatched);
        break;
      }
      case 'applyDone': {
        progressEl.textContent = \`替换完成：\${msg.replaced} 个文件已更新\${msg.errors ? '，' + msg.errors + ' 个出错' : ''}\`;
        scanBtn.disabled = false;
        applyBtn.disabled = true;
        break;
      }
    }
  });

  function renderResults(matched) {
    resultsEl.innerHTML = '';
    const totalMatches = matched.reduce((s, f) => s + f.count, 0);
    const header = document.createElement('div');
    header.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);padding:2px 4px;margin-bottom:4px;border-bottom:1px solid var(--vscode-panel-border)';
    header.textContent = \`\${matched.length} 个文件，\${totalMatches} 处匹配\`;
    resultsEl.appendChild(header);
    for (const f of matched.slice(0, 500)) {
      const div = document.createElement('div');
      div.className = 'result-item';
      div.innerHTML = \`<span class="key">\${f.key}</span><span class="count">\${f.count}</span>\`;
      div.addEventListener('click', () => {
        vscode.postMessage({ type: 'openFile', key: f.key });
      });
      resultsEl.appendChild(div);
    }
    if (matched.length > 500) {
      const more = document.createElement('div');
      more.style.cssText = 'padding:4px;font-size:11px;color:var(--vscode-descriptionForeground)';
      more.textContent = \`…以及另外 \${matched.length - 500} 个文件\`;
      resultsEl.appendChild(more);
    }
  }

  // ─── Buttons ─────────────────────────────────────────────
  scanBtn.addEventListener('click', () => {
    const folders = Object.keys(checked).filter(k => checked[k]);
    if (folders.length === 0) {
      progressEl.textContent = '请先在左侧勾选文件夹';
      return;
    }
    applyBtn.disabled = true;
    vscode.postMessage({
      type: 'execute',
      folders,
      search: document.getElementById('search').value,
      replace: document.getElementById('replace').value,
      useRegex,
    });
  });

  applyBtn.addEventListener('click', () => {
    applyBtn.disabled = true;
    vscode.postMessage({
      type: 'apply',
      matched: lastMatched,
      search: document.getElementById('search').value,
      replace: document.getElementById('replace').value,
      useRegex,
    });
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
