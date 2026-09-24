import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesRead from './read.js';
import '../../container.js';

describe('messages_read', () => {
  it('returns dualResult with wrapped messages', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const T = messagesRead;
    const t = new T(
      { name: 'messages_read', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_read', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '112233445566778899', limit: 3 },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: { messages: unknown[]; channel_id: string; count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.channel_id).toBe('112233445566778899');
    expect(r.structuredContent.count).toBe(3);
    const text = r.content[0]!.text;
    expect(text).toMatch(
      /<untrusted_discord_messages nonce="[0-9a-f]{16}" channel_id="112233445566778899" count="3">/,
    );
    expect(text).toContain('<msg id="100000101795321187" author="User 1">message 1 content</msg>');
  });

  it('rejects limit out of range via zod', async () => {
    const T = messagesRead;
    const t = new T(
      { name: 'messages_read', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_read', enabled: true },
    );
    const { z } = await import('zod');
    const schema = z.object(t.inputSchema);
    expect(schema.safeParse({ channel_id: '112233445566778899', limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ channel_id: '112233445566778899', limit: 101 }).success).toBe(false);
  });

  it('applies the default limit and rejects conflicting cursors', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    server.use(
      http.get('https://discord.com/api/v10/channels/:channelId/messages', ({ request }) => {
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({ limit: '50' });
        return HttpResponse.json([]);
      }),
    );
    const T = messagesRead;
    const t = new T(
      { name: 'messages_read', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_read', enabled: true },
    );
    const result = (await t.run(
      { channel_id: '112233445566778899' },
      { signal: new AbortController().signal },
    )) as { structuredContent: { count: number } };
    expect(result.structuredContent.count).toBe(0);

    await expect(
      t.run(
        {
          channel_id: '112233445566778899',
          before: '999000999000000099',
          after: '999000999000000001',
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  describe('rich message fields', () => {
    const CHANNEL = '112233445566778899';
    const richMessages = [
      {
        id: '999000999000000003',
        channel_id: CHANNEL,
        content: 'look at this',
        author: { id: '999000999000000013', username: 'hookbot', bot: true },
        timestamp: '2026-04-28T12:03:00.000Z',
        edited_timestamp: null,
        attachments: [
          {
            id: '999000999000000301',
            filename: 'a.mp4',
            content_type: 'video/mp4',
            size: 1234,
            url: 'https://cdn.discordapp.com/attachments/1/2/a.mp4?ex=1',
            proxy_url: 'https://media.discordapp.net/attachments/1/2/a.mp4?ex=1',
            width: 1080,
            height: 1920,
          },
          {
            id: '999000999000000302',
            filename: 'voice.ogg',
            size: 99,
            url: 'https://cdn.discordapp.com/attachments/1/2/voice.ogg',
            proxy_url: 'https://media.discordapp.net/attachments/1/2/voice.ogg',
            duration_secs: 3.5,
          },
        ],
        embeds: [{ type: 'link', title: 'Title', url: 'https://example.com' }],
        reactions: [
          { emoji: { id: null, name: '✅' }, count: 2, me: true },
          { emoji: { id: '999000999000000401', name: 'party' }, count: 1, me: false },
        ],
        message_reference: { message_id: '999000999000000001', channel_id: CHANNEL },
        thread: { id: '999000999000000501' },
        components: [
          {
            type: 17,
            components: [
              { type: 10, content: 'Header text' },
              {
                type: 9,
                components: [{ type: 10, content: 'Section body' }],
                accessory: { type: 2, style: 1, label: 'Approve', custom_id: 'ok' },
              },
              {
                type: 1,
                components: [
                  {
                    type: 3,
                    custom_id: 'pick',
                    options: [{ label: 'Option A', value: 'a' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: '999000999000000002',
        channel_id: CHANNEL,
        content: 'plain',
        author: { id: '999000999000000012', username: 'user2' },
        timestamp: '2026-04-28T12:02:00.000Z',
        edited_timestamp: null,
        reactions: [{ emoji: { id: null, name: '❤️' }, count: 1, me: false }],
      },
    ];

    function tool() {
      const T = messagesRead;
      return new T(
        { name: 'messages_read', path: 'inline', root: 'inline', store: null as never },
        { name: 'messages_read', enabled: true },
      );
    }

    it('exposes attachments, embeds, reactions, reply/thread refs and component text', async () => {
      container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
      server.use(
        http.get('https://discord.com/api/v10/channels/:channelId/messages', () =>
          HttpResponse.json(richMessages),
        ),
      );
      const r = (await tool().run(
        { channel_id: CHANNEL, limit: 2 },
        { signal: new AbortController().signal },
      )) as {
        content: Array<{ text: string }>;
        structuredContent: {
          messages: Array<Record<string, unknown>>;
        };
      };
      const [rich, plain] = r.structuredContent.messages;
      expect(rich).toMatchObject({
        id: '999000999000000003',
        content: 'look at this',
        author_bot: true,
        attachments: [
          {
            id: '999000999000000301',
            filename: 'a.mp4',
            content_type: 'video/mp4',
            size: 1234,
            width: 1080,
            height: 1920,
            duration_secs: null,
          },
          {
            id: '999000999000000302',
            content_type: null,
            width: null,
            height: null,
            duration_secs: 3.5,
          },
        ],
        embeds: [{ type: 'link', title: 'Title', description: null, url: 'https://example.com' }],
        reactions: [
          { emoji: '✅', emoji_id: null, count: 2, me: true },
          { emoji: 'party', emoji_id: '999000999000000401', count: 1, me: false },
        ],
        reply_to: '999000999000000001',
        thread_id: '999000999000000501',
        components_text: 'Header text\nSection body\nApprove\nOption A',
      });
      expect(plain).toMatchObject({
        attachments: [],
        embeds: [],
        reply_to: null,
        thread_id: null,
        components_text: '',
        author_bot: false,
      });
      const text = r.content[0]!.text;
      expect(text).toContain(
        'look at this [attachments: a.mp4, voice.ogg] [reactions: ✅×2 party×1] [reply_to: 999000999000000001]</msg>',
      );
      expect(text).toContain('>plain [reactions: ❤️×1]</msg>');
    });
  });
});
