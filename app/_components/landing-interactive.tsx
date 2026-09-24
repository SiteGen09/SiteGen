'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import {
  CREDITS_PER_USD,
  MIN_TOPUP_CENTS,
  MAX_TOPUP_CENTS,
  TOPUP_PRESETS,
  formatUsd,
  parseUsdCents,
  topupQuote,
} from '@/lib/billing/catalog';
import { Icon, type IconName } from './landing-icons';
import { SitegenLogo, SitegenMark } from './sitegen-logo';
import styles from '../landing.module.css';

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  return (
    <header className={styles.header} onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        setOpen(false);
        menuButton.current?.focus();
      }
    }}>
      <div className={styles.headerInner}>
        <Link href="/" className={styles.logo} aria-label="sitegen home">
          <SitegenLogo />
        </Link>
        <nav id="landing-navigation" className={`${styles.nav} ${open ? styles.navOpen : ''}`} aria-label="Main navigation">
          <a href="#possibilities" onClick={() => setOpen(false)}>Possibilities</a>
          <a href="#pricing" onClick={() => setOpen(false)}>Pricing</a>
          <a href="#faq" onClick={() => setOpen(false)}>FAQ</a>
          <Link href="/docs" onClick={() => setOpen(false)}>Docs</Link>
          <div className={styles.navCta}>
            <Link href="/login" className={styles.signIn} onClick={() => setOpen(false)}>Sign in</Link>
            <Link href="/signup" className={styles.navButton} onClick={() => setOpen(false)}>Start creating <Icon name="arrow-right" size={16} /></Link>
          </div>
        </nav>
        <button ref={menuButton} type="button" className={styles.menuButton} aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="landing-navigation" onClick={() => setOpen((value) => !value)}>
          <Icon name={open ? 'close' : 'menu'} size={20} />
        </button>
      </div>
    </header>
  );
}

const previewModes = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'api', label: 'Build', icon: 'code' },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName }>;

export function WorkspacePreview() {
  const [mode, setMode] = useState<(typeof previewModes)[number]['id']>('chat');

  return (
    <div className={styles.workspaceShell}>
      <div className={styles.workspaceChrome}>
        <div className={styles.chromeDots} aria-hidden="true"><i /><i /><i /></div>
        <span>your space to create</span>
        <span className={styles.demoLabel}>PREVIEW</span>
      </div>
      <div className={styles.studioHeader}>
        <div className={styles.studioBrand}><SitegenMark /><span>Creative space</span></div>
        <div className={styles.workspaceModes} role="group" aria-label="Explore workspace examples">
          {previewModes.map(({ id, label, icon }) => (
            <button type="button" key={id} aria-pressed={mode === id} aria-controls="workspace-example" className={mode === id ? styles.modeActive : ''} onClick={() => setMode(id)}>
              <Icon name={icon} size={15} />{label}
            </button>
          ))}
        </div>
      </div>
      <div id="workspace-example" className={`${styles.exampleContent} ${mode !== 'chat' ? styles.textExample : ''}`}>
        {mode === 'chat' && (
          <div className={styles.chatExample}>
            <span className={styles.exampleEyebrow}>A LITTLE CREATIVE BACK-AND-FORTH</span>
            <div className={styles.demoPrompt}>Help me turn this desert scene into a launch campaign.</div>
            <div className={styles.demoAnswer}>
              <SitegenMark />
              <div><strong>Let’s start with a feeling.</strong><p>Make the familiar feel extraordinary. Build your campaign around the moment an idea becomes a possibility.</p><span>“Your next world starts here.”</span></div>
            </div>
            <span className={styles.exampleLabel}>Example conversation</span>
          </div>
        )}
        {mode === 'api' && (
          <div className={styles.apiExample}>
            <div><Icon name="code" size={17} /><span>One connection. More possibilities.</span></div>
            <pre><code><span className={styles.codeComment}>{'// Your idea, connected.'}</span>{'\n'}<span className={styles.codeKeyword}>const</span>{' response = await fetch(\n  "/v1/chat/completions", {\n    method: '}<span className={styles.codeString}>&quot;POST&quot;</span>{',\n    headers: {\n      Authorization: '}<span className={styles.codeString}>{'`Bearer ${apiKey}`'}</span>{',\n      '}<span className={styles.codeString}>&quot;Content-Type&quot;</span>{': '}<span className={styles.codeString}>&quot;application/json&quot;</span>{'\n    },\n    body: JSON.stringify({\n      model: selectedModel,\n      messages: yourConversation\n    })\n  }\n);'}</code></pre>
            <span className={styles.exampleLabel}>Server-side API example</span>
          </div>
        )}
      </div>
      <div className={styles.promptCaption} aria-live="polite">
        <Icon name="sparkles" size={17} />
        <p>{mode === 'chat' ? 'A fresh perspective is a conversation away.' : 'Bring your favorite models into your own apps.'}</p>
      </div>
      <div className={styles.studioFooter}>
        <span>Your idea. Your next creation.</span>
        <Link href={mode === 'api' ? '/setup' : '/signup'}>{mode === 'api' ? 'Connect your tools' : 'Try your own idea'} <Icon name="arrow-up-right" size={15} /></Link>
      </div>
    </div>
  );
}

