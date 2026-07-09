#!/usr/bin/env bun
// aitapp MCP server のエントリポイント。stdio transport で Claude Code 等に接続する。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config';
import { WorkerClient } from './client';
import { registerNoticeTools } from './tools/notices';
import { registerTimetableTools } from './tools/timetable';
import { registerAssignmentTools } from './tools/assignments';
import { registerSyllabusTools } from './tools/syllabus';
import { registerPerformanceTools } from './tools/performance';
import { registerEnqueteTools } from './tools/enquetes';
import { registerQuizTools } from './tools/quiz';
import { registerMoodleFileTools } from './tools/moodle-files';

const config = loadConfig(process.env);
const client = new WorkerClient(config);

const server = new McpServer({ name: 'aitapp-mcp', version: '1.0.0' });

registerNoticeTools(server, client);
registerTimetableTools(server, client);
registerAssignmentTools(server, client);
registerSyllabusTools(server, client);
registerPerformanceTools(server, client);
registerEnqueteTools(server, client);
registerQuizTools(server, client);
registerMoodleFileTools(server, client);

await server.connect(new StdioServerTransport());
