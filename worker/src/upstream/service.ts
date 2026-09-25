export type UpstreamService = 'lcam' | 'moodle' | 'syllabus' | 'unknown';

const LCAM_PATHS = [
  '/api/notices',
  '/api/timetable',
  '/api/lcam/',
  '/api/schedule',
  '/api/performance',
  '/api/enquetes',
  '/api/file/',
  '/api/commonfiles',
  '/api/reports',
  '/api/facilities',
  '/api/credits',
  '/api/curriculum',
  '/api/schoolevents',
] as const;

export function classifyUpstreamService(path: string, detail: string): UpstreamService {
  if (path.startsWith('/api/syllabus/')) return 'syllabus';
  if (path.startsWith('/api/moodle/') || path === '/api/assignments') return 'moodle';
  if (LCAM_PATHS.some((p) => path.startsWith(p))) return 'lcam';

  const msg = detail.toLowerCase();
  if (msg.includes('moodle')) return 'moodle';
  if (msg.includes('syllabus')) return 'syllabus';
  if (msg.includes('lcam') || msg.includes('struts') || msg.includes('smartphone')) return 'lcam';
  return 'unknown';
}