type Plan = {
  key: string;
  label: string;
  priceCents: number;
  credits: number;
  requestsPerMinute: number;
  maxOutputTokens: number;
};

const planDescriptions: Record<string, string> = {
  starter: 'For your first sparks and everyday ideas.',
  pro: 'For a little more ambition. Every day.',
  max: 'More credits for your biggest projects.',
};

export function PricingOptions({ plans }: { plans: Plan[] }) {
  const [view, setView] = useState<'plans' | 'credits'>('plans');
  const [creditAmount, setCreditAmount] = useState('10');
  let quote: ReturnType<typeof topupQuote> | null = null;
  try {
    quote = topupQuote(parseUsdCents(creditAmount));
  } catch {
    // Keep an incomplete or invalid input visible without inventing a quote.
  }

  return (
    <div className={styles.pricingWrap}>
      <div className={styles.pricingToggle} role="group" aria-label="Pricing options">
        <button type="button" aria-pressed={view === 'plans'} aria-controls="pricing-options" className={view === 'plans' ? styles.toggleActive : ''} onClick={() => setView('plans')}>Monthly plans</button>
        <button type="button" aria-pressed={view === 'credits'} aria-controls="pricing-options" className={view === 'credits' ? styles.toggleActive : ''} onClick={() => setView('credits')}>Pay as you go</button>
      </div>
      <div id="pricing-options">
        {view === 'plans' ? (
          <div className={styles.planGrid}>
            {plans.map((plan) => (
              <article key={plan.key} className={`${styles.planCard} ${plan.key === 'pro' ? styles.planFeatured : ''}`}>
                <div className={styles.planTop}><h3>{plan.label}</h3>{plan.key === 'pro' && <b>For daily creators</b>}</div>
                <span className={styles.planDescription}>{planDescriptions[plan.key]}</span>
                <div className={styles.planPrice}><strong>{formatUsd(plan.priceCents)}</strong><span>/ 30 days</span></div>
                <p>{plan.credits.toLocaleString('en-US')} credits per paid period</p>
                <div className={styles.planRule} />
                <ul>
                  <li><Icon name="check" size={15} /> Chat models and enabled capabilities</li>
                  <li><Icon name="check" size={15} /> Usage tracking & API access</li>
                  <li><Icon name="check" size={15} /> {plan.requestsPerMinute} requests / minute</li>
                  <li><Icon name="check" size={15} /> Up to {plan.maxOutputTokens.toLocaleString('en-US')} output tokens</li>
                </ul>
                <Link href="/dashboard/billing" className={plan.key === 'pro' ? styles.planButtonDark : styles.planButton}>Get {plan.label} <Icon name="arrow-right" size={15} /></Link>
              </article>
            ))}
          </div>
        ) : (
          <div className={styles.creditCard}>
            <div>
              <p className={styles.eyebrow}><span /> MAKE ROOM FOR MORE</p>
              <h3>Your pace. Your budget.</h3>
              <p>Add credits from {formatUsd(MIN_TOPUP_CENTS)}, then use them as you create. One payment, no subscription.</p>
              <div className={styles.creditPresets} role="group" aria-label="Credit pack examples">
                {TOPUP_PRESETS.map((amount) => <button key={amount} type="button" aria-pressed={creditAmount === String(amount / 100)} onClick={() => setCreditAmount(String(amount / 100))}>{formatUsd(amount)}{topupQuote(amount).bonusPercent > 0 && <small>+{topupQuote(amount).bonusPercent}%</small>}</button>)}
              </div>
              <label className={styles.amountLabel} htmlFor="credit-estimate">Or choose an amount (USD)</label>
              <div className={styles.creditInput}>
                <span>$</span>
                <input id="credit-estimate" aria-describedby="credit-quote credit-range" aria-invalid={quote === null} type="number" min={MIN_TOPUP_CENTS / 100} max={MAX_TOPUP_CENTS / 100} step="0.01" value={creditAmount} onChange={(event) => setCreditAmount(event.target.value)} />
                <span>USD</span>
              </div>
              <p id="credit-range" className={styles.creditRange}>{formatUsd(MIN_TOPUP_CENTS)}–{formatUsd(MAX_TOPUP_CENTS)} per purchase</p>
              <p id="credit-quote" className={styles.creditQuote} aria-live="polite">{quote ? <>{quote.credits.toLocaleString('en-US')} credits{quote.bonusPercent > 0 ? ` · ${quote.bonusPercent}% bonus included` : ' · one-time purchase'}</> : 'Enter a valid amount to see your credits.'}</p>
              <Link href="/dashboard/billing" className={styles.planButtonDark}>Buy credits <Icon name="arrow-right" size={15} /></Link>
            </div>
            <div className={styles.creditArt} aria-hidden="true"><div className={styles.creditOrb} /><div className={styles.creditLines} /><span>$1 = {CREDITS_PER_USD.toLocaleString('en-US')} credits</span></div>
          </div>
        )}
      </div>
      <p className={styles.accountNote}>New around here? <Link href="/signup">Create your free account</Link>, then choose your plan in Billing.</p>
    </div>
  );
}
