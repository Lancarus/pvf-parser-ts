import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { parsePvfWebApiFileData, parsePvfWebApiRootSections } from './scriptParser';
import { readPvfWebApiSettings } from './settings';
import { failure, success, successNoData, writeJson, writeText } from './result';
import { PvfWebApiRouteContext, PvfWebApiServiceDeps, PvfWebApiSettings, PvfUtilityResult } from './types';
import { PvfWebApiWorkspace } from './workspace';

type Handler = (ctx: PvfWebApiRouteContext) => Promise<PvfUtilityResult | { rawText: string }>;

const MUTATION_ACTIONS = new Set(['importfile', 'importfiles', 'deletefile', 'deletefiles']);

function queryFirst(url: URL, name: string): string {
  const lower = name.toLowerCase();
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === lower) return value;
  }
  return '';
}

function jsonBody(bodyText: string): unknown {
  if (!bodyText.trim()) return undefined;
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('请求内容过大'));
        return;
      }
      chunks.push(buf);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function extractFilePathsFromBody(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => typeof item === 'string' ? item : (item && typeof item === 'object' ? String((item as any).FilePath || (item as any).filePath || '') : ''))
      .filter(Boolean);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const raw = obj.FilePaths || obj.filePaths || obj.paths || obj.Paths;
    if (Array.isArray(raw)) return raw.map(item => String(item || '')).filter(Boolean);
    if (typeof raw === 'string') return raw.split(/[,\n;]/).map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function extractItemCodesBody(value: unknown): { lstNames: string[]; itemCodes: number[] } {
  if (Array.isArray(value)) {
    if (value.every(item => typeof item === 'number' || typeof item === 'string')) {
      return { lstNames: ['equipment', 'stackable'], itemCodes: value.map(Number).filter(Number.isSafeInteger) };
    }
    const itemCodes: number[] = [];
    const lstNames: string[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const code = Number(obj.ItemCode || obj.itemCode || obj.Code || obj.code);
      if (Number.isSafeInteger(code)) itemCodes.push(code);
      const names = obj.LstNames || obj.lstNames || obj.LstName || obj.lstName;
      if (typeof names === 'string') lstNames.push(...names.split(/[,\s;]+/).filter(Boolean));
    }
    return { lstNames: lstNames.length ? lstNames : ['equipment', 'stackable'], itemCodes };
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const names = obj.LstNames || obj.lstNames || obj.LstName || obj.lstName;
    const codes = obj.ItemCodes || obj.itemCodes || obj.Codes || obj.codes;
    return {
      lstNames: typeof names === 'string'
        ? names.split(/[,\s;]+/).filter(Boolean)
        : Array.isArray(names) ? names.map(String).filter(Boolean) : ['equipment', 'stackable'],
      itemCodes: Array.isArray(codes) ? codes.map(Number).filter(Number.isSafeInteger) : [],
    };
  }
  return { lstNames: ['equipment', 'stackable'], itemCodes: [] };
}

function normalizeRoute(url: URL): string | undefined {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3) return undefined;
  if (parts[0].toLowerCase() !== 'api') return undefined;
  const base = parts[1].toLowerCase();
  if (base !== 'pvfutiltiy' && base !== 'pvfutility') return undefined;
  return parts[2];
}

