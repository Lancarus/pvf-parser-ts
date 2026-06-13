(function () {
  const vscode = acquireVsCodeApi();
  const tree = document.getElementById('tree');
  const cfg = window.__PVF_UNPACK_CONFIG__ || {};
  const hoverCfg = window.__PVF_UNPACK_HOVER__ || {};
  const rows = new Map();
  const childrenCache = new Map();
  const pendingChildRequests = new Set();
  const pendingChildLoadingTimers = new Map();
  const previewCache = new Map();
  const pendingPreviewRequests = new Map();
  const pendingPreviewTimers = new Map();
  const postedPreviewRequests = new Map();
  let selectedId = '';
  let pendingReveal = null;
  let hoverTimer = 0;
  let closeTimer = 0;
  let hoverRequestId = 0;
  let hoverTargetId = '';
  let hoverPoint = { x: 0, y: 0 };
  let pointerInPreview = false;
  let previewEl;

  function previewLocation() {
    if (hoverCfg.location === 'inline') return 'inline';
    if (hoverCfg.location === 'editorPanel') return 'editorPanel';
    return 'nativeTooltip';
  }

  function post(type, payload = {}) {
    vscode.postMessage({ type, ...payload });
  }

  function sameReveal(left, right) {
    if (!left || !right) return false;
    return String(left.targetId || '') === String(right.targetId || '')
      && String(left.key || '') === String(right.key || '')
      && String(left.fsPath || '') === String(right.fsPath || '');
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

  function previewRoot() {
    if (previewEl) return previewEl;
    previewEl = document.createElement('div');
    previewEl.className = 'hover-preview hidden';
    previewEl.setAttribute('role', 'tooltip');
    previewEl.addEventListener('pointerenter', () => {
      pointerInPreview = true;
      cancelClosePreview();
    });
    previewEl.addEventListener('pointerleave', () => {
      pointerInPreview = false;
      scheduleClosePreview();
    });
    previewEl.addEventListener('wheel', event => {
      event.stopPropagation();
    }, { passive: true });
    previewEl.addEventListener('click', event => {
      const skillTarget = event.target && event.target.closest ? event.target.closest('[data-skill-key]') : null;
      if (!skillTarget) return;
      event.preventDefault();
      const rawCode = Number(skillTarget.getAttribute('data-skill-code') || '');
      post('openPreviewSkill', {
        id: hoverTargetId,
        key: skillTarget.getAttribute('data-skill-key') || '',
        code: Number.isFinite(rawCode) ? rawCode : undefined,
      });
    });
    document.body.appendChild(previewEl);
    return previewEl;
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
    if (row.skillKind) return `item-name skill-name skill-${row.skillKind}`;
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
    if (cfg.showItemName !== false && row.skillClassText) {
      meta.appendChild(span('skill-class', row.skillClassText));
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
    el.dataset.key = row.key || '';
    el.dataset.name = row.name || '';
    el.dataset.depth = String(depth);
    el.dataset.directory = row.isDirectory ? '1' : '0';
    el.dataset.loaded = '0';
    el.dataset.expanded = '0';
    const tooltipText = row.tooltip || row.fsPath || row.key || row.name;
    el.dataset.tooltip = tooltipText;
    el.title = tooltipText;
    el.setAttribute('aria-label', tooltipText);
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
      closePreview();
      select(row.id);
      if (row.isDirectory) toggle(row.id);
      else if (previewCandidateLevel(row)) post('showPreview', { id: row.id });
      else post('open', { id: row.id });
    });
    el.addEventListener('dblclick', () => {
      if (!row.isDirectory) {
        if (previewCandidateLevel(row)) post('showPreview', { id: row.id });
        else post('open', { id: row.id });
      }
    });
    el.addEventListener('contextmenu', event => {
      closePreview();
      showMenu(event, row);
    });
    el.addEventListener('pointerenter', event => schedulePreview(row, event));
    el.addEventListener('pointermove', event => {
      hoverPoint = { x: event.clientX, y: event.clientY };
    });
    el.addEventListener('pointerleave', () => {
      if (hoverTargetId === row.id) scheduleClosePreview();
    });
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

  function removeDescendants(element, options = {}) {
    const clearPreview = options.clearPreview === true;
    const clearPending = options.clearPending === true;
    const depth = depthOf(element);
    let next = element.nextElementSibling;
    while (next && depthOf(next) > depth) {
      const remove = next;
      next = next.nextElementSibling;
      if (remove.dataset.id) {
        rows.delete(remove.dataset.id);
        if (clearPreview) previewCache.delete(remove.dataset.id);
        if (clearPending) {
          pendingPreviewRequests.delete(remove.dataset.id);
          clearPendingPreviewTimer(remove.dataset.id);
        }
      }
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
      closePreview();
      clearChildLoadingTimer(id);
      removeDescendants(element);
      setExpanded(element, false);
      element.dataset.loaded = childrenCache.has(id) ? '1' : '0';
      return;
    }
    setExpanded(element, true);
    if (childrenCache.has(id)) {
      renderChildRows(element, childrenCache.get(id));
      return;
    }
    if (element.dataset.loaded === '1') return;
    scheduleChildLoading(id, element);
    if (pendingChildRequests.has(id)) return;
    pendingChildRequests.add(id);
    post('children', { id });
  }

  function select(id) {
    if (selectedId && rows.has(selectedId)) rows.get(selectedId).classList.remove('selected');
    selectedId = id;
    const element = rows.get(id);
    if (element) element.classList.add('selected');
  }

  function removeLoading(parentId) {
    const loading = Array.from(tree.querySelectorAll('[data-loading-for]'))
      .find(element => element.dataset.loadingFor === parentId);
    if (loading) loading.remove();
  }

  function clearChildLoadingTimer(parentId) {
    const timer = pendingChildLoadingTimers.get(parentId);
    if (timer) clearTimeout(timer);
    pendingChildLoadingTimers.delete(parentId);
  }

  function scheduleChildLoading(parentId, parent) {
    clearChildLoadingTimer(parentId);
    const timer = setTimeout(() => {
      pendingChildLoadingTimers.delete(parentId);
      if (childrenCache.has(parentId)) return;
      if (!pendingChildRequests.has(parentId)) return;
      const current = rows.get(parentId);
      if (!current || current !== parent || current.dataset.expanded !== '1') return;
      removeLoading(parentId);
      current.after(loadingElement(parentId, depthOf(current)));
    }, 120);
    pendingChildLoadingTimers.set(parentId, timer);
  }

  function renderChildRows(parent, dataRows) {
    removeDescendants(parent);
    const depth = depthOf(parent) + 1;
    let anchor = parent;
    for (const row of dataRows || []) {
      const element = rowElement(row, depth);
      if (row.isDirectory && childrenCache.has(row.id)) element.dataset.loaded = '1';
      anchor.after(element);
      rows.set(row.id, element);
      anchor = element;
    }
    parent.dataset.loaded = '1';
    setExpanded(parent, true);
  }

  function insertChildren(parentId, dataRows) {
    const parent = rows.get(parentId);
    pendingChildRequests.delete(parentId);
    clearChildLoadingTimer(parentId);
    if (!parent) return;
    removeLoading(parentId);
    childrenCache.set(parentId, dataRows || []);
    parent.dataset.loaded = '1';
    if (parent.dataset.expanded === '1') renderChildRows(parent, dataRows);
    applyPendingReveal();
  }

  function updateRow(row) {
    const existing = rows.get(row.id);
    updateCachedChildRow(row);
    if (!existing) return;
    previewCache.delete(row.id);
    if (hoverTargetId === row.id && previewEl && !previewEl.classList.contains('hidden')) {
      scheduleClosePreview();
    }
    const depth = depthOf(existing);
    const replacement = rowElement(row, depth);
    replacement.dataset.loaded = row.isDirectory && childrenCache.has(row.id) ? '1' : (existing.dataset.loaded || '0');
    replacement.dataset.expanded = existing.dataset.expanded || '0';
    if (replacement.dataset.expanded === '1') setExpanded(replacement, true);
    existing.replaceWith(replacement);
    rows.set(row.id, replacement);
    if (row.id === selectedId) replacement.classList.add('selected');
  }

  function updateCachedChildRow(row) {
    for (const [parentId, cachedRows] of childrenCache) {
      const index = (cachedRows || []).findIndex(item => item && item.id === row.id);
      if (index < 0) continue;
      const nextRows = cachedRows.slice();
      nextRows[index] = row;
      childrenCache.set(parentId, nextRows);
      return;
    }
  }

  function setRoots(dataRows, empty) {
    rows.clear();
    childrenCache.clear();
    pendingChildRequests.clear();
    for (const id of Array.from(pendingChildLoadingTimers.keys())) clearChildLoadingTimer(id);
    previewCache.clear();
    for (const id of Array.from(pendingPreviewTimers.keys())) clearPendingPreviewTimer(id);
    pendingPreviewRequests.clear();
    closePreview();
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
    applyPendingReveal();
  }

  function reveal(message) {
    const next = {
      targetId: String(message.targetId || ''),
      pathIds: Array.isArray(message.pathIds) ? message.pathIds.map(String).filter(Boolean) : [],
      key: String(message.key || ''),
      fsPath: String(message.fsPath || ''),
    };
    if (!next.targetId || next.pathIds.length === 0) return;
    if (sameReveal(pendingReveal, next)) {
      applyPendingReveal();
      return;
    }
    pendingReveal = next;
    applyPendingReveal();
  }

  function applyPendingReveal() {
    if (!pendingReveal) return;
    const ids = pendingReveal.pathIds || [];
    if (ids.length === 0) return;
    if (!rows.has(ids[0])) return;

    for (let index = 0; index < ids.length - 1; index++) {
      const id = ids[index];
      const element = rows.get(id);
      if (!element || element.dataset.directory !== '1') return;
      if (element.dataset.expanded !== '1') setExpanded(element, true);
      if (childrenCache.has(id)) {
        if (!rows.has(ids[index + 1])) renderChildRows(element, childrenCache.get(id));
        continue;
      }
      if (element.dataset.loaded !== '1') scheduleChildLoading(id, element);
      if (!pendingChildRequests.has(id)) {
        pendingChildRequests.add(id);
        post('children', { id });
      }
      return;
    }

    const target = rows.get(pendingReveal.targetId);
    if (!target) return;
    closePreview();
    select(pendingReveal.targetId);
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    pendingReveal = null;
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
    if (!row.isDirectory && previewCandidateLevel(row)) {
      addItem('显示预览', () => post('showPreview', { id: row.id }));
    }
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

  function schedulePreview(row, event) {
    if (hoverCfg.enabled === false || row.isDirectory) return;
    const candidate = previewCandidateLevel(row);
    if (!candidate) return;
    const location = previewLocation();
    cancelClosePreview();
    hoverPoint = { x: event.clientX, y: event.clientY };
    hoverTargetId = row.id;
    if (hoverTimer) clearTimeout(hoverTimer);
    if (previewCache.has(row.id)) {
      const cached = previewCache.get(row.id);
      if (location === 'inline') {
        if (cached) renderPreview(cached);
        else hidePreviewSurface();
      } else if (location === 'editorPanel' && cached) {
        requestPanelPreview(row, false);
      } else if (location === 'nativeTooltip' && cached) {
        applyNativePreview(row.id, cached);
      }
      return;
    }

    if ((location === 'inline' || location === 'nativeTooltip') && !pendingPreviewRequests.has(row.id)) {
      const requestId = beginPreviewRequest(row.id);
      post('preview', { id: row.id, requestId, location });
    }

    hoverTimer = setTimeout(() => {
      if (hoverTargetId !== row.id) return;
      if (location === 'inline') {
        if (candidate === 'strong') showLoadingPreview(row);
        return;
      }
      if (location === 'nativeTooltip') return;
      requestPanelPreview(row, candidate === 'strong');
    }, Math.max(0, Number(hoverCfg.delayMs || 350)));
  }

  function cancelClosePreview() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = 0;
  }

  function scheduleClosePreview() {
    cancelClosePreview();
    closeTimer = setTimeout(() => {
      if (pointerInPreview) return;
      closePreview();
    }, 260);
  }

  function closePreview() {
    if (hoverTimer) clearTimeout(hoverTimer);
    cancelClosePreview();
    hoverTimer = 0;
    const id = hoverTargetId;
    hoverTargetId = '';
    pointerInPreview = false;
    const location = previewLocation();
    if (location === 'editorPanel' && id && postedPreviewRequests.get(id) !== pendingPreviewRequests.get(id)) {
      pendingPreviewRequests.delete(id);
      clearPendingPreviewTimer(id);
    }
    suppressNativeTitle(id, false);
    if (location === 'inline') hidePreviewSurface();
  }

  function hidePreviewSurface() {
    suppressNativeTitle(hoverTargetId, false);
    if (previewEl) previewEl.classList.add('hidden');
  }

  function previewCandidateLevel(row) {
    const key = String(row.key || '').toLowerCase();
    const name = String(row.name || '').toLowerCase();
    const target = key || name;
    if (target.endsWith('.equ') || target.endsWith('.stk') || target.endsWith('.shp') || target.endsWith('.qst') || target.endsWith('.skl')) return 'strong';
    if (/^clientonly\/skilltree\/.+_(sp|tp)\.co$/i.test(key)) return 'strong';
    if (/^clientonly\/skillshoptree(sp|tp)index\.co$/i.test(key)) return 'strong';
    if (/^etc\/pvpskilltree\/.+\.etc$/i.test(key)) return 'strong';
    if (target.endsWith('.co') || target.endsWith('.etc')) return 'weak';
    return '';
  }

  function rowDataFromElement(element) {
    if (!element?.dataset) return undefined;
    return {
      id: element.dataset.id || '',
      key: element.dataset.key || '',
      name: element.dataset.name || element.querySelector('.label')?.textContent || '',
      isDirectory: element.dataset.directory === '1',
    };
  }

  function suppressNativeTitle(id, suppress) {
    const element = id ? rows.get(id) : undefined;
    if (!element) return;
    if (suppress) {
      if (element.title) element.dataset.nativeTitle = element.title;
      element.removeAttribute('title');
      return;
    }
    if (element.dataset.nativeTitle) {
      element.title = element.dataset.nativeTitle;
      delete element.dataset.nativeTitle;
    } else if (!element.title && element.dataset.tooltip) {
      element.title = element.dataset.tooltip;
    }
  }

  function clearPendingPreviewTimer(id) {
    const timer = pendingPreviewTimers.get(id);
    if (timer) clearTimeout(timer);
    pendingPreviewTimers.delete(id);
  }

  function beginPreviewRequest(id) {
    const requestId = String(++hoverRequestId);
    pendingPreviewRequests.set(id, requestId);
    const timeout = setTimeout(() => {
      if (pendingPreviewRequests.get(id) !== requestId) return;
      pendingPreviewRequests.delete(id);
      postedPreviewRequests.delete(id);
      pendingPreviewTimers.delete(id);
      if (hoverTargetId === id && previewLocation() === 'inline') hidePreviewSurface();
    }, 8000);
    pendingPreviewTimers.set(id, timeout);
    return requestId;
  }

  function requestPanelPreview(row, showLoading) {
    if (pendingPreviewRequests.has(row.id)) return;
    const requestId = beginPreviewRequest(row.id);
    postedPreviewRequests.set(row.id, requestId);
    post('preview', {
      id: row.id,
      requestId,
      location: 'editorPanel',
      showLoading,
    });
  }

  function applyNativePreview(id, preview) {
    const element = rows.get(id);
    if (!element || !preview?.text) return;
    element.title = preview.text;
    element.dataset.nativeTitle = preview.text;
    element.setAttribute('aria-label', preview.text);
  }

  function showLoadingPreview(row) {
    const root = previewRoot();
    suppressNativeTitle(row.id, true);
    root.className = 'hover-preview';
    clear(root);
    const frame = document.createElement('div');
    frame.className = 'preview-frame';
    const loading = document.createElement('div');
    loading.className = 'preview-loading';
    loading.textContent = '载入预览...';
    frame.appendChild(loading);
    root.appendChild(frame);
    positionPreview(root);
  }

  function renderPreview(preview) {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = 0;
    if (!preview) {
      hidePreviewSurface();
      return;
    }
    const root = previewRoot();
    suppressNativeTitle(hoverTargetId, true);
    const split = false;
    root.className = previewClassName(preview, split);
    clear(root);
    const primaryFrame = document.createElement('div');
    primaryFrame.className = 'preview-frame preview-frame-primary';
    appendPreviewContent(primaryFrame, preview, preview.sections || [], true);
    root.appendChild(primaryFrame);
    positionPreview(root);
  }

  function previewClassName(preview, split) {
    return `hover-preview${preview.kind === 'skill' ? ' skill' : ''}${preview.kind === 'skillTree' ? ' skill-tree' : ''}${split ? ' split' : ''}`;
  }

  function appendPreviewContent(frame, preview, sections, primary) {
    if (primary) {
      const head = document.createElement('div');
      head.className = 'preview-head';
      const icon = document.createElement('div');
      icon.className = 'preview-icon';
      if (preview.icon?.src) {
        const img = document.createElement('img');
        img.src = preview.icon.src;
        img.alt = '';
        img.draggable = false;
        icon.appendChild(img);
      }
      head.appendChild(icon);

      const titleBlock = document.createElement('div');
      const title = document.createElement('div');
      title.className = `preview-title${typeof preview.rarity === 'number' ? ` rarity-${preview.rarity}` : ''}`;
      title.textContent = preview.title || preview.key || '';
      titleBlock.appendChild(title);
      const subtitleParts = [preview.subtitle, typeof preview.itemCode === 'number' ? `<${preview.itemCode}>` : '', preview.rarityLabel].filter(Boolean);
      if (subtitleParts.length) {
        const subtitle = document.createElement('div');
        subtitle.className = 'preview-subtitle';
        subtitle.textContent = subtitleParts.join('  ');
        titleBlock.appendChild(subtitle);
      }
      if (preview.badges?.length) {
        const badges = document.createElement('div');
        badges.className = 'preview-badges';
        for (const badgeText of preview.badges) {
          const badge = document.createElement('span');
          badge.className = 'preview-badge';
          badge.textContent = badgeText;
          badges.appendChild(badge);
        }
        titleBlock.appendChild(badges);
      }
      head.appendChild(titleBlock);
      frame.appendChild(head);

      if (preview.key) {
        const pathNode = document.createElement('div');
        pathNode.className = 'preview-path';
        pathNode.textContent = preview.key;
        frame.appendChild(pathNode);
      }
      frame.appendChild(separator());

      if (preview.message) {
        const msg = document.createElement('div');
        msg.className = 'preview-line';
        msg.textContent = preview.message;
        frame.appendChild(msg);
      }

      if (preview.miniMap?.points?.length) {
        frame.appendChild(renderMiniMap(preview.miniMap.points));
        frame.appendChild(separator());
      }
      if (preview.skillTrees?.length) {
        frame.appendChild(renderSkillTrees(preview.skillTrees));
      }
    }
    for (const section of sections) {
      frame.appendChild(renderSection(section));
    }
  }

  function separator() {
    const sep = document.createElement('div');
    sep.className = 'preview-sep';
    return sep;
  }

  function renderSection(section) {
    const wrap = document.createElement('section');
    wrap.className = `preview-section${section.tone ? ` ${section.tone}` : ''}`;
    const title = document.createElement('div');
    title.className = 'preview-section-title';
    title.textContent = section.title || '';
    wrap.appendChild(title);
    for (const field of section.fields || []) {
      const row = document.createElement('div');
      row.className = 'preview-field';
      const label = document.createElement('div');
      label.className = 'preview-field-label';
      label.textContent = field.label || '';
      const value = document.createElement('div');
      value.className = `preview-field-value${field.tone ? ` ${field.tone}` : ''}`;
      value.textContent = field.value || '';
      row.appendChild(label);
      row.appendChild(value);
      wrap.appendChild(row);
    }
    for (const lineText of section.lines || []) {
      const line = document.createElement('div');
      line.className = 'preview-line';
      line.textContent = lineText;
      wrap.appendChild(line);
    }
    for (const table of section.tables || []) {
      wrap.appendChild(renderTable(table));
    }
    for (const entry of section.entries || []) {
      wrap.appendChild(renderEntry(entry));
    }
    return wrap;
  }

  function renderTable(table) {
    const fragment = document.createDocumentFragment();
    if (table.caption) {
      const caption = document.createElement('div');
      caption.className = 'preview-table-caption';
      caption.textContent = table.caption;
      fragment.appendChild(caption);
    }
    const wrap = document.createElement('div');
    wrap.className = 'preview-table-wrap';
    const element = document.createElement('table');
    element.className = 'preview-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const headerText of table.headers || []) {
      const th = document.createElement('th');
      th.textContent = headerText || '';
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    element.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of table.rows || []) {
      const tr = document.createElement('tr');
      for (const cellText of row || []) {
        const td = document.createElement('td');
        td.textContent = cellText || '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    element.appendChild(tbody);
    wrap.appendChild(element);
    fragment.appendChild(wrap);
    return fragment;
  }

  function renderEntry(entry) {
    const row = document.createElement('div');
    row.className = 'preview-entry';
    const icon = document.createElement('div');
    icon.className = 'preview-entry-icon';
    if (entry.icon?.src) {
      const img = document.createElement('img');
      img.src = entry.icon.src;
      img.alt = '';
      img.draggable = false;
      icon.appendChild(img);
    }
    row.appendChild(icon);

    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'preview-entry-name';
    const prefix = typeof entry.code === 'number' ? `${entry.code}  ` : '';
    const qty = typeof entry.quantity === 'number' ? ` x${entry.quantity}` : '';
    name.textContent = `${prefix}${entry.name || (entry.unresolved ? '未解析' : '')}${qty}`;
    body.appendChild(name);

    const details = [entry.branch, typeof entry.x === 'number' && typeof entry.y === 'number' ? `坐标 ${entry.x}, ${entry.y}` : '', entry.common ? '通用' : '', entry.key, entry.detail]
      .filter(Boolean)
      .join('  ');
    if (details) {
      const detail = document.createElement('div');
      detail.className = 'preview-entry-detail';
      detail.textContent = details;
      body.appendChild(detail);
    }
    row.appendChild(body);
    return row;
  }

  function renderMiniMap(points) {
    const map = document.createElement('div');
    map.className = 'preview-minimap';
    const xs = points.map(point => Number(point.x)).filter(Number.isFinite);
    const ys = points.map(point => Number(point.y)).filter(Number.isFinite);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    for (const point of points) {
      const dot = document.createElement('span');
      dot.className = `preview-map-point${point.resolved ? '' : ' unresolved'}${point.common ? ' common' : ''}`;
      dot.style.left = `${8 + ((Number(point.x) - minX) / spanX) * 84}%`;
      dot.style.top = `${10 + ((Number(point.y) - minY) / spanY) * 80}%`;
      dot.title = point.label || '';
      map.appendChild(dot);
    }
    return map;
  }

  function renderSkillTrees(groups) {
    const list = document.createElement('div');
    list.className = 'skill-tree-list';
    for (const group of groups || []) {
      list.appendChild(renderSkillTreeGroup(group));
    }
    return list;
  }

  function renderSkillTreeGroup(group) {
    const card = document.createElement('section');
    card.className = 'skill-tree-card';
    const title = document.createElement('div');
    title.className = 'skill-tree-title';
    title.textContent = group.title || [group.jobLabel, group.branchLabel].filter(Boolean).join(' / ') || '技能树';
    title.title = title.textContent;
    card.appendChild(title);

    const canvas = document.createElement('div');
    canvas.className = 'skill-tree-canvas';
    const nodes = group.nodes || [];
    canvas.style.setProperty('--skill-tree-height', `${skillTreeHeight(nodes)}px`);
    const positions = skillTreePositions(nodes);
    canvas.appendChild(renderSkillTreeLines(nodes, positions));
    nodes.forEach((node, index) => {
      canvas.appendChild(renderSkillTreeNode(node, positions.get(nodePositionKey(node, index))));
    });
    card.appendChild(canvas);
    return card;
  }

  function renderSkillTreeLines(nodes, positions) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'skill-tree-lines');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const byCode = new Map();
    nodes.forEach((node, index) => {
      const pos = positions.get(nodePositionKey(node, index));
      if (pos && typeof node.code === 'number') byCode.set(node.code, pos);
    });
    nodes.forEach((node, index) => {
      const from = positions.get(nodePositionKey(node, index));
      if (!from) return;
      for (const next of node.nextSkills || []) {
        const to = byCode.get(next);
        if (!to) continue;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'skill-tree-line');
        line.setAttribute('x1', trimNumber(from.left));
        line.setAttribute('y1', trimNumber(from.top));
        line.setAttribute('x2', trimNumber(to.left));
        line.setAttribute('y2', trimNumber(to.top));
        svg.appendChild(line);
      }
    });
    return svg;
  }

  function renderSkillTreeNode(node, position) {
    const element = node.key ? document.createElement('button') : document.createElement('span');
    element.className = `skill-tree-node${node.key ? ' resolved' : ''}${node.unresolved ? ' unresolved' : ''}${node.common ? ' common' : ''}`;
    const pos = position || { left: 8, top: 8 };
    element.style.setProperty('--node-left', `${trimNumber(pos.left)}%`);
    element.style.setProperty('--node-top', `${trimNumber(pos.top)}%`);
    element.title = skillTreeNodeLabel(node);
    if (node.key) {
      element.type = 'button';
      element.dataset.skillKey = node.key;
      element.dataset.skillCode = String(node.code);
    }
    if (node.icon?.src) {
      const img = document.createElement('img');
      img.src = node.icon.src;
      img.alt = '';
      img.draggable = false;
      element.appendChild(img);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'skill-tree-fallback';
      fallback.textContent = String(node.code);
      element.appendChild(fallback);
    }
    return element;
  }

  function skillTreePositions(nodes) {
    const positioned = (nodes || []).filter(node => Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y)));
    const xs = positioned.map(node => Number(node.x));
    const ys = positioned.map(node => Number(node.y));
    const minX = xs.length ? Math.min(...xs) : 0;
    const maxX = xs.length ? Math.max(...xs) : 1;
    const minY = ys.length ? Math.min(...ys) : 0;
    const maxY = ys.length ? Math.max(...ys) : 1;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const fallbackColumns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, (nodes || []).length))));
    const map = new Map();
    (nodes || []).forEach((node, index) => {
      if (Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y))) {
        map.set(nodePositionKey(node, index), {
          left: 6 + ((Number(node.x) - minX) / spanX) * 88,
          top: 8 + ((Number(node.y) - minY) / spanY) * 82,
        });
        return;
      }
      const col = index % fallbackColumns;
      const row = Math.floor(index / fallbackColumns);
      map.set(nodePositionKey(node, index), {
        left: 8 + (col / Math.max(1, fallbackColumns - 1)) * 84,
        top: 12 + row * 12,
      });
    });
    return map;
  }

  function skillTreeHeight(nodes) {
    const ys = (nodes || []).map(node => Number(node.y)).filter(Number.isFinite);
    if (!ys.length) return Math.min(620, Math.max(240, Math.ceil((nodes || []).length / 8) * 62));
    const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));
    return Math.min(720, Math.max(240, Math.round(spanY + 120)));
  }

  function nodePositionKey(node, index) {
    return `${index}:${node.code}`;
  }

  function skillTreeNodeLabel(node) {
    return [
      `ID: ${node.code}`,
      node.name ? `名称: ${node.name}` : '',
      node.key || '',
    ].filter(Boolean).join('\n');
  }

  function trimNumber(value) {
    return Number(value).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  function rowContentRight(element) {
    if (!element) return 0;
    let right = element.getBoundingClientRect().left;
    for (const child of Array.from(element.children)) {
      const rect = child.getBoundingClientRect();
      if (rect.width > 0) right = Math.max(right, rect.right);
    }
    return right;
  }

  function positionPreview(root) {
    root.classList.remove('hidden');
    const margin = 8;
    root.style.left = '0px';
    root.style.top = '0px';
    const rect = root.getBoundingClientRect();
    const row = rows.get(hoverTargetId);
    const rowRect = row?.getBoundingClientRect();
    const anchorRight = rowContentRight(row);
    const preferredLeft = anchorRight + 12;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const left = Math.min(Math.max(margin, preferredLeft), maxLeft);
    const preferredTop = rowRect ? rowRect.top : hoverPoint.y;
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const top = Math.min(Math.max(margin, preferredTop), maxTop);
    root.style.left = `${Math.max(margin, left)}px`;
    root.style.top = `${Math.max(margin, top)}px`;
  }

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'roots') {
      setRoots(message.rows || [], !!message.empty);
      return;
    }
    if (message.type === 'reveal') {
      reveal(message);
      return;
    }
    if (message.type === 'children') {
      insertChildren(message.id, message.rows || []);
      return;
    }
    if (message.type === 'rows') {
      for (const row of message.rows || []) updateRow(row);
      return;
    }
    if (message.type === 'preview') {
      const id = String(message.id || '');
      const requestId = String(message.requestId || '');
      if (pendingPreviewRequests.get(id) !== requestId) return;
      pendingPreviewRequests.delete(id);
      postedPreviewRequests.delete(id);
      clearPendingPreviewTimer(id);
      previewCache.set(id, message.preview || null);
      if (previewLocation() === 'nativeTooltip') applyNativePreview(id, message.preview);
      if (id !== hoverTargetId) return;
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = 0;
      if (previewLocation() === 'inline') renderPreview(message.preview);
    }
  });

  window.addEventListener('scroll', event => {
    if (previewEl && previewEl.contains(event.target)) return;
    closePreview();
  }, true);
  window.addEventListener('blur', closePreview, true);
  window.addEventListener('resize', closePreview, true);

  window.addEventListener('keydown', event => {
    if (!selectedId) return;
    const current = rows.get(selectedId);
    if (!current) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (current.dataset.directory === '1') toggle(selectedId);
      else {
        const row = rowDataFromElement(current);
        if (row && previewCandidateLevel(row)) post('showPreview', { id: selectedId });
        else post('open', { id: selectedId });
      }
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
