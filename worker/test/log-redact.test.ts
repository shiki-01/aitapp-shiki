import { describe, it, expect, vi, afterEach } from 'vitest';
import { redactPath } from '../src/log';
import { fetchUpstream } from '../src/upstream/fetch';
import { UpstreamError } from '../src/upstream/errors';

afterEach(() => vi.unstubAllGlobals());

describe('redactPath', () => {
  it('/mcp/<token> のトークンを伏せる', () => {
    expect(redactPath('/mcp/u.eDI2MDQ5eHg.abcdef0123')).toBe('/mcp/[redacted]');
    expect(redactPath('/mcp/ownertoken')).toBe('/mcp/[redacted]');
  });
  it('それ以外のパスはそのまま', () => {
    expect(redactPath('/mcp')).toBe('/mcp');
    expect(redactPath('/api/syllabus/search')).toBe('/api/syllabus/search');
  });
});

describe('fetchUpstream のタイムアウト文言', () => {
  it('URL のクエリ（token=）をエラー文に含めない', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('timeout', 'TimeoutError');
    });
    const err = await fetchUpstream('https://cms.aitech.ac.jp/pluginfile.php/1/x.pdf?token=SECRETTOKEN').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toContain('https://cms.aitech.ac.jp/pluginfile.php/1/x.pdf');
    expect(err.message).not.toContain('SECRETTOKEN');
  });
});
