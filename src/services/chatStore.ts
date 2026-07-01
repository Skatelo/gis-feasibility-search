// Persistent Land Assistant chat history. Local cache in IndexedDB (survives
// reloads, works offline) that SYNCS across devices through Supabase (user_sync)
// when the account is cloud-backed. Heavy attachment payloads (image/PDF base64)
// are stripped before persisting — only lightweight previews are kept — so
// history stays small.
import { idbGet, idbSet } from './idb';
import { syncEnabled, syncGet, syncSet } from './syncStore';
import type { ChatMessage } from './feasibilityService';

const KEY = 'gis_chat_conversations_v1';
const SYNC_KEY = 'chat_conversations';
const MAX_CONVERSATIONS = 60;

export interface ChatConversation {
  id: string;
  title: string;
  address?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export function newConversationId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function deriveTitle(messages: ChatMessage[], address?: string): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
  if (firstUser) return firstUser.content.trim().slice(0, 64);
  if (address) return address.slice(0, 64);
  return 'New chat';
}

function stripAttachmentData(m: ChatMessage): ChatMessage {
  if (!m.attachments?.length) return m;
  return {
    ...m,
    attachments: m.attachments.map((a) => ({
      name: a.name, mimeType: a.mimeType, kind: a.kind, previewUrl: a.previewUrl,
    })),
  };
}

const sortDesc = (a: ChatConversation[]) => a.slice().sort((x, y) => y.updatedAt - x.updatedAt);

async function readLocal(): Promise<ChatConversation[]> {
  return (await idbGet<ChatConversation[]>(KEY)) || [];
}
async function writeLocal(all: ChatConversation[]): Promise<void> {
  await idbSet(KEY, all);
}

export async function listConversations(): Promise<ChatConversation[]> {
  const local = await readLocal();
  if (!syncEnabled()) return sortDesc(local);
  const cloud = await syncGet<ChatConversation[]>(SYNC_KEY);
  if (cloud === undefined) {
    // Never synced on this account → migrate any local history up to the cloud.
    if (local.length) await syncSet(SYNC_KEY, sortDesc(local).slice(0, MAX_CONVERSATIONS));
    return sortDesc(local);
  }
  // Cloud is authoritative once it exists (even []): mirror it into the local cache.
  await writeLocal(cloud);
  return sortDesc(cloud);
}

export async function saveConversation(convo: ChatConversation): Promise<void> {
  const all = await readLocal();
  const lite: ChatConversation = { ...convo, messages: convo.messages.map(stripAttachmentData) };
  const idx = all.findIndex((c) => c.id === convo.id);
  if (idx >= 0) { lite.createdAt = all[idx].createdAt; all[idx] = lite; } else all.push(lite);
  const trimmed = sortDesc(all).slice(0, MAX_CONVERSATIONS);
  await writeLocal(trimmed);
  if (syncEnabled()) await syncSet(SYNC_KEY, trimmed);
}

export async function deleteConversation(id: string): Promise<void> {
  const all = (await readLocal()).filter((c) => c.id !== id);
  await writeLocal(all);
  if (syncEnabled()) await syncSet(SYNC_KEY, all);
}
