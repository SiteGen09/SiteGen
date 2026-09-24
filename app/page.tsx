import type { Metadata } from 'next';
import Link from 'next/link';
import { getPlans } from '@/lib/billing/plans';
import { MIN_TOPUP_CENTS, formatUsd } from '@/lib/billing/catalog';
import { LandingHeader, WorkspacePreview, PricingOptions } from './_components/landing-interactive';
import { Icon } from './_components/landing-icons';
import { SitegenLogo, SitegenMark } from './_components/sitegen-logo';
import styles from './landing.module.css';
import { SUPPORT_EMAIL } from '@/lib/site-config';

export const metadata: Metadata = {
  title: 'sitegen — A universe of AI. Yours to create.',
  description: 'Bring your ideas to life with AI chat and a developer API in one workspace.',
  openGraph: { title: 'A universe of AI. Yours to create.', description: 'Chat, create, and build with your favorite AI models. All in sitegen.', type: 'website' },
};

const questions = [
  ['What can I do with sitegen?', 'Chat with AI, work through ideas, share files, and connect your apps through our API for chat completions and structured site specifications. Visual generation will appear after its safety and provider setup is complete.'],
  ['Is it free to get started?', 'Creating an account is free and does not require a card. AI usage is paid: add prepaid credits starting at $1, or choose a recurring plan with credits included. Free accounts do not include a monthly credit allowance.'],
  ['How do credits work?', 'Every $1 USD purchases 10,000 credits. Each request uses credits according to the selected model and source. Chat usage is priced by tokens; additional capabilities will show their rates when enabled. Compare current rates on the Model prices page and track charges in your dashboard.'],
  ['Can I use my own API keys?', 'Yes. Add your provider credentials in your dashboard and select a source that supports your own keys. Your provider bills that usage directly. Availability depends on the model, source, and your plan.'],
  ['Can I cancel my subscription?', 'You can manage or cancel your subscription through your Whop orders. Plans renew every 30 days until canceled. Canceling stops future renewals; one-time credit purchases do not create a subscription. See our billing terms for the full details.'],
] as const;

