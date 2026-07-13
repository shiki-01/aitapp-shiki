#!/usr/bin/env bun
// aitapp MCP server のエントリポイント。stdio transport で Claude Code 等に接続する。

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config';
import { WorkerClient } from './client';
import { createAitappServer } from './register';

const config = loadConfig(process.env);
const client = new WorkerClient(config);
const server = createAitappServer(client);

await server.connect(new StdioServerTransport());
