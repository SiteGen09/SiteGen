import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, apiError } from '@/lib/api/errors';
import { readTextBody } from '@/lib/api/request-body';
import { parseUsdCents, quoteFromCredits, topupQuote } from '@/lib/billing/catalog';
import { createTopupCheckout } from '@/lib/billing/purchases';
import { logger } from '@/lib/log';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

const quantity = z.union([z.number().finite(), z.string().max(16)]);
const checkoutInput = z.object({
  amountUsd: quantity.optional(),
  credits: quantity.optional(),
  // Retain the original API spelling for existing clients.
  amount: quantity.optional(),
  userId: z.uuid().optional(),
}).strict().refine((value) => [value.amountUsd, value.credits, value.amount].filter((item) => item !== undefined).length === 1);
const admissionSchema = z.object({ allowed: z.boolean(), reason: z.string().optional() });

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ component: 'billing.checkout', request_id: requestId });
  try {
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      throw new ApiError('invalid_request', 'Use application/json', 415);
    }
    const text = await readTextBody(request, 8_192);
    let json: unknown;
    try { json = JSON.parse(text); } catch {
      throw new ApiError('invalid_request', 'Invalid JSON', 400);
    }
    const parsed = checkoutInput.safeParse(json);
    if (!parsed.success) throw new ApiError('invalid_request', 'Provide exactly one of amountUsd or credits, and a valid userId if supplied', 400);
    let cents: number;
    try {
      cents = parsed.data.credits !== undefined
        ? quoteFromCredits(parsed.data.credits).cents
        : parseUsdCents(String(parsed.data.amountUsd ?? parsed.data.amount));
      topupQuote(cents);
    } catch {
      throw new ApiError('invalid_request', 'Enter $1.00 to $2,500.00 USD with at most two decimal places, or a positive whole credit quantity', 400);
    }

    const service = createServiceClient();
    const authorization = request.headers.get('authorization');
    // A bearer token supports API clients using only the listed server env vars.
    // The existing dashboard uses Supabase's verified session cookies.
    const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (authorization && !token) throw new ApiError('unauthorized', 'Invalid bearer token', 401);
    if (!token) {
      const expectedOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://gensite.tech').origin;
      if (request.headers.get('origin') !== expectedOrigin) {
        throw new ApiError('forbidden', 'Invalid request origin', 403);
      }
    }
    const auth = token ? await service.auth.getUser(token) : await (await createClient()).auth.getUser();
    if (auth.error || !auth.data.user) throw new ApiError('unauthorized', 'Sign in required', 401);
    if (parsed.data.userId && auth.data.user.id !== parsed.data.userId) {
      throw new ApiError('forbidden', 'userId must match the signed-in user', 403);
    }
    const { data, error } = await service.rpc('admit_whop_checkout', { p_user_id: auth.data.user.id });
    if (error) throw new Error('Checkout admission failed');
    const admission = admissionSchema.parse(data);
    if (!admission.allowed) {
      if (admission.reason === 'rate_limited') {
        const response = apiError('rate_limited', 'Too many checkout attempts', requestId, 429);
        response.headers.set('Retry-After', '60');
        return response;
      }
      throw new ApiError('forbidden', 'Purchases are unavailable for this account', 403);
    }

    const purchaseId = randomUUID();
    const returnUrl = new URL('/credits/thanks', process.env.NEXT_PUBLIC_APP_URL ?? 'https://gensite.tech');
    returnUrl.searchParams.set('purchase', purchaseId);
    const session = await createTopupCheckout({
      userId: auth.data.user.id, cents, purchaseId, returnUrl: returnUrl.toString(),
    });
    if (!session.sessionId || !session.planId) throw new Error('Incomplete checkout configuration');
    return Response.json({
      sessionId: session.sessionId, checkoutConfigId: session.sessionId, planId: session.planId,
      purchaseUrl: session.url, purchaseId, returnUrl: returnUrl.toString(),
      amountUsd: cents / 100, credits: topupQuote(cents).credits,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ApiError) return apiError(error.code, error.message, requestId, error.status);
    // SDK errors may contain response/request bodies; do not log credentials or metadata.
    log.error('checkout.failed', { error_type: error instanceof Error ? error.name : 'unknown' });
    return apiError('internal_error', 'Checkout is temporarily unavailable', requestId, 503);
  }
}
