import type * as http from 'http';
import { PvfUtilityResult } from './types';

export function success<T>(data: T): PvfUtilityResult<T> {
  return { Data: data, IsError: false, Msg: null, ErrorId: 0 };
}

export function successNoData(): PvfUtilityResult {
  return { IsError: false, Msg: null, ErrorId: 0 };
}

export function failure<T = null>(msg: string, data: T | null = null, errorId = 0): PvfUtilityResult<T> {
  return { Data: data, IsError: true, Msg: msg, ErrorId: errorId };
}

export function writeJson(res: http.ServerResponse, result: PvfUtilityResult, statusCode = 200): void {
  const body = JSON.stringify(result);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

export function writeText(res: http.ServerResponse, body: string, statusCode = 200): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

