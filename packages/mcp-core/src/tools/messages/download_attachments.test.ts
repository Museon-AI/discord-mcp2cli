import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messagesDownloadAttachments from './download_attachments.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const CHANNEL = '112233445566778899';
const MESSAGE = '999000999000999000';

function attachment(id: string, filename: string, url: string, size: number) {
  return {
    id,
    filename,
    content_type: 'video/mp4',
    size,
    url,
    proxy_url: url.replace('cdn.discordapp.com', 'media.discordapp.net'),
  };
}

function tool() {
  const T = messagesDownloadAttachments;
  return new T(
    { name: 'messages_download_attachments', path: 'inline', root: 'inline', store: null as never },
    { name: 'messages_download_attachments', enabled: true },
  );
}

type Result = {
  isError: boolean;
  content: Array<{ text: string }>;
  structuredContent: {
    files: Array<{ attachment_id: string; filename: string; path: string; size: number }>;
    skipped: Array<{ attachment_id: string; reason: string }>;
  };
};

describe('messages_download_attachments', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attachments-download-'));
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function mockMessage(attachments: unknown[]) {
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/messages/:messageId`, ({ params }) =>
        HttpResponse.json({
          id: params.messageId,
          channel_id: params.channelId,
          content: '',
          author: { id: '111122223333444401', username: 'alice' },
          timestamp: '2026-04-28T12:00:00.000000+00:00',
          edited_timestamp: null,
          attachments,
        }),
      ),
    );
  }

  it('downloads CDN attachments and refuses oversize, foreign-host, and unknown ids', async () => {
    mockMessage([
      attachment('999000999000000301', '../clip one.mp4', 'https://cdn.discordapp.com/a/1.mp4', 5),
      attachment('999000999000000302', 'big.mp4', 'https://cdn.discordapp.com/a/2.mp4', 500),
      attachment('999000999000000303', 'evil.mp4', 'https://evil.example.com/a/3.mp4', 5),
      attachment('999000999000000304', 'lied.mp4', 'https://cdn.discordapp.com/a/4.mp4', 5),
      attachment('999000999000000305', 'gone.mp4', 'https://cdn.discordapp.com/a/5.mp4', 5),
      attachment('999000999000000306', 'bad.mp4', 'not a url', 5),
      attachment('999000999000000307', 'hop.mp4', 'https://cdn.discordapp.com/a/7.mp4', 5),
    ]);
    server.use(
      http.get('https://cdn.discordapp.com/a/1.mp4', () => HttpResponse.text('hello')),
      // Declared size is small but the body is larger than max_bytes.
      http.get('https://cdn.discordapp.com/a/4.mp4', () => HttpResponse.text('x'.repeat(200))),
      http.get('https://cdn.discordapp.com/a/5.mp4', () => new HttpResponse(null, { status: 404 })),
      // A CDN redirect off Discord hosts is refused after the fact.
      http.get('https://cdn.discordapp.com/a/7.mp4', () =>
        HttpResponse.redirect('https://evil.example.com/a/7.mp4', 302),
      ),
      http.get('https://evil.example.com/a/7.mp4', () => HttpResponse.text('evil')),
    );
    const r = (await tool().run(
      { channel_id: CHANNEL, message_id: MESSAGE, dest_dir: join(dir, 'out'), max_bytes: 100 },
      { signal: new AbortController().signal },
    )) as Result;

    expect(r.isError).toBe(false);
    const expectedPath = join(dir, 'out', '999000999000000301__clip_one.mp4');
    expect(r.structuredContent.files).toEqual([
      {
        attachment_id: '999000999000000301',
        filename: '../clip one.mp4',
        path: expectedPath,
        size: 5,
        content_type: 'video/mp4',
      },
    ]);
    expect(await readFile(expectedPath, 'utf8')).toBe('hello');
    expect(await readdir(join(dir, 'out'))).toEqual(['999000999000000301__clip_one.mp4']);
    expect(r.structuredContent.skipped).toEqual([
      { attachment_id: '999000999000000302', reason: 'exceeds_max_bytes' },
      { attachment_id: '999000999000000303', reason: 'non_discord_cdn_host' },
      { attachment_id: '999000999000000304', reason: 'exceeds_max_bytes' },
      { attachment_id: '999000999000000305', reason: 'http_404' },
      { attachment_id: '999000999000000306', reason: 'non_discord_cdn_host' },
      { attachment_id: '999000999000000307', reason: 'non_discord_cdn_host' },
    ]);
    expect(r.content[0]!.text).toContain('Skipped 6:');
  });

  it('downloads only the requested attachment ids and reports missing ones', async () => {
    mockMessage([
      attachment('999000999000000301', 'a.mp4', 'https://cdn.discordapp.com/a/1.mp4', 3),
      attachment('999000999000000302', 'b.mp4', 'https://cdn.discordapp.com/a/2.mp4', 3),
    ]);
    server.use(http.get('https://cdn.discordapp.com/a/2.mp4', () => HttpResponse.text('bbb')));
    const r = (await tool().run(
      {
        channel_id: CHANNEL,
        message_id: MESSAGE,
        dest_dir: dir,
        attachment_ids: ['999000999000000302', '999000999000000399'],
      },
      { signal: new AbortController().signal },
    )) as Result;
    expect(r.structuredContent.files.map((f) => f.attachment_id)).toEqual(['999000999000000302']);
    expect(r.structuredContent.skipped).toEqual([
      { attachment_id: '999000999000000399', reason: 'not_found' },
    ]);
  });

  it('returns empty results for a message without attachments', async () => {
    mockMessage([]);
    const r = (await tool().run(
      { channel_id: CHANNEL, message_id: MESSAGE, dest_dir: dir },
      { signal: new AbortController().signal },
    )) as Result;
    expect(r.structuredContent).toMatchObject({ files: [], skipped: [] });
    expect(r.content[0]!.text).not.toContain('Skipped');
  });
});
