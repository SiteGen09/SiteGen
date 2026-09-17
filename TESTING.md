# System Testing Guide

## Prerequisites

1. **Get fresh kie.ai API key** (rotate the compromised one)
2. **Ensure infrastructure is running:**
   ```bash
   docker ps  # Should show Supabase containers
   curl http://localhost:3000/healthz  # Should return {"ok":true,"db":true}
   ```
3. **Export your platform API key** so the curl examples below can use it.
   Never paste a real key into this file:
   ```bash
   export SITEGEN_API_KEY='sk_live_...'   # from Dashboard -> API keys
   ```

## Setup Steps

### 1. Add kie.ai pricing (already done)
Pricing for `gemini-3-8-flash` added to `lib/ai/pricing.ts`

### 2. Add encrypted kie.ai credential
```bash
cd E:/sitegen
ENCRYPTION_KEY=$(grep '^ENCRYPTION_KEY=' .env.local | cut -d'=' -f2-) \
KIE_API_KEY=your-new-kie-api-key \
node scripts/add-kie-cred.js
```

Expected output:
```
✓ kie.ai credential added: <uuid>
```

### 3. Add kie.ai channel
```bash
pnpm supabase db query -f scripts/add-kie-channel.sql
```

Expected output shows the channel with `base_url: https://api.kie.ai/gemini-3-8-flash-openai/v1`

### 4. Verify channel priority
```bash
pnpm supabase db query "SELECT id, label, provider, base_url, priority, status FROM channels ORDER BY priority DESC;"
```

Should show:
- `spec-stub` (priority 100) - will try first
- `spec-kie-gemini` (priority 40) - fallback if stub unavailable

---

## Test 1: Basic Generate Flow

```bash
curl -X POST http://localhost:3000/v1/generate \
  -H "Authorization: Bearer $SITEGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-basic-$(date +%s)" \
  -d '{
    "businessName": "Mountain Brew Coffee",
    "businessType": "cafe",
    "description": "Organic coffee roastery in Colorado"
  }' | jq '{
    success: (.spec != null),
    pages: (.spec.pages | length),
    channel: .usage.channel_id,
    tokens: {input: .usage.input_tokens, output: .usage.output_tokens},
    credits: .usage.credits_charged,
    balance: .usage.balance_after
  }'
```

**Expected:**
```json
{
  "success": true,
  "pages": 3,
  "channel": "spec-stub",
  "tokens": {"input": 1420, "output": 2890},
  "credits": 7,
  "balance": 9965
}
```

---

## Test 2: Token Counting & Credit Math

Check the ledger shows correct hold → release → settle:

```bash
cd E:/sitegen && node -e "
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'http://127.0.0.1:54321',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { data } = await supabase
    .from('ledger')
    .select('kind, credits, channel_id')
    .eq('user_id', '00000000-0000-0000-0000-000000000000')
    .order('created_at', { ascending: false })
    .limit(3);
  
  console.log('Last 3 ledger entries:');
  data.forEach(r => console.log(\`  \${r.kind.padEnd(8)} \${String(r.credits).padStart(6)} credits  [\${r.channel_id}]\`));
}
check();
"
```

**Expected:**
```
Last 3 ledger entries:
  settle       -7 credits  [spec-stub]
  release      21 credits  [spec-stub]
  hold        -21 credits  [spec-stub]
```

**Verify credit math:**
- Input: 1420 tokens × $0.0005/1000 = $0.00071
- Output: 2890 tokens × $0.0020/1000 = $0.00578
- Total: $0.00649 USD
- Multiplier: 0.1 (10%)
- Credits: ceil(0.00649 / 0.0001 × 0.1) = ceil(6.49 × 0.1) = ceil(0.649) = **7 credits** ✓

---

## Test 3: Idempotency (No Double Charge)

```bash
IDEMPOTENCY_KEY="test-idempotency-$(date +%s)"
BODY='{"businessName":"Idempotency Test","businessType":"cafe","description":"test"}'

echo "=== First call ==="
curl -s -X POST http://localhost:3000/v1/generate \
  -H "Authorization: Bearer $SITEGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "$BODY" | jq '{balance: .usage.balance_after, request_id: .usage.request_id}'

echo ""
echo "=== Second call (should be cached) ==="
curl -s -X POST http://localhost:3000/v1/generate \
  -H "Authorization: Bearer $SITEGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "$BODY" | jq '{balance: .usage.balance_after, request_id: .usage.request_id, note: "same request_id = cached"}'
```

**Expected:**
- Both calls return same `request_id`
- Both calls return same `balance` (no second charge)
- Second call is instant (no provider call)

---

## Test 4: Idempotency Conflict Detection

```bash
IDEMPOTENCY_KEY="test-conflict-$(date +%s)"

curl -s -X POST http://localhost:3000/v1/generate \
  -H "Authorization: Bearer $SITEGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"businessName":"First","businessType":"cafe","description":"first"}' > /dev/null

echo "Reusing same key with different body:"
curl -s -X POST http://localhost:3000/v1/generate \
  -H "Authorization: Bearer $SITEGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"businessName":"Second","businessType":"different","description":"different"}' | jq .
```

**Expected:**
```json
{
  "error": {
    "code": "idempotency_conflict",
    "message": "idempotency key was already used with a different request body",
    "request_id": "..."
  }
}
```

---

## Test 5: Insufficient Credits (402 Error)