function tryListen(port: number, host: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

export class PvfWebApiServer implements vscode.Disposable {
  private readonly workspace: PvfWebApiWorkspace;
  private readonly status: vscode.StatusBarItem;
  private server: http.Server | undefined;
  private settings: PvfWebApiSettings = readPvfWebApiSettings();
  private activePort: number | undefined;
  private activeHost = '127.0.0.1';
  private lastError = '';
  private handlers: Map<string, Handler>;

  constructor(private readonly deps: PvfWebApiServiceDeps) {
    this.workspace = new PvfWebApiWorkspace(deps.context);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.status.command = 'pvf.webApi.copyBaseUrl';
    this.status.show();
    this.handlers = this.createHandlers();
    this.updateStatus();
  }

  dispose(): void {
    this.status.dispose();
    void this.stop();
  }

  baseUrl(): string | undefined {
    return this.activePort ? `http://127.0.0.1:${this.activePort}` : undefined;
  }

  isRunning(): boolean {
    return !!this.server;
  }

  async autoStart(): Promise<void> {
    this.settings = readPvfWebApiSettings();
    if (!this.settings.enabled || !this.settings.autoStart) {
      this.updateStatus();
      return;
    }
    try {
      await this.start();
    } catch (err: any) {
      this.lastError = String(err?.message || err);
      this.deps.output.appendLine(`[PVF WebApi] auto start failed: ${this.lastError}`);
      this.updateStatus();
    }
  }

  async start(): Promise<void> {
    this.settings = readPvfWebApiSettings();
    if (!this.settings.enabled) throw new Error('PVF WebApi 已在设置中禁用');
    if (this.server) return;
    await this.workspace.load(this.settings);

    const hosts = this.settings.bindHost === 'loopback'
      ? ['127.0.0.1']
      : [this.settings.bindHost];
    let lastErr: unknown;
    for (let offset = 0; offset < this.settings.maxPortScanCount; offset++) {
      const port = this.settings.preferredPort + offset;
      for (const host of hosts) {
        let candidate: http.Server | undefined;
        try {
          candidate = await tryListen(port, host);
          candidate.on('request', (req, res) => void this.handleRequest(req, res));
          this.server = candidate;
          this.activePort = port;
          this.activeHost = host;
          this.lastError = '';
          this.deps.output.appendLine(`[PVF WebApi] listening on http://${host}:${port}, root=${this.workspace.getRoot()}`);
          this.updateStatus();
          return;
        } catch (err: any) {
          lastErr = err;
          if (candidate) await closeServer(candidate).catch(() => undefined);
          if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') throw err;
        }
      }
    }
    throw new Error(`无法在端口 ${this.settings.preferredPort}-${this.settings.preferredPort + this.settings.maxPortScanCount - 1} 启动 PVF WebApi: ${String((lastErr as any)?.message || lastErr)}`);
  }

  async stop(): Promise<void> {
    const current = this.server;
    this.server = undefined;
    this.activePort = undefined;
    if (current) {
      await closeServer(current).catch(err => {
        this.deps.output.appendLine(`[PVF WebApi] stop failed: ${String(err?.message || err)}`);
      });
      this.deps.output.appendLine('[PVF WebApi] stopped');
    }
    this.updateStatus();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async copyBaseUrl(): Promise<void> {
    const url = this.baseUrl();
    if (!url) {
      vscode.window.showWarningMessage('PVF WebApi 尚未启动');
      return;
    }
    await vscode.env.clipboard.writeText(url);
    vscode.window.showInformationMessage(`已复制 PVF WebApi 地址: ${url}`);
  }

  async selectUnpackRoot(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: '选择解包 PVF 根目录',
    });
    const folder = picked?.[0];
    if (!folder) return;
    await vscode.workspace.getConfiguration().update('pvf.webApi.unpackRoot', folder.fsPath, vscode.ConfigurationTarget.Workspace);
    await this.restart().catch(err => vscode.window.showErrorMessage(String(err?.message || err)));
  }

  async diagnostics(): Promise<void> {
    if (!this.server) await this.start();
    const url = this.baseUrl();
    if (!url) return;
    const targets = [
      `${url}/Api/PvfUtiltiy/getVersion`,
      `${url}/Api/PvfUtility/getPvfRootDirectory`,
      `${url}/Api/PvfUtiltiy/GetFileList?dirName=equipment&returnType=0&fileType=.lst`,
    ];
    this.deps.output.show(true);
    for (const target of targets) {
      const body = await new Promise<string>((resolve) => {
        http.get(target, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(Buffer.from(chunk)));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', err => resolve(`ERROR: ${String(err.message || err)}`));
      });
      this.deps.output.appendLine(`[PVF WebApi diagnostics] ${target}`);
      this.deps.output.appendLine(body.slice(0, 1000));
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const method = req.method || 'GET';
    try {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const action = normalizeRoute(url);
      if (!action) {
        await this.handleLegacyOrUnknown(req, res, url);
        return;
      }

      const bodyText = method === 'POST' ? await readRequestBody(req, this.settings.maxImportBytes) : '';
      const handler = this.handlers.get(action.toLowerCase());
      if (!handler) {
        writeJson(res, failure(`未实现的接口: ${action}`));
        this.log(method, url.pathname, started, true);
        return;
      }
      await this.workspace.load(this.settings);
      const result = await handler({ req, bodyText, url, action });
      if ('rawText' in result) writeText(res, result.rawText);
      else writeJson(res, result);
      this.log(method, url.pathname, started, result && !('rawText' in result) && result.IsError);
    } catch (err: any) {
      const msg = String(err?.message || err);
      this.lastError = msg;
      writeJson(res, failure(msg));
      this.log(method, req.url || '', started, true);
      this.updateStatus();
    }
  }

  private async handleLegacyOrUnknown(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.settings.enableLegacyShortEndpoints) {
      writeJson(res, failure(`未知接口: ${url.pathname}`), 404);
      return;
    }
    await this.workspace.load(this.settings);
    if (url.pathname === '/' || url.pathname === '/files') {
      writeText(res, this.workspace.getRootDirectories().join('\n'));
      return;
    }
    if (url.pathname === '/list') {
      const dir = queryFirst(url, 'path');
      writeText(res, this.workspace.getFileList(dir, '').join('\n'));
      return;
    }
    if (url.pathname === '/file') {
      const filePath = queryFirst(url, 'filePath');
      writeText(res, await this.workspace.readText(filePath, this.settings.maxFileReadBytes));
      return;
    }
    writeJson(res, failure(`未知接口: ${url.pathname}`), 404);
  }

  private createHandlers(): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const add = (name: string, handler: Handler) => handlers.set(name.toLowerCase(), handler);

    add('getVersion', async () => success(`PVF Code ${this.deps.extensionVersion} WebApiCompat`));
    add('GetPvfPackFilePath', async () => success(this.workspace.getRoot()));
    add('getPvfRootDirectory', async () => success(this.workspace.getRootDirectories()));
    add('GetFileList', async ({ url }) => {
      const dirName = queryFirst(url, 'dirName');
      const returnType = queryFirst(url, 'returnType');
      const fileType = queryFirst(url, 'fileType');
      const files = this.workspace.getFileList(dirName, fileType);
      return success(returnType === '1' ? files.join('\r\n') : files);
    });
    add('GetFileContent', async ({ url }) => {
      const filePath = queryFirst(url, 'filePath');
      if (!await this.workspace.fileExists(filePath)) return failure('文件不存在');
      return success(await this.workspace.readWebApiText(filePath, this.settings.maxFileReadBytes));
    });
    add('GetFileContents', async ({ bodyText }) => {
      const paths = extractFilePathsFromBody(jsonBody(bodyText));
      if (!paths.length) return failure('请求内容不能为空', { FileContentData: {} });
      const FileContentData: Record<string, string> = {};
      for (const item of paths) {
        if (!await this.workspace.fileExists(item)) continue;
        FileContentData[this.workspace.normalizePath(item)] = await this.workspace.readWebApiText(item, this.settings.maxFileReadBytes);
      }
      return success({ FileContentData });
    });
    add('getFileData', async ({ url }) => {
      const filePath = queryFirst(url, 'filePath');
      if (!await this.workspace.fileExists(filePath)) return failure('文件不存在');
      const text = await this.workspace.readWebApiText(filePath, this.settings.maxFileReadBytes);
      return success(parsePvfWebApiFileData(text));
    });
    add('getFileRootSectionData', async ({ url }) => {
      const filePath = queryFirst(url, 'filePath');
      if (!await this.workspace.fileExists(filePath)) return failure('文件不存在');
      const text = await this.workspace.readWebApiText(filePath, this.settings.maxFileReadBytes);
      return success(parsePvfWebApiRootSections(text));
    });
    add('GetAllLstFileList', async () => success(this.workspace.getAllLstFiles()));
    add('FileIsExists', async ({ url }) => {
      return await this.workspace.fileExists(queryFirst(url, 'filePath')) ? successNoData() : { IsError: true, Msg: '不存在', ErrorId: 0 };
    });
    add('folderExists', async ({ url }) => {
      return await this.workspace.folderExists(queryFirst(url, 'filePath')) ? successNoData() : { IsError: true, Msg: '不存在', ErrorId: 0 };
    });
    add('getStringTable', async () => success(await this.workspace.getStringTable()));
    add('getLstFileInfo', async ({ url }) => {
      const filePath = queryFirst(url, 'filePath');
      if (!await this.workspace.fileExists(filePath)) return failure('文件不存在');
      return success(await this.workspace.getLstFileInfo(filePath));
    });
    add('GetItemInfo', async ({ url }) => {
      const filePath = queryFirst(url, 'filePath');
      if (!await this.workspace.fileExists(filePath)) return failure('文件不存在');
      return success(await this.workspace.getItemInfo(filePath));
    });
    add('GetItemInfos', async ({ bodyText }) => {
      const paths = extractFilePathsFromBody(jsonBody(bodyText));
      const data: Record<string, { ItemName: string | null; ItemCode: number | null }> = {};
      for (const item of paths) {
        if (!await this.workspace.fileExists(item)) continue;
        data[this.workspace.normalizePath(item)] = await this.workspace.getItemInfo(item);
      }
      return success(data);
    });
    add('ItemCodeToFileInfo', async ({ url }) => {
      const rawNames = url.searchParams.getAll('lstNames').flatMap(item => item.split(/[,\s;]+/)).filter(Boolean);
      const lstNames = rawNames.length ? rawNames : ['equipment', 'stackable'];
      const itemCode = Number(queryFirst(url, 'itemCode'));
      if (!Number.isSafeInteger(itemCode)) return failure('itemCode 无效');
      const info = await this.workspace.itemCodeToFileInfo(lstNames, itemCode);
      return info ? success(info) : failure(`在：${lstNames.join(',')}中未能找到：${itemCode}`);
    });
    add('ItemCodesToFileInfos', async ({ bodyText }) => {
      const { lstNames, itemCodes } = extractItemCodesBody(jsonBody(bodyText));
      const data: Record<string, { FilePath: string; ItemName: string | null; Path: string } | null> = {};
      for (const code of itemCodes) {
        data[String(code)] = await this.workspace.itemCodeToFileInfo(lstNames, code) || null;
      }
      return success(data);
    });

    for (const action of MUTATION_ACTIONS) {
      add(action, async () => failure('写入接口未启用'));
    }

    add('GetTreeListFocusedFilePath', async () => success(null));
    add('GetSearchPanelTreeListFocusedFilePath', async () => success(null));
    add('GetActiveDocumentFilePath', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || doc.uri.scheme !== 'file') return success(null);
      const root = this.workspace.getRoot();
      const rel = path.relative(root, doc.uri.fsPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return success(null);
      return success(rel.replace(/\\/g, '/').toLowerCase());
    });
    add('GetTreeSelectedFiles', async () => success([]));
    add('GetSearchPanelSelectedFiles', async () => success([]));
    return handlers;
  }

  private log(method: string, route: string, started: number, isError: boolean): void {
    if (this.settings.requestLogging === 'off') return;
    if (this.settings.requestLogging === 'errors' && !isError) return;
    this.deps.output.appendLine(`[PVF WebApi] ${method} ${route} ${Date.now() - started}ms${isError ? ' ERROR' : ''}`);
  }

  private updateStatus(): void {
    if (this.activePort) {
      this.status.text = `PVF API: :${this.activePort}`;
      this.status.tooltip = [
        `PVF WebApi Compatibility Server`,
        `Root: ${this.workspace.getRoot() || '(not loaded)'}`,
        `Base: http://127.0.0.1:${this.activePort}`,
        `Old: http://127.0.0.1:${this.activePort}/Api/PvfUtiltiy`,
        `New: http://127.0.0.1:${this.activePort}/Api/PvfUtility`,
        `Mode: ${this.settings.readOnly || !this.settings.enableMutationApis ? 'read-only' : 'write-enabled'}`,
        ...(this.lastError ? [`Last error: ${this.lastError}`] : []),
      ].join('\n');
    } else {
      this.status.text = 'PVF API: Off';
      this.status.tooltip = this.lastError ? `PVF WebApi stopped\nLast error: ${this.lastError}` : 'PVF WebApi stopped';
    }
  }
}

