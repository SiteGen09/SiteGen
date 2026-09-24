import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { syncDispute } from './disputes';
import { topupMetadata } from './purchases';
const rpc=vi.fn(async()=>({data:100000,error:null}));
const from = vi.fn(() => ({
  select: vi.fn(() => ({
    eq: vi.fn(() => ({
      in: vi.fn(() => ({
        eq: vi.fn(() => ({
          limit: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: { id: 'payment-log-1' }, error: null })),
          })),
        })),
      })),
    })),
  })),
}));
const service={rpc, from} as unknown as SupabaseClient;
const user='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{
  vi.stubEnv('WHOP_API_KEY','test');vi.stubEnv('WHOP_ACCOUNT_ID','biz_test');vi.stubEnv('WHOP_WEBHOOK_SECRET','secret');vi.stubEnv('WHOP_PRODUCT_CREDITS','prod_test');rpc.mockClear();from.mockClear();
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
function mockFetch(account='biz_test') {
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.includes('/disputes/') ?
    {id:'dspt_1',account_id:account,payment:{id:'pay_1'},amount:1250,currency:'usd',status:'needs_response',updated_at:'2026-09-21T00:00:00Z'} :
    {id:'pay_1',account_id:'biz_test',status:'paid',subtotal:1250,total:1250,currency:'usd',product_id:'prod_test',metadata:topupMetadata(user,125000)})));
}
it('repairs a missing payment delivery before freezing and converts dollars exactly',async()=>{
  mockFetch();await syncDispute(service,'dspt_1');
  expect(rpc.mock.calls[0]).toEqual(['sync_whop_purchase',expect.objectContaining({p_user_id:user,p_credits:12500000})]);
  expect(rpc.mock.calls[1]).toEqual(['sync_whop_dispute',expect.objectContaining({p_id:'dspt_1',p_payment:'pay_1',p_amount:125000})]);
});
it('rejects disputes from another merchant without changing accounts',async()=>{
  mockFetch('biz_other');await expect(syncDispute(service,'dspt_1')).rejects.toThrow('account mismatch');expect(rpc).not.toHaveBeenCalled();
});
