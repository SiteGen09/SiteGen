# Whop Billing

Implemented against Whop's 2026-09-15 API contract; documentation reviewed September 21, 2026.

## Catalog

All prices are USD, before any checkout tax or buyer fees. $1 = 10,000 service credits. Custom top-ups use exclusive tax: the entered amount remains the Site Gen subtotal, and Whop calculates and adds applicable buyer-location tax at checkout.

| Offer | Price | Credits | Billing |
| --- | ---: | ---: | --- |
| Starter | $14.99 | 149,000 | Every 30 days |
| Pro | $29.99 | 299,000 | Every 30 days |
| Max | $49.99 | 499,000 | Every 30 days |
| Pack | $10 | 100,000 | Once |
| Pack | $50 | 500,000 | Once |
| Custom top-up | $1.00–$2,500.00 | 10,000 credits per dollar | Once |

Custom amounts accept cents from $1.00 through $2,500.00. Credit input is converted to USD by rounding up to the next cent, with the $1.00 minimum. Max retains Pro's existing request and output limits; its increased allowance is the additional benefit.

## Activate Checkout

1. Set the server-only `WHOP_API_KEY`, `WHOP_ACCOUNT_ID` (`biz_...`), and `WHOP_WEBHOOK_SECRET`. The local API key was empty during implementation, so no live transactions or remote product changes were performed.
2. Configure three Whop USD renewal plans with a 30-day billing period, no trial, and the initial/renewal prices in the catalog. Set `WHOP_PLAN_STARTER`, `WHOP_PLAN_PRO`, and `WHOP_PLAN_MAX`. Checkout retrieves each plan and refuses price, currency, account, interval, or trial mismatches. Verify both the first charge and subsequent renewal in Whop before launch.
3. Create a product for prepaid sitegen AI usage and set `WHOP_PRODUCT_CREDITS=prod_...`. The server creates inline one-time plans for the selected amount. The old `WHOP_PLAN_TOPUP` setting is no longer used.
4. Use USD settlement. Keep the Whop account enrolled with `tax_remitted_by=whop` and `tax_type=exclusive`; inline top-up plans also set `override_tax_type=exclusive`. Disable promotional discounts for these plans/products; discounted or mismatched receipts are rejected rather than over-crediting. Taxes/fees do not earn credits.
5. Set `NEXT_PUBLIC_APP_URL` to the canonical HTTPS app origin in production.
6. Apply `20260921063000_whop_purchases.sql`, `20260921070000_redemption_codes.sql`, `20260921080000_billing_orders_disputes.sql`, and `20260922010000_whop_fulfillment.sql` from `supabase/migrations` to the deployment database before deploying. All four are required before this webhook route can write safely. Do not blindly replay unrelated migrations; this workspace contains independent work.
7. Register `https://gensite.tech/api/webhooks/whop` for `payment.succeeded`, `payment.failed`, `membership.activated`, `membership.deactivated`, `refund.created`, `refund.updated`, `dispute.created`, and `dispute.updated`, pinned to `2026-09-15`. Grant the API credential permissions to create checkout configurations and read plans, payments, memberships, and account data. Disputes additionally require `payment:dispute:read` and `webhook_receive:disputes`.
8. Complete a Whop test purchase, renewal, cancellation, partial refund, full refund, and delivery replay before accepting live sales. This was not possible without the API key.

## Accounting

The return URL grants nothing. It polls for the signed-in user's purchase identifier in the ledger, including payments confirmed before the redirect. Webhooks verify the original body signature and replay window, then verify the merchant account. Payment/refund events re-read the receipt from Whop. Top-ups use signed user/amount metadata and product verification; amount and credits never come from a trusted browser field.

Only verified `payment.succeeded` receipts grant credits. Membership events and nightly membership reconciliation only update access. `sync_whop_purchase` serializes by payment ID, grants once, and subtracts cumulative refunded credits. It supports refunds arriving before purchase delivery and prevents old refund totals from restoring credits. Refunds can make the balance negative after credits have been spent.

Failed deliveries return 500 for retry. Audit events are recorded after effects so a premature event marker cannot swallow an incomplete purchase. Monitor failed webhook deliveries and replay them from Whop after resolving the cause. Dispute events retrieve the latest dispute and verified payment, repair missing payment delivery, record the case, and freeze the account. Evidence submission and refund decisions remain in Whop. A freeze does not itself reverse credits; confirmed refunds drive credit adjustments.

Existing customers must not be silently repriced: create new plan IDs or follow Whop's supported migration/consent process. The local database had no linked paid memberships. If deploying to a database with legacy period-based grants or old top-up sales, reconcile those purchases before replaying historical payment events to prevent overlapping grants.

