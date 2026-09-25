// 全ツールの登録。stdio(ローカル)と Streamable HTTP(worker 内)の両エントリから共用する。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolClient } from './tool-client';
import { registerLcamSessionTools } from './tools/lcam-session';
import { registerNoticeTools } from './tools/notices';
import { registerTimetableTools } from './tools/timetable';
import { registerAssignmentTools } from './tools/assignments';
import { registerSyllabusTools } from './tools/syllabus';
import { registerPerformanceTools } from './tools/performance';
import { registerCommonFileTools } from './tools/commonfiles';
import { registerReportTools } from './tools/reports';
import { registerFacilityTools } from './tools/facilities';
import { registerEnqueteTools } from './tools/enquetes';
import { registerQuizTools } from './tools/quiz';
import { registerMoodleFileTools } from './tools/moodle-files';
import { registerMoodleCourseTools } from './tools/courses';

export function createAitappServer(client: ToolClient): McpServer {
  const server = new McpServer({ name: 'aitapp-mcp', version: '1.0.0' });
  registerLcamSessionTools(server, client);
  registerNoticeTools(server, client);
  registerTimetableTools(server, client);
  registerAssignmentTools(server, client);
  registerSyllabusTools(server, client);
  registerPerformanceTools(server, client);
  registerEnqueteTools(server, client);
  registerCommonFileTools(server, client);
  registerReportTools(server, client);
  registerFacilityTools(server, client);
  registerMoodleCourseTools(server, client);
  registerQuizTools(server, client);
  registerMoodleFileTools(server, client);
  return server;
}