export default function LandingPage() {
  const plans = getPlans();
  const publicPlans = (['starter', 'pro', 'max'] as const).map((key) => ({ key, label: plans[key].label, priceCents: plans[key].priceCents, credits: plans[key].monthlyCredits, requestsPerMinute: plans[key].rateLimitRpm, maxOutputTokens: plans[key].maxOutputTokens }));

  return <div className={styles.page}>
    <a className={styles.skipLink} href="#main-content">Skip to content</a>
    <LandingHeader />
    <main id="main-content">
      <section className={`${styles.container} ${styles.hero}`} aria-labelledby="hero-heading">
        <div className={styles.gravityField} aria-hidden="true"><div className={styles.gravityHalo} /><div className={styles.gravityOrbit} /><div className={styles.gravityOrbitOuter} /><div className={styles.gravityStars} /></div>
        <div className={styles.heroCopy}>
          <a href="#workspace" className={styles.announcement}><span className={styles.announcementDot} />Your ideas have a new center of gravity.<Icon name="arrow-up-right" size={14} /></a>
          <h1 id="hero-heading">A universe of AI.<br /><span>Yours to create.</span></h1>
          <p className={styles.heroDescription}>The models you love. The space to do more.<br />Chat, build, and bring your ideas into focus.<br className={styles.desktopBreak} /> One workspace. One balance. All your possibilities.</p>
          <div className={styles.heroActions}><Link href="/signup" className={styles.buttonPrimary}>Enter your workspace <Icon name="arrow-right" /></Link><a href="#pricing" className={styles.buttonSecondary}>Explore pricing <Icon name="arrow-up-right" size={16} /></a></div>
          <div className={styles.heroAssurances}><span><Icon name="check" size={14} /> Free account</span><span><Icon name="check" size={14} /> No card to sign up</span></div>
        </div>
        <div id="workspace" className={styles.heroPreview}>
          <div className={styles.previewOrbit} aria-hidden="true" />
          <div className={styles.orbitLabel}><Icon name="chat" size={16} /><span>Think bigger</span></div>
          <div className={styles.orbitLabelRight}><Icon name="code" size={17} /><span>Build beyond</span></div>
          <WorkspacePreview />
          <div className={styles.floatingNote}><span className={styles.floatingNoteIcon}><Icon name="sparkles" size={19} /></span><div><strong>A prompt. A possibility.</strong><span>Make something that didn’t exist.</span></div></div>
          <p className={styles.previewCaption}>ONE PROMPT. A NEW POSSIBILITY. <span aria-hidden="true">↗</span></p>
        </div>
      </section>

      <section className={`${styles.container} ${styles.modelStrip}`} aria-label="Supported model families"><p>Great models.<br /><strong>Even better together.</strong></p><div className={styles.modelNames}><span>OpenAI-compatible</span><span>Anthropic-compatible</span><span>Google-compatible</span><span>DeepSeek-compatible</span><Link href="/prices" className={styles.moreModels}>Explore models <Icon name="arrow-up-right" size={15} /></Link></div></section>

      <section id="possibilities" className={`${styles.container} ${styles.possibilities}`} aria-labelledby="possibilities-heading"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}><span /> LESS SWITCHING. MORE CREATING.</p><h2 id="possibilities-heading">An idea is all you need.<br /><span>Take it anywhere.</span></h2></div><p>Meet your thinking partner, creative studio, and building blocks. All under one roof.</p></div>
        <div className={styles.featureGrid}>
          <article className={`${styles.featureCard} ${styles.chatFeature}`}><div className={styles.featureLabel}><Icon name="chat" size={17} /><span>THINK IT THROUGH</span><span className={styles.featureNumber}>01</span></div><div className={styles.chatIllustration} aria-hidden="true"><div className={styles.miniPrompt}>A big idea. Where do I start?<span>↗</span></div><div className={styles.miniResponse}><span className={styles.miniMark}><SitegenMark /></span><div><strong>Let’s make a plan.</strong><span className={styles.responseLine} /><span className={styles.responseLineShort} /><div className={styles.ideaTags}><span>Find the angle</span><span>Make it happen</span></div></div></div></div><h3>A fresh perspective.<br />Whenever you need it.</h3><p>Untangle a problem, polish your writing, or find your next big idea with an AI thinking partner.</p><Link href="/dashboard/chat" className={styles.textLink}>Find your flow <Icon name="arrow-up-right" size={17} /></Link></article>
          <article className={`${styles.featureCard} ${styles.createFeature}`}><div className={styles.featureLabel}><Icon name="sparkles" size={17} /><span>BRING IT TO LIFE</span><span className={styles.featureNumber}>02</span></div><div className={styles.creationIllustration} aria-hidden="true"><div className={styles.artTile}><div className={styles.artSphere} /><span>IMAGINATION, IN FRAME.</span></div><div className={styles.artSticker}><Icon name="sparkles" size={13} /> Shape the idea.</div><div className={styles.videoTile}><Icon name="code" size={18} /><div>{Array.from({ length: 11 }).map((_, i) => <span key={i} />)}</div></div></div><h3>From “what if”<br />to “let’s make a plan.”</h3><p>Work through a direction with an AI thinking partner, then connect the finished idea to your tools.</p><Link href="/dashboard/chat" className={styles.textLink}>Start exploring <Icon name="arrow-up-right" size={17} /></Link></article>
          <article className={`${styles.featureCard} ${styles.buildFeature}`}><div className={styles.featureLabel}><Icon name="code" size={18} /><span>BUILD WHAT’S NEXT</span><span className={styles.featureNumber}>03</span></div><div className={styles.codeIllustration} aria-hidden="true"><div className={styles.codeDots}><i /><i /><i /><span>your-next-big-thing.ts</span></div><div className={styles.miniCode}><span><em>const</em> possibility = <em>await</em></span><span>  ai.chat.completions.<strong>create</strong>({'{'}</span><span>    model: <b>yourFavoriteModel</b>,</span><span>    messages: [<b>yourBigIdea</b>],</span><span>  {'}'});</span></div><div className={styles.codeReady}><span /> Your idea, connected.</div></div><h3>Your stack.<br />A world of AI.</h3><p>Connect your apps and favorite tools to a familiar API. Choose your model and keep building.</p><Link href="/setup" className={styles.textLink}>Meet your new toolkit <Icon name="arrow-up-right" size={17} /></Link></article>
        </div>
      </section>

      <section className={styles.controlSection} aria-labelledby="control-heading"><div className={`${styles.container} ${styles.controlInner}`}><div className={styles.controlCopy}><p className={styles.eyebrow}><span /> YOUR WORKSPACE. YOUR WAY.</p><h2 id="control-heading">More possibility.<br /><span>Less guesswork.</span></h2><p>Good tools give you room to create. Great tools put you in control, too.</p><Link href="/prices" className={styles.buttonLight}>Explore models & pricing <Icon name="arrow-up-right" size={17} /></Link></div><div className={styles.controlBenefits}><div><span className={styles.controlIcon}><Icon name="sliders" /></span><div><h3>The right model for the moment</h3><p>Choose from the models and sources available to your plan, or let Auto help you get started.</p></div></div><div><span className={styles.controlIcon}><Icon name="wallet" /></span><div><h3>Know where every credit goes</h3><p>Compare model prices before you begin. Follow your balance and request costs in your dashboard.</p></div></div><div><span className={styles.controlIcon}><Icon name="key" /></span><div><h3>Make it your own</h3><p>Use prepaid credits or bring your own provider keys on supported sources. You choose how you connect.</p></div></div></div></div></section>

      <section id="pricing" className={`${styles.container} ${styles.pricingSection}`} aria-labelledby="pricing-heading"><div className={styles.centerHeading}><p className={styles.eyebrow}><span /> BIG POSSIBILITIES. CLEAR PRICING.</p><h2 id="pricing-heading">Your next big thing<br />starts with a small step.</h2><p>Pick a plan for your creative rhythm, or add credits as you go.</p></div><PricingOptions plans={publicPlans} /><p className={styles.pricingFootnote}>All prices in USD. Plans renew every 30 days until canceled. Model access depends on your plan and source.<br />Usage rates vary by model. Taxes and any buyer fees are shown at checkout. <Link href="/billing-terms">Billing terms</Link></p></section>

      <section className={`${styles.container} ${styles.getStarted}`} aria-labelledby="steps-heading"><div><p className={styles.eyebrow}><span /> FROM CURIOUS TO CREATING</p><h2 id="steps-heading">Less setup.<br />More spark.</h2></div><ol className={styles.steps}><li><span>01</span><h3>Make yourself at home.</h3><p>Create your free account. Your workspace is ready when you are.</p></li><li><span>02</span><h3>Find your starting point.</h3><p>Pick a plan or add credits from {formatUsd(MIN_TOPUP_CENTS)}. Choose the model that fits your idea.</p></li><li><span>03</span><h3>See where it takes you.</h3><p>Start a conversation, explore a direction, or connect your favorite tools.</p></li></ol></section>

      <section id="faq" className={`${styles.container} ${styles.faqSection}`} aria-labelledby="faq-heading"><div><p className={styles.eyebrow}><span /> A LITTLE CLARITY</p><h2 id="faq-heading">Good questions.<br />Straight answers.</h2><p>Getting to know sitegen?</p><Link href="/docs" className={styles.textLink}>Take a look at the docs <Icon name="arrow-up-right" size={16} /></Link></div><div className={styles.questions}>{questions.map(([question, answer]) => <details key={question} className={styles.question} name="landing-faq"><summary>{question}<span><Icon name="plus" size={18} /></span></summary><p>{answer}</p></details>)}</div></section>

      <section className={`${styles.container} ${styles.finalCta}`} aria-labelledby="final-heading"><div className={styles.ctaOrbit} aria-hidden="true" /><div className={styles.ctaOrbitSmall} aria-hidden="true" /><div className={styles.ctaMark} aria-hidden="true"><SitegenMark /></div><p>THAT IDEA YOU KEEP THINKING ABOUT?</p><h2 id="final-heading">Let’s make it something.</h2><Link href="/signup" className={styles.buttonDark}>Find your spark <Icon name="arrow-right" size={18} /></Link><span>Free to sign up. Yours to explore.</span></section>
    </main>
    <footer className={`${styles.container} ${styles.footer}`}><div><Link href="/" aria-label="sitegen home" className={styles.logo}><SitegenLogo /></Link><p>A little prompt. A world of possibility.</p></div><nav aria-label="Footer navigation"><Link href="/prices">Model prices</Link><Link href="/docs">Documentation</Link><Link href="/setup">Setup guide</Link><Link href="/billing-terms">Billing terms</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link><Link href="/refund-policy">Refund policy</Link><Link href="/eula">EULA</Link><a href={`mailto:${SUPPORT_EMAIL}`}>Contact support</a></nav><div className={styles.footerBottom}><span>© {new Date().getFullYear()} sitegen</span><span>Made for what’s next. <Icon name="sparkles" size={14} /></span></div></footer>
  </div>;
}