## Policy Review

The official Whop Checkout Embed keeps checkout on the billing page and card entry with Whop. Bank/3DS or wallet authorization may require a separate window. Subscription management and evidence submission link to Whop. The app discloses recurring billing, credit amounts, bonuses, service-only use, cancellation, refund handling, and billing data processing. It does not promise lifetime service access, cash withdrawals, transfers, or investment returns. Custom checkout is capped at Whop's published initial $2,500 limit; higher amounts require their approval.

These safeguards are not Whop approval or a legal guarantee. Confirm that Whop accepts this specific prepaid AI usage product and the way upstream models are provided. Verify authorization to resell provider access, merchant identity/business verification, accurate product descriptions, support/refund operations, applicable taxes, and the site's complete privacy/service policies before launch. The billing terms page is a billing-specific disclosure, not a full privacy policy for all generation data.

References:
- https://whop.com/tos/
- https://whop.com/tos-developer-api/
- https://docs.whop.com/trust-and-safety/trust-safety-overview/what-is-not-allowed-on-whop
- https://docs.whop.com/manage-your-business/payment-processing/access-higher-checkout-links
- https://docs.whop.com/api-reference/beta/checkout-configurations/create-a-checkout-configuration
- https://docs.whop.com/api-reference/beta/payments/retrieve-payment
- https://docs.whop.com/developer/guides/webhooks

## Verification

`pnpm exec vitest run lib/billing` covers catalog arithmetic, checkout validation, signatures, attribution, receipt amounts, refunds, renewal grants, and reconciliation.

`pnpm exec tsx scripts/verify-whop-billing.mts --migrate` applies only this billing migration to a local database and exercises concurrent duplicate payments and out-of-order refunds. It creates and cleans up an isolated local fixture. Omit `--migrate` to only verify.

`pnpm exec tsx scripts/verify-billing-page.mts http://localhost:3001` checks the authenticated server-rendered billing page, public terms, and purchase confirmation endpoint against a local running app, using a temporary local user. Visual browser inspection was unavailable because the browser tool could not obtain its app authentication token.

## Admin and customer controls

- `/dashboard/billing` contains embedded checkout and code redemption; `/dashboard/billing/history` shows the signed-in customer's payments and redeemed codes.
- `/admin/orders` filters payments by customer/payment ID, purchase type, and dispute presence. Customer links show their payment history. Orders are recorded from paid receipts, including subsequent refunds. Abandoned checkouts and failed attempts do not appear as paid orders.
- `/admin/leaderboard` ranks current balance, lifetime net top-up credits, or lifetime net subscription credits. Separate aggregates avoid multiplying balances by order counts. Promotional codes affect balance but not paid purchase totals.
- `/admin/redemption-codes` creates codes, limits total redemptions, sets expiry, and revokes availability. Each code has a View redemptions link showing customer email, account ID, credits received, and redemption time (UTC), with pagination and a link to customer orders. This view is admin-only. Deleting an account removes its redemption details under the existing retention rules; the code's total usage count remains. Full codes appear once; only HMAC hashes and partial prefixes are stored. Each code can be redeemed once per account. Attempts are limited to ten per minute per account. Set a stable `REDEMPTION_CODE_PEPPER` before issuing codes; back it up and do not rotate it while codes remain active. The compatibility fallback is the webhook secret, then the service key; changing the effective secret invalidates outstanding codes.
- `/admin/disputes` shows case status, evidence deadline, customer, and payment. Disputes freeze new generation/API requests, checkout, and redemption. Existing in-flight generation may finish. Billing history remains accessible. Submit evidence in Whop. Only won or closed cases can be reviewed for release; every dispute for that customer must be reviewed. Manual suspensions remain intact. Lost disputes stay frozen. Each release requires a note and is audited in the same transaction.

Orders and refund accounting commit together under a per-payment lock. Dispute snapshots use the provider update time to reject stale deliveries. A replay after review cannot re-freeze the account; a reopened resolved dispute can. New private tables enable RLS and expose no browser access. Every admin page/action independently checks the admin role.

`pnpm exec tsx scripts/verify-billing-controls.mts --migrate` applies the two local control migrations and exercises database concurrency, account freezes, redemption, and reporting. Without `--migrate` it only verifies. Fixtures are temporary and cleaned up. The billing page verification also checks the new pages, admin denial for a customer, and the freeze banner.

Additional API references:
- https://docs.whop.com/payments/checkout-embed
- https://docs.whop.com/api-reference/beta/disputes/dispute
