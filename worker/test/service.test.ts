import { describe, expect, it } from 'vitest';
import { classifyUpstreamService } from '../src/upstream/service';

describe('classifyUpstreamService', () => {
  it('classifies by route path', () => {
    expect(classifyUpstreamService('/api/notices', 'x')).toBe('lcam');
    expect(classifyUpstreamService('/api/moodle/resources', 'x')).toBe('moodle');
    expect(classifyUpstreamService('/api/syllabus/search', 'x')).toBe('syllabus');
  });

  it('classifies login errors by detail message fallback', () => {
    expect(classifyUpstreamService('/api/auth/login', 'Moodle token error: statusCode=500')).toBe(
      'moodle',
    );
    expect(classifyUpstreamService('/api/auth/login', 'LCAM http error: statusCode=500')).toBe(
      'lcam',
    );
  });

  it('returns unknown when no signals are available', () => {
    expect(classifyUpstreamService('/api/auth/logout', 'unexpected')).toBe('unknown');
  });
});