Drain the balance first:

```bash
cd E:/sitegen && pnpm supabase db query "
INSERT INTO ledger (user_id, request_id, kind, credits)
VALUES ('00000000-0000-0000-0000-000000000000', 'drain-balance', 'settle', -9950);
"

# Verify low balance
cd E:/sitegen && node -e "
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'http://127.0.0.1:54321',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
supabase.rpc('get_balance', {p_user_id: '00000000-0000-0000-0000-000000000000'})
  .then(({data}) => console.log('Balance:', data, 'credits'));
"

# Try to generate (should fail)
curl -s -X POST http://localhost:3000/v1/generate \
  -H "Authorization: Bearer $SITEGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-insufficient-$(date +%s)" \
  -d '{"businessName":"Test","businessType":"cafe","description":"test"}' | jq .
```

**Expected:**
```json
{
  "error": {
    "code": "insufficient_credits",
    "message": "...",
    "request_id": "..."
  }
}
```

---

## Test 6: Rate Limiting (429 Error)

Check the API key's rate limit:

```bash
cd E:/sitegen && pnpm supabase db query "
SELECT rate_limit_rpm FROM api_keys 
WHERE key_hash = encode(sha256('$SITEGEN_API_KEY'::bytea), 'hex');
"
```

If it's 60 RPM, fire 61 requests rapidly:

```bash
for i in {1..61}; do
  curl -s -X POST http://localhost:3000/v1/generate \
    -H "Authorization: Bearer $SITEGEN_API_KEY" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: rate-test-$i" \
    -d '{"businessName":"Rate'$i'","businessType":"cafe","description":"test"}' &
done
wait
```

**Expected:** At least one response with:
```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "...",
    "request_id": "..."
  }
}
```

---

## Test 7: Real kie.ai Provider Call

**Stop the stub provider** so requests fall through to kie.ai:

```bash
# Find and kill the stub process
ps aux | grep stub-provider | grep -v grep
# Kill it with: kill <PID>

# Or just let it fail naturally (stub priority is higher)
```

Then make the stub channel unavailable:

```bash
pnpm supabase db query "UPDATE channels SET status = 'off' WHERE id = 'spec-stub';"
```

Now generate with kie.ai:

```bash
curl -X POST http://localhost:3000/v1/generate \
  -H "Authorization: Bearer $SITEGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-kie-$(date +%s)" \
  -d '{
    "businessName": "Real Coffee Co",
    "businessType": "cafe",
    "description": "Testing real kie.ai generation"
  }' | jq '{
    success: (.spec != null),
    channel: .usage.channel_id,
    tokens: {input: .usage.input_tokens, output: .usage.output_tokens},
    credits: .usage.credits_charged,
    latency: .usage.latency_ms
  }'
```

**Expected:**
```json
{
  "success": true,
  "channel": "spec-kie-gemini",
  "tokens": {"input": <real>, "output": <real>},
  "credits": <calculated with 1.5× multiplier>,
  "latency": <actual API latency>
}
```

The spec will be generated by real Gemini Flash via kie.ai, with real token counts and 50% markup applied.

---

## Test 8: Cross-Tenant Isolation

Run the existing isolation test:

```bash
cd E:/sitegen
pnpm vitest run tests/isolation.test.ts
```

**Expected:** All 14 assertions pass:
- User A cannot read User B's data
- User A cannot modify User B's resources
- Anonymous users read nothing

---

## Test 9: Credit Concurrency Safety

Run the existing concurrency test:

```bash
cd E:/sitegen
pnpm vitest run tests/credits-concurrency.test.ts
```

**Expected:** All 6 scenarios pass, including:
- Parallel holds never overdraw
- SERIALIZABLE isolation prevents race conditions

---

## Verification Checklist

After running all tests, verify:

- [ ] Site specs generated successfully
- [ ] Real token counts used (not estimates)
- [ ] Credit math correct (tokens × pricing × multiplier)
- [ ] Idempotency prevents double charges
- [ ] Insufficient credits rejected with 402
- [ ] Rate limiting works (429 after limit)
- [ ] kie.ai provider works end-to-end
- [ ] Ledger shows hold → release → settle for every request
- [ ] Cross-tenant isolation maintained
- [ ] Concurrent requests don't overdraw
- [ ] No secrets in error responses
- [ ] All responses have `request_id`

---

## Your Three Pillars - Final Status

### 1. RETAIL MARGIN & TRANSACTION PROTECTION ✅
- **Token counting**: Real counts from provider responses, not estimates
- **Race conditions**: `SELECT FOR UPDATE` prevents overdraw
- **Payment gateway fees**: ❌ NOT IMPLEMENTED (would need to add to credit calculation)

### 2. AUTOMATED DOWNSTREAM MODERATION LOOP ❌
- **Pre-filtering**: NOT BUILT (not in Phase 1 scope)
- **User suspension**: NOT BUILT
- **Dangerous prompt detection**: NOT BUILT
- **Note**: This generates site specs from business descriptions, not a general chat proxy

### 3. API GATEWAY PROXY & KEY SECURE ISOLATION ✅
- **Master keys server-side**: Encrypted in DB, decrypted in-process only
- **Custom API key system**: SHA-256 hashing, constant-time compare
- **Error handling**: Structured responses with `request_id`, no stack traces leaked
- **Rate limiting**: Postgres-backed, works across instances
