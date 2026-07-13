// 全ツールの登録。stdio(ローカル)と Streamable HTTP(worker 内)の両エントリから共用する。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from './tool-client';
import { registerNoticeTools } from './tools/notices';
import { registerTimetableTools } from './tools/timetable';
import { registerAssignmentTools } from './tools/assignments';
import { registerSyllabusTools } from './tools/syllabus';
import { registerPerformanceTools } from './tools/performance';
import { registerEnqueteTools } from './tools/enquetes';
import { registerQuizTools } from './tools/quiz';
import { registerMoodleFileTools } from './tools/moodle-files';

export function createAitappServer(client: ToolClient): McpServer {
  const server = new McpServer({ name: 'aitapp-mcp', version: '1.0.0' });
  registerNoticeTools(server, client);
  registerTimetableTools(server, client);
  registerAssignmentTools(server, client);
  registerSyllabusTools(server, client);
  registerPerformanceTools(server, client);
  registerEnqueteTools(server, client);
  registerQuizTools(server, client);
  registerMoodleFileTools(server, client);
  return server;
}
