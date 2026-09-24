import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import type { RawRichMessage } from '../_lib/message-shape.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, Snowflake } from '../_lib/snowflake.js';

const DEFAULT_MAX_BYTES = 104_857_600;
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function isDiscordCdnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && DISCORD_CDN_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Keep filenames to a portable, traversal-free charset; the attachment id prefix keeps them unique. */
function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'file';
}

/** Release an unread body without awaiting: some fetch implementations never settle cancel(). */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/** Read the body while counting bytes; returns undefined once it exceeds maxBytes. */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Not awaited, as in discardBody().
      reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export default defineTool({
  name: 'attachments_download',
  category: 'messages',
  description: [
    '**Purpose**: Download a message’s attachments from the Discord CDN to a local directory.',
    '',
    '**When to use**:',
    '- Keep the files behind `attachments[].url` returned by `messages_read` / `messages_get` / `messages_search_recent`.',
    '- Discord CDN URLs are signed and expire, so download at read time rather than storing the URL.',
    '',
    '**When NOT to use**:',
    '- Only need filenames, sizes, or content types → `messages_get` already returns them.',
    '',
    '**Example**: `{channel_id:"112233445566778899", message_id:"999000999000999000", dest_dir:"/tmp/discord-files"}`',
    '',
    '**Returns**: `{files:[{attachment_id, filename, path, size, content_type}], skipped:[{attachment_id, reason}], channel_id, message_id}`. Files are written to `dest_dir/<attachment_id>_<sanitized filename>` (the directory is created if missing; existing files are overwritten). Files over `max_bytes` and URLs outside `cdn.discordapp.com` / `media.discordapp.net` are skipped.',
    '',
    '**Security**: Writes to the filesystem of the host running this server. Downloaded content is untrusted Discord user data.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel containing the message'),
    message_id: MessageId.describe('Message whose attachments to download'),
    attachment_ids: z
      .array(Snowflake)
      .min(1)
      .max(10)
      .optional()
      .describe('Attachment IDs to download (default: all attachments on the message)'),
    dest_dir: z
      .string()
      .min(1)
      .max(1024)
      .describe('Local directory to write files into (created if missing)'),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_MAX_BYTES)
      .describe('Per-file size cap in bytes (default 104857600 = 100 MiB)'),
  },
  outputSchema: {
    files: z.array(
      z.object({
        attachment_id: z.string(),
        filename: z.string(),
        path: z.string(),
        size: z.number().int(),
        content_type: z.string().nullable(),
      }),
    ),
    skipped: z.array(z.object({ attachment_id: z.string(), reason: z.string() })),
    channel_id: ChannelId,
    message_id: MessageId,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const maxBytes = args.max_bytes ?? DEFAULT_MAX_BYTES;
    const message = (await container.rest.get(
      Routes.channelMessage(args.channel_id, args.message_id),
    )) as RawRichMessage;
    const attachments = message.attachments ?? [];
    const requested = args.attachment_ids ?? attachments.map((a) => a.id);
    const destDir = resolve(args.dest_dir);

    const files: Array<{
      attachment_id: string;
      filename: string;
      path: string;
      size: number;
      content_type: string | null;
    }> = [];
    const skipped: Array<{ attachment_id: string; reason: string }> = [];

    for (const id of requested) {
      const attachment = attachments.find((a) => a.id === id);
      if (attachment === undefined) {
        skipped.push({ attachment_id: id, reason: 'not_found' });
        continue;
      }
      if (!isDiscordCdnUrl(attachment.url)) {
        skipped.push({ attachment_id: id, reason: 'non_discord_cdn_host' });
        continue;
      }
      if (attachment.size > maxBytes) {
        skipped.push({ attachment_id: id, reason: 'exceeds_max_bytes' });
        continue;
      }
      const response = await fetch(attachment.url, { signal: ctx.signal });
      if (response.url !== '' && !isDiscordCdnUrl(response.url)) {
        discardBody(response);
        skipped.push({ attachment_id: id, reason: 'non_discord_cdn_host' });
        continue;
      }
      if (!response.ok) {
        discardBody(response);
        skipped.push({ attachment_id: id, reason: `http_${response.status}` });
        continue;
      }
      const body = await readBounded(response, maxBytes);
      if (body === undefined) {
        skipped.push({ attachment_id: id, reason: 'exceeds_max_bytes' });
        continue;
      }
      await mkdir(destDir, { recursive: true });
      const path = join(destDir, `${attachment.id}_${sanitizeFilename(attachment.filename)}`);
      await writeFile(path, body);
      files.push({
        attachment_id: attachment.id,
        filename: attachment.filename,
        path,
        size: body.byteLength,
        content_type: attachment.content_type ?? null,
      });
    }

    const text = [
      `Downloaded **${files.length}** attachment(s) from message ${args.message_id} to ${destDir}.`,
      ...files.map((f) => `- ${f.attachment_id} → ${f.path} (${f.size} bytes)`),
      ...(skipped.length > 0
        ? [`Skipped ${skipped.length}:`, ...skipped.map((s) => `- ${s.attachment_id}: ${s.reason}`)]
        : []),
    ].join('\n');

    return dualResult({
      text,
      data: { files, skipped, channel_id: args.channel_id, message_id: args.message_id },
    });
  },
});
