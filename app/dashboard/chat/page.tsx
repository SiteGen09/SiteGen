import { listMediaModelOptions, listPublicModelOptions } from '@/lib/ai/channels';
import { loadRoutingPreferences } from '@/lib/ai/sources';
import { loadPlan } from '@/lib/chat/pipeline';
import { conversationSchema } from '@/lib/chat/conversations';
import { requireUser } from '@/lib/dashboard/session';
import { GENSITE_MODEL_ID } from '@/lib/gensite/config';
import { selectGensiteMediaChannel } from '@/lib/gensite/media';
import { mediaAvailability } from '@/lib/media/availability';
import { loadMediaAccess } from '@/lib/safety/media-gate';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '../ui';
import { ChatWorkspace } from './chat-workspace';

export const metadata = { title: 'Chat — sitegen' };

export default async function ChatPage() {
  const user = await requireUser();
  const [plan, preferences, session] = await Promise.all([
    loadPlan(user.id),
    loadRoutingPreferences(user.id),
    createClient(),
  ]);
  const imageEnabled = mediaAvailability('image').enabled;
  const videoEnabled = mediaAvailability('video').enabled;
  const [chatOptions, imageOptions, videoOptions, conversations, mediaAccess, gensiteImage, gensiteVideo] = await Promise.all([
    listPublicModelOptions(plan.key, preferences),
    imageEnabled ? listMediaModelOptions(plan.key, 'image', preferences) : Promise.resolve([]),
    videoEnabled ? listMediaModelOptions(plan.key, 'video', preferences) : Promise.resolve([]),
    session
      .from('chat_conversations')
      .select('id, title, model, updated_at')
      .order('updated_at', { ascending: false })
      .limit(100),
    imageEnabled || videoEnabled ? loadMediaAccess(user.id) : Promise.resolve({ accepted: false, suspended: false }),
    imageEnabled ? selectGensiteMediaChannel('image', plan.key, preferences) : Promise.resolve(null),
    videoEnabled ? selectGensiteMediaChannel('video', plan.key, preferences) : Promise.resolve(null),
  ]);
  if (conversations.error) throw new Error('Could not load conversations');
  // Public names and their family only; nothing about sources or upstream ids.
  const families = Object.fromEntries(
    [...chatOptions, ...imageOptions, ...videoOptions].map((option) => [option.id, option.family]),
  );
  // gensite-v1 routes renders too; listed first so Auto picks it.
  const withGensite = (ids: string[], routable: boolean) => (routable ? [GENSITE_MODEL_ID, ...ids] : ids);
  return (
    <>
      <PageHeader
        title="Chat"
        description={imageEnabled || videoEnabled
          ? 'Chat, share files, and generate images or videos. Every render is safety-checked, and generated files are kept for 7 days.'
          : 'Chat, share files, and choose a model.'}
      />
      <ChatWorkspace
        models={chatOptions.map((option) => option.id)}
        imageModels={withGensite(imageOptions.map((option) => option.id), gensiteImage !== null)}
        videoModels={withGensite(videoOptions.map((option) => option.id), gensiteVideo !== null)}
        families={{ ...families, [GENSITE_MODEL_ID]: families[GENSITE_MODEL_ID] ?? 'other' }}
        mediaAccess={mediaAccess}
        initialConversations={conversationSchema.array().parse(conversations.data)}
      />
    </>
  );
}