export function registerPvfWebApiServer(deps: PvfWebApiServiceDeps): PvfWebApiServer {
  const server = new PvfWebApiServer(deps);
  const subscriptions = deps.context.subscriptions;
  subscriptions.push(
    server,
    vscode.commands.registerCommand('pvf.webApi.start', async () => {
      try {
        await server.start();
        vscode.window.showInformationMessage(`PVF WebApi 已启动: ${server.baseUrl()}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(String(err?.message || err));
      }
    }),
    vscode.commands.registerCommand('pvf.webApi.stop', async () => {
      await server.stop();
      vscode.window.showInformationMessage('PVF WebApi 已停止');
    }),
    vscode.commands.registerCommand('pvf.webApi.restart', async () => {
      try {
        await server.restart();
        vscode.window.showInformationMessage(`PVF WebApi 已重启: ${server.baseUrl()}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(String(err?.message || err));
      }
    }),
    vscode.commands.registerCommand('pvf.webApi.copyBaseUrl', () => server.copyBaseUrl()),
    vscode.commands.registerCommand('pvf.webApi.selectUnpackRoot', () => server.selectUnpackRoot()),
    vscode.commands.registerCommand('pvf.webApi.showOutput', () => deps.output.show(true)),
    vscode.commands.registerCommand('pvf.webApi.diagnostics', () => server.diagnostics()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('pvf.webApi')) return;
      if (server.isRunning()) void server.restart().catch(() => undefined);
      else void server.autoStart();
    }),
  );
  void server.autoStart();
  return server;
}
