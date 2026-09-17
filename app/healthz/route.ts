import { createServiceClient } from '@/lib/supabase/service';

/**
 * Liveness + database reachability probe. Runs a bounded, index-only count on a
 * small table so it touches the connection without scanning data. Returns 503
 * when the query errors or throws so a load balancer can drain the instance.
 */
export async function GET(): Promise<Response> {
  try {
    const service = createServiceClient();
    const { error } = await service
      .from('channels')
      .select('id', { count: 'exact', head: true });

    if (error !== null) {
      return Response.json({ ok: false, db: false }, { status: 503 });
    }
    return Response.json({ ok: true, db: true }, { status: 200 });
  } catch {
    return Response.json({ ok: false, db: false }, { status: 503 });
  }
}
