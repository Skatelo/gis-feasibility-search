// Persistent Land Assistant chat history (per browser), backed by IndexedDB so
// past conversations survive reloads. Heavy attachment payloads (image/PDF
// base64) are stripped before persisting — only lightweight previews are kept —
// so history stays small.
import { idbGet, idbSet } from './idb';
import type { ChatMessage } from './feasibilityService';

const KEY = 'gis_chat_conversations_v1';
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

export async function listConversations(): Promise<ChatConversation[]> {
  const all = (await idbGet<ChatConversation[]>(KEY)) || [];
  return all.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveConversation(convo: ChatConversation): Promise<void> {
  const all = (await idbGet<ChatConversation[]>(KEY)) || [];
  const lite: ChatConversation = { ...convo, messages: convo.messages.map(stripAttachmentData) };
  const idx = all.findIndex((c) => c.id === convo.id);
  if (idx >= 0) { lite.createdAt = all[idx].createdAt; all[idx] = lite; } else all.push(lite);
  const trimmed = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
  await idbSet(KEY, trimmed);
}

export async function deleteConversation(id: string): Promise<void> {
  const all = (await idbGet<ChatConversation[]>(KEY)) || [];
  await idbSet(KEY, all.filter((c) => c.id !== id));
}
