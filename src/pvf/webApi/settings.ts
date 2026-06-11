import * as path from 'path';
import * as vscode from 'vscode';
import { PvfWebApiSettings } from './types';

function numberSetting(cfg: vscode.WorkspaceConfiguration, key: string, fallback: number, min: number, max: number): number {
  const value = cfg.get<number>(key, fallback);
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(min, Math.min(max, n));
}

function stringSetting<T extends string>(cfg: vscode.WorkspaceConfiguration, key: string, fallback: T, allowed: readonly T[]): T {
  const value = String(cfg.get<string>(key, fallback) || fallback) as T;
  return allowed.includes(value) ? value : fallback;
}

export function readPvfWebApiSettings(): PvfWebApiSettings {
  const cfg = vscode.workspace.getConfiguration();
  const unpackRoot = (cfg.get<string>('pvf.webApi.unpackRoot', '') || '').trim();
  return {
    enabled: cfg.get<boolean>('pvf.webApi.enabled', true),
    autoStart: cfg.get<boolean>('pvf.webApi.autoStart', true),
    preferredPort: numberSetting(cfg, 'pvf.webApi.preferredPort', 27000, 1, 65535),
    maxPortScanCount: numberSetting(cfg, 'pvf.webApi.maxPortScanCount', 20, 1, 256),
    bindHost: stringSetting(cfg, 'pvf.webApi.bindHost', 'loopback', ['loopback', '127.0.0.1', 'localhost'] as const),
    unpackRoot: unpackRoot ? path.resolve(unpackRoot) : '',
    readOnly: cfg.get<boolean>('pvf.webApi.readOnly', true),
    enableMutationApis: cfg.get<boolean>('pvf.webApi.enableMutationApis', false),
    maxFileReadBytes: numberSetting(cfg, 'pvf.webApi.maxFileReadBytes', 10 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    maxImportBytes: numberSetting(cfg, 'pvf.webApi.maxImportBytes', 10 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    enableLegacyShortEndpoints: cfg.get<boolean>('pvf.webApi.enableLegacyShortEndpoints', false),
    requestLogging: stringSetting(cfg, 'pvf.webApi.requestLogging', 'summary', ['off', 'errors', 'summary'] as const),
  };
}

