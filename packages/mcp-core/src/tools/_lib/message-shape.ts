import { z } from 'zod';
import { ChannelId, MessageId } from './snowflake.js';

/**
 * Shared projection of the Discord message fields that the list/get endpoints
 * already return (attachments, embeds, reactions, reply reference, thread,
 * components) so the read tools expose them without extra Discord calls.
 */

export interface RawAttachment {
  id: string;
  filename: string;
  content_type?: string | null;
  size: number;
  url: string;
  proxy_url: string;
  width?: number | null;
  height?: number | null;
  duration_secs?: number | null;
}

export interface RawEmbed {
  type?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
}

export interface RawReaction {
  emoji: { id?: string | null; name?: string | null };
  count: number;
  me?: boolean;
}

export interface RawRichMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  timestamp: string;
  edited_timestamp: string | null;
  attachments?: RawAttachment[];
  embeds?: RawEmbed[];
  reactions?: RawReaction[];
  message_reference?: { message_id?: string | null } | null;
  thread?: { id: string } | null;
  components?: unknown[];
}

export interface MessageReaction {
  emoji: string;
  emoji_id: string | null;
  count: number;
  me: boolean;
}

export interface RichMessageFields {
  attachments: Array<{
    id: string;
    filename: string;
    content_type: string | null;
    size: number;
    url: string;
    proxy_url: string;
    width: number | null;
    height: number | null;
    duration_secs: number | null;
  }>;
  embeds: Array<{
    type: string | null;
    title: string | null;
    description: string | null;
    url: string | null;
  }>;
  reactions: MessageReaction[];
  reply_to: string | null;
  thread_id: string | null;
  components_text: string;
  author_bot: boolean;
}

/** zod shape for the fields above; spread into each tool's message object schema. */
export const RICH_MESSAGE_FIELDS = {
  attachments: z.array(
    z.object({
      id: z.string(),
      filename: z.string(),
      content_type: z.string().nullable(),
      size: z.number().int(),
      url: z.string(),
      proxy_url: z.string(),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      duration_secs: z.number().nullable(),
    }),
  ),
  embeds: z.array(
    z.object({
      type: z.string().nullable(),
      title: z.string().nullable(),
      description: z.string().nullable(),
      url: z.string().nullable(),
    }),
  ),
  reactions: z.array(
    z.object({
      emoji: z.string(),
      emoji_id: z.string().nullable(),
      count: z.number().int(),
      me: z.boolean(),
    }),
  ),
  reply_to: MessageId.nullable(),
  thread_id: ChannelId.nullable(),
  components_text: z.string(),
  author_bot: z.boolean(),
};

const TEXT_KEYS = ['content', 'label'] as const;
const CHILD_KEYS = ['components', 'accessory', 'options'] as const;

function collectComponentText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectComponentText(child, out);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  for (const key of TEXT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) out.push(value);
  }
  for (const key of CHILD_KEYS) collectComponentText(record[key], out);
}

/** Flatten every text-bearing field (text_display/section content, labels) in a component tree. */
export function flattenComponentsText(components: readonly unknown[] | undefined): string {
  const out: string[] = [];
  collectComponentText(components ?? [], out);
  return out.join('\n');
}

export function richFields(m: RawRichMessage): RichMessageFields {
  return {
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type ?? null,
      size: a.size,
      url: a.url,
      proxy_url: a.proxy_url,
      width: a.width ?? null,
      height: a.height ?? null,
      duration_secs: a.duration_secs ?? null,
    })),
    embeds: (m.embeds ?? []).map((e) => ({
      type: e.type ?? null,
      title: e.title ?? null,
      description: e.description ?? null,
      url: e.url ?? null,
    })),
    reactions: (m.reactions ?? []).map((r) => ({
      emoji: r.emoji.name ?? '',
      emoji_id: r.emoji.id ?? null,
      count: r.count,
      me: r.me ?? false,
    })),
    reply_to: m.message_reference?.message_id ?? null,
    thread_id: m.thread?.id ?? null,
    components_text: flattenComponentsText(m.components),
    author_bot: m.author.bot ?? false,
  };
}

/** Compact, human-readable suffix for the fenced text path; empty parts are omitted. */
export function richTextSuffix(f: RichMessageFields): string {
  let suffix = '';
  if (f.attachments.length > 0) {
    suffix += ` [attachments: ${f.attachments.map((a) => a.filename).join(', ')}]`;
  }
  if (f.reactions.length > 0) {
    suffix += ` [reactions: ${f.reactions.map((r) => `${r.emoji}×${r.count}`).join(' ')}]`;
  }
  if (f.reply_to !== null) suffix += ` [reply_to: ${f.reply_to}]`;
  return suffix;
}
