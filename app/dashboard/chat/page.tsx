import { listMediaModels, listPublicModels } from '@/lib/ai/channels';
import { loadRoutingPreferences } from '@/lib/ai/sources';
import { loadPlan } from '@/lib/chat/pipeline';
import { conversationSchema } from '@/lib/chat/conversations';
import { requireUser } from '@/lib/dashboard/session';
import { mediaAvailability } from '@/lib/media/availability';
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
  const [models, imageModels, videoModels, conversations] = await Promise.all([
    listPublicModels(plan.key, preferences),
    mediaAvailability('image').enabled ? listMediaModels(plan.key, 'image', preferences) : Promise.resolve([]),
    mediaAvailability('video').enabled ? listMediaModels(plan.key, 'video', preferences) : Promise.resolve([]),
    session
      .from('chat_conversations')
      .select('id, title, model, updated_at')
      .order('updated_at', { ascending: false })
      .limit(100),
  ]);
  if (conversations.error) throw new Error('Could not load conversations');
  return (
    <>
      <PageHeader
        title="Chat"
        description="Chat, share files, and choose a model. Visual generation will appear here after its safety checks are enabled."
      />
      <ChatWorkspace
        models={models}
        imageModels={imageModels}
        videoModels={videoModels}
        initialConversations={conversationSchema.array().parse(conversations.data)}
      />
    </>
  );
}
