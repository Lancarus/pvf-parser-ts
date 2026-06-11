import type * as http from 'http';
import type * as vscode from 'vscode';

export interface PvfUtilityResult<T = unknown> {
  Data?: T | null;
  IsError: boolean;
  Msg?: string | null;
  ErrorId: number;
}

export interface PvfWebApiSettings {
  enabled: boolean;
  autoStart: boolean;
  preferredPort: number;
  maxPortScanCount: number;
  bindHost: 'loopback' | '127.0.0.1' | 'localhost';
  unpackRoot: string;
  readOnly: boolean;
  enableMutationApis: boolean;
  maxFileReadBytes: number;
  maxImportBytes: number;
  enableLegacyShortEndpoints: boolean;
  requestLogging: 'off' | 'errors' | 'summary';
}

export interface PvfWebApiRouteContext {
  req: http.IncomingMessage;
  bodyText: string;
  url: URL;
  action: string;
}

export interface PvfWebApiServiceDeps {
  context: vscode.ExtensionContext;
  extensionVersion: string;
  output: vscode.OutputChannel;
}

export interface PvfWebApiFileInfo {
  PathHeader: string;
  ItemPath: string;
  FullPath: string;
  ItemName: string | null;
  ItemCode: number;
}

export interface PvfWebApiNode {
  SectionName: string | null;
  IsSection: boolean;
  HasEndSection: boolean;
  DataType: number;
  Value: string | null;
  Children: PvfWebApiNode[];
}

