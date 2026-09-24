import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('messages_get', () => {
  it('returns dualResult with wrapped content', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/messages/:messageId`, async ({ params }) =>
        HttpResponse.json({
          id: params.messageId,
          channel_id: params.channelId,
          content: 'hello there',
          author: { id: '111122223333444401', username: 'alice', global_name: 'Alice' },
          timestamp: '2026-04-28T12:00:00.000000+00:00',
          edited_timestamp: null,
          pinned: false,
        }),
      ),
    );

    const T = messagesGet;
    const t = new T(
      { name: 'messages_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_get', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '112233445566778899', message_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: { message_id: string; content: string; pinned: boolean };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999000');
    expect(r.structuredContent.content).toBe('hello there');
    expect(r.structuredContent.pinned).toBe(false);
    expect(r.content[0]?.text).toMatch(/<untrusted_discord_messages/);
  });

  it('exposes rich fields and appends a compact suffix to the fenced text', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/messages/:messageId`, async ({ params }) =>
        HttpResponse.json({
          id: params.messageId,
          channel_id: params.channelId,
          content: '',
          author: { id: '111122223333444401', username: 'bot', bot: true },
          timestamp: '2026-04-28T12:00:00.000000+00:00',
          edited_timestamp: null,
          attachments: [
            {
              id: '999000999000000301',
              filename: 'clip.mov',
              content_type: 'video/quicktime',
              size: 10,
              url: 'https://cdn.discordapp.com/attachments/1/2/clip.mov',
              proxy_url: 'https://media.discordapp.net/attachments/1/2/clip.mov',
            },
          ],
          embeds: [{ description: 'desc' }],
          reactions: [{ emoji: { id: null, name: '👍' }, count: 3, me: false }],
          message_reference: { message_id: '999000999000000001' },
          components: [{ type: 10, content: 'V2 body' }],
        }),
      ),
    );
    const T = messagesGet;
    const t = new T(
      { name: 'messages_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_get', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '112233445566778899', message_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    expect(r.structuredContent).toMatchObject({
      pinned: false,
      author_bot: true,
      attachments: [{ id: '999000999000000301', filename: 'clip.mov', width: null }],
      embeds: [{ type: null, title: null, description: 'desc', url: null }],
      reactions: [{ emoji: '👍', emoji_id: null, count: 3, me: false }],
      reply_to: '999000999000000001',
      thread_id: null,
      components_text: 'V2 body',
    });
    expect(r.content[0]!.text).toContain(
      '> [attachments: clip.mov] [reactions: 👍×3] [reply_to: 999000999000000001]</msg>',
    );
  });
});
