(function () {
  const vscode = acquireVsCodeApi();
  const tree = document.getElementById('tree');
  const cfg = window.__PVF_UNPACK_CONFIG__ || {};
  const rows = new Map();
  let selectedId = '';

  function post(type, payload = {}) {
    vscode.postMessage({ type, ...payload });
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function span(className, text) {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  }

  function iconFor(row) {
    const icon = document.createElement('span');
    icon.className = 'icon';
    if (row.icon?.src) {
      icon.style.setProperty('--icon-w', `${row.icon.displayWidth || 20}px`);
      icon.style.setProperty('--icon-h', `${row.icon.displayHeight || 20}px`);
      const img = document.createElement('img');
      img.src = row.icon.src;
      img.alt = '';
      img.draggable = false;
      icon.appendChild(img);
      return icon;
    }
    const fallback = document.createElement('span');
    fallback.className = row.isDirectory ? 'fallback-folder' : 'fallback-file';
    icon.appendChild(fallback);
    return icon;
  }

  function nameClass(row) {
    if (typeof row.rarity === 'number' && row.rarity >= 0 && row.rarity <= 7) return `item-name rarity-${row.rarity}`;
    return 'item-name string';
  }

  function renderMetadata(row, parent) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    let hasMeta = false;
    if (cfg.showComment !== false && row.comment) {
      meta.appendChild(span('comment', `(${row.comment})`));
      hasMeta = true;
    }
    if (cfg.showItemName !== false && row.itemName) {
      meta.appendChild(span(nameClass(row), row.itemName));
      hasMeta = true;
    }
    if (cfg.showItemCode !== false && row.itemCodeText) {
      meta.appendChild(span('item-code', row.itemCodeText));
      hasMeta = true;
    }
    if (hasMeta) parent.appendChild(meta);
  }

  function rowElement(row, depth) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.id = row.id;
    el.dataset.depth = String(depth);
    el.dataset.directory = row.isDirectory ? '1' : '0';
    el.dataset.loaded = '0';
    el.dataset.expanded = '0';
    el.title = row.tooltip || row.fsPath || row.key || row.name;
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', String(depth + 1));
    if (row.isDirectory) el.setAttribute('aria-expanded', 'false');

    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    spacer.style.setProperty('--depth', String(depth));
    el.appendChild(spacer);

    const twisty = document.createElement('button');
    twisty.className = row.isDirectory ? 'twisty folder' : 'twisty';
    twisty.tabIndex = -1;
    twisty.setAttribute('aria-label', row.isDirectory ? '展开或折叠' : '');
    twisty.addEventListener('click', event => {
      event.stopPropagation();
      if (row.isDirectory) toggle(row.id);
    });
    el.appendChild(twisty);

    el.appendChild(iconFor(row));
    el.appendChild(span('label', row.name));
    renderMetadata(row, el);

    el.addEventListener('click', () => {
      select(row.id);
      if (row.isDirectory) toggle(row.id);
      else post('open', { id: row.id });
    });
    el.addEventListener('dblclick', () => {
      if (!row.isDirectory) post('open', { id: row.id });
    });
    el.addEventListener('contextmenu', event => showMenu(event, row));
    return el;
  }

  function loadingElement(parentId, depth) {
    const el = document.createElement('div');
    el.className = 'loading-row';
    el.dataset.loadingFor = parentId;
    el.dataset.depth = String(depth + 1);
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    spacer.style.setProperty('--depth', String(depth + 1));
    el.appendChild(spacer);
    el.appendChild(span('comment', '载入中...'));
    return el;
  }

  function depthOf(element) {
    return Number(element?.dataset.depth || 0);
  }

  function removeDescendants(element) {
    const depth = depthOf(element);
    let next = element.nextElementSibling;
    while (next && depthOf(next) > depth) {
      const remove = next;
      next = next.nextElementSibling;
      if (remove.dataset.id) rows.delete(remove.dataset.id);
      remove.remove();
    }
  }

  function setExpanded(element, expanded) {
    element.dataset.expanded = expanded ? '1' : '0';
    element.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const twisty = element.querySelector('.twisty.folder');
    if (twisty) twisty.classList.toggle('expanded', expanded);
  }

  function toggle(id) {
    const element = rows.get(id);
    if (!element || element.dataset.directory !== '1') return;
    const expanded = element.dataset.expanded === '1';
    if (expanded) {
      removeDescendants(element);
      setExpanded(element, false);
      element.dataset.loaded = '0';
      return;
    }
    setExpanded(element, true);
    if (element.dataset.loaded === '1') return;
    const loading = loadingElement(id, depthOf(element));
    element.after(loading);
    post('children', { id });
  }

  function select(id) {
    if (selectedId && rows.has(selectedId)) rows.get(selectedId).classList.remove('selected');
    selectedId = id;
    const element = rows.get(id);
    if (element) element.classList.add('selected');
  }

  function insertChildren(parentId, dataRows) {
    const parent = rows.get(parentId);
    if (!parent) return;
    const loading = Array.from(tree.querySelectorAll('[data-loading-for]'))
      .find(element => element.dataset.loadingFor === parentId);
    if (loading) loading.remove();
    removeDescendants(parent);
    const depth = depthOf(parent) + 1;
    let anchor = parent;
    for (const row of dataRows || []) {
      const element = rowElement(row, depth);
      anchor.after(element);
      rows.set(row.id, element);
      anchor = element;
    }
    parent.dataset.loaded = '1';
    setExpanded(parent, true);
  }

  function updateRow(row) {
    const existing = rows.get(row.id);
    if (!existing) return;
    const depth = depthOf(existing);
    const replacement = rowElement(row, depth);
    replacement.dataset.loaded = existing.dataset.loaded || '0';
    replacement.dataset.expanded = existing.dataset.expanded || '0';
    if (replacement.dataset.expanded === '1') setExpanded(replacement, true);
    existing.replaceWith(replacement);
    rows.set(row.id, replacement);
    if (row.id === selectedId) replacement.classList.add('selected');
  }

  function setRoots(dataRows, empty) {
    rows.clear();
    clear(tree);
    if (empty) {
      const status = document.createElement('div');
      status.className = 'status';
      status.textContent = '未找到解包目录';
      tree.appendChild(status);
      return;
    }
    for (const row of dataRows || []) {
      const element = rowElement(row, 0);
      tree.appendChild(element);
      rows.set(row.id, element);
    }
  }

  function showMenu(event, row) {
    event.preventDefault();
    select(row.id);
    const menu = document.createElement('div');
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.style.zIndex = '1000';
    menu.style.minWidth = '128px';
    menu.style.padding = '4px 0';
    menu.style.background = 'var(--vscode-menu-background, var(--vscode-editorWidget-background))';
    menu.style.color = 'var(--vscode-menu-foreground, var(--vscode-foreground))';
    menu.style.border = '1px solid var(--vscode-menu-border, var(--vscode-panel-border))';
    menu.style.boxShadow = '0 3px 8px rgba(0,0,0,.35)';
    const addItem = (label, action) => {
      const item = document.createElement('button');
      item.textContent = label;
      item.style.display = 'block';
      item.style.width = '100%';
      item.style.textAlign = 'left';
      item.style.border = '0';
      item.style.padding = '4px 12px';
      item.style.background = 'transparent';
      item.style.color = 'inherit';
      item.style.font = 'inherit';
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--vscode-menu-selectionBackground)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      item.addEventListener('click', () => {
        menu.remove();
        action();
      });
      menu.appendChild(item);
    };
    const lowerName = row.name.toLowerCase();
    if (!row.isDirectory) addItem('打开', () => post('open', { id: row.id }));
    if (!row.isDirectory && lowerName.endsWith('.ani')) {
      addItem('预览 ANI', () => post('previewAni', { id: row.id }));
      addItem('ANI 编辑器', () => post('openAniEditor', { id: row.id }));
    }
    if (!row.isDirectory && lowerName.endsWith('.aic')) {
      addItem('预览编辑 APC', () => post('openAicEditor', { id: row.id }));
    }
    addItem('编辑路径注释', () => post('editComment', { id: row.id }));
    addItem('复制路径', () => post('copy', { id: row.id }));
    if (row.key) addItem('添加到书签', () => post('bookmark', { id: row.id }));
    document.body.appendChild(menu);
    const close = () => {
      menu.remove();
      window.removeEventListener('click', close, true);
      window.removeEventListener('blur', close, true);
    };
    setTimeout(() => {
      window.addEventListener('click', close, true);
      window.addEventListener('blur', close, true);
    }, 0);
  }

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'roots') {
      setRoots(message.rows || [], !!message.empty);
      return;
    }
    if (message.type === 'children') {
      insertChildren(message.id, message.rows || []);
      return;
    }
    if (message.type === 'rows') {
      for (const row of message.rows || []) updateRow(row);
    }
  });

  window.addEventListener('keydown', event => {
    if (!selectedId) return;
    const current = rows.get(selectedId);
    if (!current) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (current.dataset.directory === '1') toggle(selectedId);
      else post('open', { id: selectedId });
    } else if (event.key === 'ArrowRight' && current.dataset.directory === '1') {
      event.preventDefault();
      if (current.dataset.expanded !== '1') toggle(selectedId);
    } else if (event.key === 'ArrowLeft' && current.dataset.directory === '1') {
      event.preventDefault();
      if (current.dataset.expanded === '1') toggle(selectedId);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const all = Array.from(tree.querySelectorAll('.row'));
      const index = all.indexOf(current);
      const next = all[index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next?.dataset.id) {
        select(next.dataset.id);
        next.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  post('ready');
})();
