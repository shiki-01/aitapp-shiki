// DownloadedFile を MCP のツール結果 content に変換する共通ヘルパー。
// ローカル実行(path あり)は従来どおり JSON テキストでパスを返し、
// クラウド実行(base64 あり)は内容そのものを content block として返す。

import type { DownloadedFile } from '../tool-client';

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; blob: string; mimeType: string } };

export function downloadedFileContent(res: DownloadedFile): { content: ToolContent[] } {
  if (res.path) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ path: res.path, contentType: res.contentType }, null, 2),
        },
      ],
    };
  }
  const mime = res.contentType ?? 'application/octet-stream';
  const data = res.base64 ?? '';
  if (mime.startsWith('image/')) {
    return { content: [{ type: 'image', data, mimeType: mime }] };
  }
  if (mime.startsWith('audio/')) {
    return { content: [{ type: 'audio', data, mimeType: mime }] };
  }
  return {
    content: [
      {
        type: 'resource',
        resource: {
          uri: `aitapp://download/${encodeURIComponent(res.fileName)}`,
          blob: data,
          mimeType: mime,
        },
      },
    ],
  };
}
