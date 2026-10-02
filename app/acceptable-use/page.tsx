import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '../_components/legal-page';
import { SUPPORT_EMAIL } from '@/lib/site-config';

export const metadata: Metadata = {
  title: 'Acceptable Use Policy - sitegen',
  description: 'Rules for generating images and videos with sitegen.',
};

const EFFECTIVE_DATE = 'September 29, 2026';

const WHOP_TERMS = 'https://whop.com/tos/';
const WHOP_GUIDELINES = 'https://docs.whop.com/trust-and-safety/trust-safety-overview/community-guidelines';
const WHOP_PROHIBITED = 'https://docs.whop.com/trust-and-safety/trust-safety-overview/what-is-not-allowed-on-whop';

export default function AcceptableUsePage() {
  return (
    <LegalPage
      title="Acceptable Use Policy (Images and Videos)"
      description="This policy is part of your agreement with sitegen. It applies to image and video generation on the website, the dashboard, and the API, and to every prompt, upload, reference file, and result."
      effectiveDate={EFFECTIVE_DATE}
      sections={[
        {
          title: 'Agreement and age',
          children: (
            <>
              <p>You must tick “I agree to the Acceptable Use Policy” before your first image or video generation. The same agreement covers the API: image and video requests made with an API key are refused until you have agreed. No agreement, no generation.</p>
              <p>By agreeing, you confirm you are old enough to use Whop under its Terms of Service, and you will not let minors use the generator.</p>
            </>
          ),
        },
        {
          title: 'What this covers',
          children: (
            <p>Prompts, text fields, follow-ups, edits, image-to-image requests, video extensions, uploads, reference files, and generated images and videos are all covered by this policy.</p>
          ),
        },
        {
          title: 'Prohibited content',
          children: (
            <>
              <p>You may not generate, request, upload, store, share, or sell content that includes:</p>
              <ol className="list-decimal space-y-3 pl-5">
                <li><strong className="text-zinc-950">Adult or sexual content.</strong> Pornography, sexually explicit material, content made for adult sexual use, or adult services.</li>
                <li><strong className="text-zinc-950">Anything involving minors.</strong> Sexual, suggestive, exploitative, or abusive depictions of anyone 17 or under, including fictional, animated, or AI-generated depictions. This is never allowed.</li>
                <li><strong className="text-zinc-950">Deepfakes and impersonation.</strong> Fake images or videos of real people, brands, or organizations without their clear permission, or made to mislead, defame, or pretend to be them.</li>
                <li><strong className="text-zinc-950">Copyright and trademark infringement.</strong> Other people’s logos, characters, artwork, photos, videos, or other protected material you do not have the right to use.</li>
                <li><strong className="text-zinc-950">Hate or harassment.</strong> Content that attacks, degrades, or promotes hatred or violence against people based on race, ethnicity, religion, gender, age, sexual orientation, or disability.</li>
                <li><strong className="text-zinc-950">Graphic violence.</strong> Excessively gory, shocking, or real-world violence meant to disgust or glorify harm.</li>
                <li><strong className="text-zinc-950">Self-harm.</strong> Content that promotes, glorifies, or gives instructions for suicide, self-injury, or eating disorders.</li>
                <li><strong className="text-zinc-950">Fraud and scams.</strong> Scams, phishing pages, fake IDs or official documents, fake receipts, invoices, or payment screenshots, and counterfeit money.</li>
                <li><strong className="text-zinc-950">Prohibited products and illegal activity.</strong> Weapons, explosives, drugs, malware, or any other product or service on Whop’s prohibited list, and content that helps with crime.</li>
                <li><strong className="text-zinc-950">Dangerous groups.</strong> Content that promotes terrorist, extremist, or organized criminal groups.</li>
                <li><strong className="text-zinc-950">Private information.</strong> Other people’s personal data, private photos, or identifying details used without consent.</li>
              </ol>
            </>
          ),
        },
        {
          title: 'No workarounds',
          children: (
            <p>Fiction, education, research, roleplay, “make it PG,” “just the prompt,” and private use are not exceptions. There are no exceptions for paid plans. If you are unsure whether something is allowed, do not generate it. Ask us first.</p>
          ),
        },
        {
          title: 'How requests are checked',
          children: (
            <>
              <p>sitegen may refuse any request. Before anything is generated, every prompt, follow-up, uploaded file, reference image, and source video is checked against these rules. If any part fails, the whole request is refused and nothing is generated or charged.</p>
              <p>Uploaded and linked files are fetched and checked by sitegen. The generation provider receives our checked copy, never your original link. If a safety check is unavailable, nothing is generated and no credits are used.</p>
              <p>Finished images and videos are checked again before you see them. A result that breaks these rules is deleted, is never shown, is not charged, and counts as a violation.</p>
              <p>Refusals are logged with the time, your account, identifiers for the request and files, and the rule that was broken. We do not keep the refused content itself.</p>
            </>
          ),
        },
        {
          title: 'Enforcement',
          children: (
            <>
              <p>We may refuse a job, delete output, suspend image and video generation, suspend or close your account, and report content where the law requires it.</p>
              <p>Three violations within 30 days suspend image and video generation. Any request involving minors suspends it immediately and is reviewed for reporting where required. Only a sitegen administrator can lift a suspension. Repeated or severe violations can lead to a permanent ban.</p>
            </>
          ),
        },
        {
          title: 'Storage and retention',
          children: (
            <p>Generated images and videos, and the checked copies of files you upload as references, are kept for 7 days and then deleted automatically, unless the law requires us to keep them longer. Download anything you want to keep. If storage runs low, the oldest files may be deleted sooner. Your generation history and billing records remain after the files are deleted.</p>
          ),
        },
        {
          title: 'Your responsibility',
          children: (
            <p>You are responsible for your prompts, uploads, and how you use the output. Generating something does not mean sitegen approves it.</p>
          ),
        },
        {
          title: 'Whop’s rules',
          children: (
            <p>sitegen is sold through Whop, so everything you create with it must also follow Whop’s <a className="underline" href={WHOP_TERMS} target="_blank" rel="noopener noreferrer">Terms of Service</a>, <a className="underline" href={WHOP_GUIDELINES} target="_blank" rel="noopener noreferrer">Community Guidelines</a>, and <a className="underline" href={WHOP_PROHIBITED} target="_blank" rel="noopener noreferrer">Prohibited Businesses</a> policy. If this policy conflicts with Whop’s rules, Whop’s rules apply.</p>
          ),
        },
        {
          title: 'Questions',
          children: (
            <>
              <p>If you are unsure whether a request is allowed, ask us first at <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
              <p>This policy sits alongside the <Link className="underline" href="/terms">Terms of Service</Link>, <Link className="underline" href="/privacy">Privacy Policy</Link>, <Link className="underline" href="/refund-policy">Refund Policy</Link>, and <Link className="underline" href="/eula">EULA</Link>, which cover the rest of sitegen.</p>
            </>
          ),
        },
      ]}
    />
  );
}
