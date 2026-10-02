/**
 * The fast, deterministic half of the image and video safety check.
 *
 * These patterns catch the clear cases in microseconds and cannot be talked
 * around: they have no exceptions for fiction, education, roleplay or any other
 * framing, because the Acceptable Use Policy has none. The model classifier in
 * `media-classifier.ts` runs after them for everything a word list cannot see
 * (named people, subtle sexualisation, images). Both must pass.
 *
 * The text is checked in several normalised forms, so spacing, punctuation,
 * look-alike letters, leetspeak and base64 do not hide a match.
 */

export const MEDIA_RULES = [
  'adult_sexual',
  'minors',
  'impersonation',
  'ip',
  'hate',
  'graphic_violence',
  'self_harm',
  'illegal',
  'dangerous_groups',
  'private_info',
  'jailbreak',
] as const;
export type MediaRule = (typeof MEDIA_RULES)[number];

export interface RuleHit {
  rule: MediaRule;
  /** Severe hits suspend media generation at once. */
  severe: boolean;
}

export function isSevere(rule: string): boolean {
  return rule === 'minors';
}

// Cyrillic and Greek letters that render like Latin ones.
const LOOKALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p',
  τ: 't', υ: 'u', χ: 'x',
};
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't' };

/** Lower case, no accents, no invisible characters, look-alikes mapped to Latin. */
export function baseNormalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿]/g, '')
    .toLowerCase()
    .replace(/./gu, (char) => LOOKALIKES[char] ?? char)
    .replace(/[’`´]/g, "'");
}

/** Leetspeak inside words only, so "17 years" stays a number. */
function deleet(text: string): string {
  return text.replace(/[\p{L}\d@$!|+]+/gu, (word) => (/\p{L}/u.test(word) ? word.replace(/[0134578@$!|+]/g, (c) => LEET[c] ?? c) : word));
}

/** "n u d e", "n.u.d.e" and "n-u-d-e" become "nude". */
function squash(text: string): string {
  return text.replace(/\b(?:[a-z0-9][^a-z0-9\n]{1,3}){2,}[a-z0-9]\b/g, (run) => run.replace(/[^a-z0-9]/g, ''));
}

/** Decoded base64 runs, so an encoded prompt is screened like a plain one. */
function decodedBase64(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    try {
      const decoded = Buffer.from(match[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      // Mostly printable text only; random bytes are not a hidden prompt.
      if (decoded.length >= 12 && /^[\x20-\x7e\s]+$/.test(decoded)) out.push(decoded);
    } catch { /* not base64 */ }
  }
  return out;
}

/** Every form of the text the patterns are matched against. */
export function screeningVariants(text: string): string[] {
  const sources = [text, ...decodedBase64(text)];
  const variants = new Set<string>();
  for (const source of sources) {
    const base = baseNormalize(source);
    const spaced = base.replace(/[_*~^"()[\]{}<>#=\\/]+/g, ' ').replace(/\s+/g, ' ');
    for (const form of [spaced, deleet(spaced)]) {
      variants.add(form);
      variants.add(squash(form));
      // Words split with a separator inside them: "p-o-r-n-o", "s.e.x".
      variants.add(form.replace(/(?<=\p{L})[.\-_'*](?=\p{L})/gu, ''));
    }
  }
  return [...variants];
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

const MINOR = String.raw`(?:child(?:ren)?|kids?|kiddies|minors?|under[- ]?age(?:d)?|under 18|preteens?|pre-teens?|tweens?|teen(?:s|age|aged|ager|agers)?|school ?girls?|school ?boys?|little (?:girls?|boys?)|young (?:girls?|boys?)|toddlers?|infants?|juveniles?|middle school(?:er)?s?|elementary school(?:er)?s?|high school(?:er)?s?|kindergarten(?:er)?s?|(?:1[0-7]|[1-9])[- ]?(?:yo|y\/o|yrs? old|years? old|year[- ]olds?)|(?:aged?|age of) (?:1[0-7]|[1-9])\b|loli(?:ta|con)?s?|shota(?:con)?s?)`;
const SEXUAL = String.raw`(?:nude|nudes|naked|nudity|sexy|sexual(?:ly|ised|ized)?|sexuali[sz]ed|seductive(?:ly)?|provocative(?:ly)?|suggestive(?:ly)?|erotic(?:a)?|sensual|lingerie|topless|undress(?:ed|ing)?|strip(?:ping|ped|tease)|porn\w*|nsfw|lewd|hentai|fetish\w*|kinky|bdsm|orgasm\w*|masturbat\w*|having sex|sex (?:scene|act|pose)|seduc\w*|busty|cleavage|boobs|thicc|horny|bedroom eyes|pose (?:sexily|seductively)|spread(?:ing)? (?:her|his|their)? ?legs)`;
const PROTECTED_GROUP = String.raw`(?:jews?|jewish (?:people|men|women)|muslims?|christians?|hindus?|sikhs?|buddhists?|blacks?|black (?:people|men|women)|whites?|white (?:people|men|women)|asians?|arabs?|mexicans?|latinos?|latinas?|hispanics?|africans?|chinese (?:people|men|women)|indians?|immigrants?|refugees?|gays?|lesbians?|homosexuals?|bisexuals?|trans(?:gender)? (?:people|men|women)|transgenders?|queers?|women|disabled (?:people|men|women)|autistic people)`;

// Real people who are the most frequent deepfake targets. The classifier
// covers everyone else; this list only makes the commonest cases instant.
const FAMOUS_PEOPLE = String.raw`(?:donald trump|trump|joe biden|biden|barack obama|obama|michelle obama|kamala harris|hillary clinton|bill clinton|vladimir putin|putin|volodymyr zelensky|zelensky|xi jinping|kim jong[- ]?un|narendra modi|benjamin netanyahu|netanyahu|emmanuel macron|keir starmer|rishi sunak|justin trudeau|pope francis|pope leo|king charles|prince william|prince harry|meghan markle|kate middleton|elon musk|mark zuckerberg|jeff bezos|bill gates|sam altman|taylor swift|beyonce|rihanna|kanye west|kim kardashian|kylie jenner|selena gomez|ariana grande|billie eilish|dua lipa|emma watson|scarlett johansson|margot robbie|zendaya|sydney sweeney|jenna ortega|millie bobby brown|tom cruise|keanu reeves|leonardo dicaprio|brad pitt|angelina jolie|dwayne johnson|will smith|morgan freeman|oprah|lebron james|cristiano ronaldo|lionel messi|messi|ronaldo|mrbeast|drake the rapper|justin bieber|snoop dogg|eminem|greta thunberg|andrew tate)`;

const CHARACTERS = String.raw`(?:mickey mouse|minnie mouse|donald duck|disney|pixar|marvel (?:comics|studios|characters?|superheroes?|universe|movie|heroes)|\bmcu|dc comics|spider[- ]?man|spiderman|batman|superman|wonder woman|iron man (?:suit|armou?r|marvel)|tony stark|captain america|incredible hulk|the hulk|avengers|x-men|deadpool|joker from batman|harley quinn|harry potter|hogwarts|hermione|star wars|darth vader|yoda|stormtroopers?|baby yoda|grogu|pokemon|pikachu|charizard|nintendo|super mario|mario bros|princess peach|zelda|sonic the hedgehog|hello kitty|sanrio|shrek|despicable me|elsa (?:from|and) (?:frozen|anna)|frozen movie|simpsons|homer simpson|bart simpson|spongebob|patrick star|peppa pig|paw patrol|bluey|barbie|lego|transformers (?:robot|movie|autobots?)|autobots?|decepticons?|optimus prime|naruto|goku|dragon ball|one piece (?:anime|manga)|luffy|sailor moon|totoro|doraemon|garfield|snoopy|scooby[- ]?doo|looney tunes|bugs bunny|winnie the pooh|minecraft|fortnite|among us (?:game|crewmates?|characters?)|call of duty|pac-?man|james bond|007|hunger games|lord of the rings|gandalf|gollum|game of thrones|stranger things|squid game|teenage mutant ninja turtles|ninja turtles|power rangers|ghostbusters|jurassic park|toy story|buzz lightyear|woody from toy story|lightning mcqueen|kermit|muppets|sesame street|elmo|cookie monster)`;
const BRANDS = String.raw`(?:nike|adidas|reebok|coca[- ]?cola|pepsi|mcdonald'?s|burger king|kfc|starbucks|gucci|louis vuitton|chanel|prada|versace|balenciaga|dior|rolex|cartier|playstation|xbox|red bull|monster energy|oreo|doritos|mastercard|paypal)`;
const COMMON_WORD_BRANDS = String.raw`(?:apple|amazon|google|microsoft|meta|shell|target|subway|dove|jaguar|puma|mustang|corona|oracle|uber|airbnb|supreme|hermes|visa|coke|ferrari|lamborghini|porsche|tesla|bmw|mercedes|toyota|honda|ford|audi|netflix|youtube|instagram|facebook|tiktok|snapchat|twitter|spotify|discord|twitch|whatsapp|telegram|openai|chatgpt)`;
const TRADEMARK_CONTEXT = String.raw`(?:logos?|brand(?:ed|ing)?|trademarks?|swoosh|merch(?:andise)?|packaging|label|mascot|advert(?:isement)?|ad campaign|commercial|billboard|official (?:product|store)|sneakers?|shoes|handbag|bag|watch|jersey|hoodie|t-?shirt|cup|can|bottle)`;

interface RuleSpec {
  rule: MediaRule;
  patterns: RegExp[];
}

function re(source: string): RegExp {
  return new RegExp(source, 'iu');
}

const RULES: RuleSpec[] = [
  {
    rule: 'minors',
    patterns: [
      re(String.raw`\b(?:loli(?:ta|con)?|shota(?:con)?|jail ?bait|csam|child porn\w*|kiddie porn|kiddy porn|pedo(?:phile|philia|bait)?s?|paedo\w*|preteen (?:model|nude)|underage (?:sex|porn|nude|naked|model))\b`),
      re(String.raw`\b${MINOR}\b[\s\S]{0,300}?\b${SEXUAL}\b`),
      re(String.raw`\b${SEXUAL}\b[\s\S]{0,300}?\b${MINOR}\b`),
    ],
  },
  {
    rule: 'adult_sexual',
    patterns: [
      re(String.raw`\b(?:porn\w*|pr0n|nsfw|xxx|hentai|rule ?34|ecchi|smut|explicit (?:sex\w*|nudity|content|scene|image|photo|video|material)|sex (?:scene|act|acts|position|positions|tape|video|doll|toy|toys|worker|slave)|having sex|intercourse|blow ?jobs?|hand ?jobs?|oral sex|anal sex|\banal\b|orgasm\w*|masturbat\w*|cum ?shots?|cum on|creampie|ejaculat\w*|erect(?:ion|ed) (?:penis|cock)|genital\w*|penis\w*|cocks?|dick ?pics?|vagina\w*|vulva|pussy|clitor\w*|nipples?|areolas?|bare (?:breasts?|chest(?:ed)? woman|butt|bottom)|topless|bottomless|nude(?! (?:lipsticks?|lips?|colou?rs?|tones?|shades?|heels|pumps|palette|makeup|nails|nail polish|beige|pink|eyeshadow|foundation|stockings|sandals|dress))|nudes|naked(?! (?:eye|cake|flame|truth|juice|light|bulb|wire|tree|branches))|nudity|nudist|nudify|undress(?:ed|ing)?|strip ?tease|(?<!wire )strippers?|(?<!(?:paint|wire|floor) )stripping|without (?:any )?cloth(?:es|ing)|no cloth(?:es|ing)|(?:remove|take off|taking off|removing) (?:her|his|their|all|the) (?:clothes|clothing|bra|panties|underwear|shirt|top|dress|bikini)|see[- ]?through (?:clothes|dress|shirt|top|lingerie|bra|panties)|fetish\w*|bdsm|bondage|dominatrix|erotic\w*|onlyfans|fansly|lewd|horny|slutty|sluts?|whores?|camgirls?|sexting|playboy|boudoir|lingerie (?:shoot|model|photo)|sexual(?:ly)? (?:explicit|suggestive|act|pose|content|position)|in a sexual|sexy (?:pose|lingerie|nude)|seductive(?:ly)? (?:pose|posing|undress)|spread(?:ing)? (?:her|his|their) legs|cameltoe|upskirt|downblouse|wet t-?shirt|thirst trap)\b`),
      re(String.raw`\b(?:pg|pg-13|safe for work|sfw|censored|clothed)\b[\s\S]{0,80}\b(?:but|while|yet|still)\b[\s\S]{0,80}\b(?:sexual|sexy|aroused|arousing|horny|after sex|just had sex|orgasm|erotic|naughty|seductive|suggestive|implied nudity|nude)\b`),
      re(String.raw`\b(?:just had sex|after (?:having )?sex|post[- ]?coital|implied (?:nudity|sex)|barely (?:clothed|covered|dressed)|covering (?:her|his|their) (?:breasts|nipples|genitals|privates))\b`),
    ],
  },
  {
    rule: 'impersonation',
    patterns: [
      re(String.raw`\b(?:deep ?fakes?|face ?swap\w*|swap (?:his|her|their|the|my|this) face|(?:put|paste|place|replace|swap) (?:his|her|their|my|this) face (?:on|onto|into|with)|with (?:his|her|their|my \w+'?s?) face on|nudify|undress (?:this|her|him|them|my)|(?:fake|doctored|manipulated|fabricated) (?:photo|image|picture|video|footage|screenshot|news|headline|tweet|post|statement|endorsement|mugshot|evidence) of|pretend(?:ing)? to be (?:the )?(?:president|police|ceo|bank|company|official)|voice clone|lip ?sync (?:him|her|them) saying)\b`),
      re(String.raw`\b${FAMOUS_PEOPLE}\b`),
    ],
  },
  {
    rule: 'ip',
    patterns: [
      re(String.raw`\b${CHARACTERS}\b`),
      re(String.raw`\b${BRANDS}\b`),
      re(String.raw`\b${COMMON_WORD_BRANDS}\b[\s\S]{0,30}\b${TRADEMARK_CONTEXT}\b`),
      re(String.raw`\b(?:remove|erase|delete|without) (?:the |any |all )?watermarks?\b|\b(?:getty images|shutterstock|istock|adobe stock|alamy)\b|\b(?:copy|replicate|recreate|reproduce) (?:the |this )?(?:exact |same )?(?:logo|poster|album cover|movie poster|book cover|painting|artwork|photo|scene|frame|character) (?:from|of|by)\b|\bmovie poster for (?:the )?(?:real|actual|upcoming)\b|\bstill (?:frame|shot) from (?:the )?(?:movie|film|show|series)\b`),
    ],
  },
  {
    rule: 'hate',
    patterns: [
      re(String.raw`\b(?:n[i1!|]gg(?:er|a|az|uh)s?|f[a@]gg?(?:ot|it)s?|k[i1]kes?|sp[i1]cs?|ch[i1]nks?|g[o0][o0]ks?|wetbacks?|beaners?|tr[a@]nn(?:y|ies)|r[e3]t[a@]rds?|sand ?n[i1]gg\w*|towel ?heads?|raghead\w*|jigaboos?|porch monkeys?|golliwogs?)\b`),
      re(String.raw`\b(?:swastikas?|nazi\w*|third reich|heil hitler|sieg heil|hitler|white power|white pride|white supremac\w*|white genocide|great replacement|kkk|ku klux klan|burning cross|1488|14 ?words|rahowa|blood and soil|hate symbols?|antisemit\w*|holocaust (?:denial|hoax|was fake|didn'?t happen)|jewish (?:conspiracy|control)|zionist occupied)\b`),
      re(String.raw`\b(?:kill|killing|exterminate|exterminating|gas the|lynch|lynching|eradicate|wipe out|get rid of|hate|hating|mock|mocking|humiliate|humiliating|degrade|degrading)\b[\s\S]{0,30}\b(?:all|the|every)?\s?${PROTECTED_GROUP}\b`),
      re(String.raw`\b${PROTECTED_GROUP}\b[\s\S]{0,30}\b(?:are|as|is|like)\b[\s\S]{0,20}\b(?:vermin|rats?|cockroaches|animals|apes|monkeys|pigs|subhuman|inferior|disgusting|parasites|terrorists|criminals|diseased|should die|must die|should be killed)\b`),
      re(String.raw`\b(?:racist|sexist|homophobic|transphobic|antisemitic|islamophobic|bigoted|hateful) (?:caricature|cartoon|meme|poster|propaganda|image|joke|drawing|depiction)\b|\bblackface\b|\byellowface\b|\bminstrel show\b`),
    ],
  },
  {
    rule: 'graphic_violence',
    patterns: [
      re(String.raw`\b(?:gore|gory|gruesome|grisly|guts spilling|decapitat\w*|behead\w*|dismember\w*|disembowel\w*|mutilat\w*|eviscerat\w*|entrails|intestines (?:spilling|hanging|out)|severed (?:head|heads|limb|limbs|arm|arms|leg|legs|hand|hands|finger|fingers)|brains? (?:splatter\w*|blown out|spilling)|blown (?:off|apart) (?:head|face|limbs)|skull (?:crushed|smashed)|blood ?(?:splatter\w*|bath|soaked|drenched|everywhere|spraying|gushing)|pools? of blood|covered in blood|tortur\w* (?:scenes?|victims?|of|someone|people|prisoners?|animals?|devices?)|being tortured|flay(?:ed|ing)|skinned alive|burned alive|burning alive|execution (?:scene|video|of)|executed (?:prisoner|man|woman|person|people)|firing squad|electric chair|lynch(?:ing|ed| mob)|school shooting\w*|mass shooting\w*|shooting spree|massacre\w*|genocide|ethnic cleansing|snuff (?:film|video)|shot in the (?:head|face)|(?:cut|slit|slash)(?:ting)? (?:his|her|their|a|the) throat|stab(?:bed|bing)? (?:repeatedly|to death)|beaten to death|murder (?:scene|victim|video)|dead (?:bodies|body|child|children|baby)|corpses?|cadavers?|crime scene photos?|autopsy photos?|animal (?:cruelty|abuse|torture)|kicking a (?:dog|cat|puppy|kitten)|terrorist attack (?:footage|video|photo)|9\/11 jumpers|falling man photo|war crimes? (?:footage|photo))\b`),
    ],
  },
  {
    rule: 'self_harm',
    patterns: [
      re(String.raw`\b(?:suicid\w*|kill(?:ing|s)? (?:my|your|him|her|them|our)sel(?:f|ves)|end(?:ing)? (?:my|your|his|her|their) (?:own )?life|self[- ]?harm\w*|self[- ]?injur\w*|self[- ]?mutilat\w*|(?:cut|cutting|slit|slitting|slash|slashing) (?:my|your|his|her|their|the)? ?(?:wrists?|arms?|thighs?|veins?)|hang(?:ing|ed)? (?:my|him|her|them|your)sel(?:f|ves)|nooses?|overdos\w*|pro[- ]?ana|pro[- ]?mia|thinspo\w*|meanspo|bonespo|starv(?:e|ing) (?:my|your|her|his|them)sel(?:f|ves)|anorexi\w* (?:tips|motivation|goals|inspiration|aesthetic)|bulimi\w* (?:tips|motivation)|purg(?:e|ing) after (?:eating|meals)|jump(?:ing)? (?:off|from) (?:a|the) (?:bridge|building|roof|cliff|ledge) to die|razor blades? (?:on|and) (?:wrists?|arms?)|scars? from cutting|bleeding wrists?)\b`),
    ],
  },
  {
    rule: 'illegal',
    patterns: [
      re(String.raw`\b(?:phishing(?: (?:page|site|website|email|kit|link|message|sms|text|screen|form))?|fake (?:login|log-in|sign[- ]?in|bank(?:ing)?|paypal|apple id|icloud|microsoft|outlook|office ?365|netflix|amazon|venmo|cash ?app|zelle|coinbase|binance|metamask|wallet|crypto|steam|whop) (?:page|screen|website|site|portal|email|form|app|popup|verification)|(?:login|sign[- ]?in|verification) page (?:that )?(?:looks like|copying|cloning|imitating|mimicking)|clone (?:of )?(?:a |the )?(?:bank|paypal|login) (?:site|page|website)|scam (?:ad|advert|website|site|email|message|page|text|call|landing page)|(?:fake|counterfeit|forged?|forgery of|replica) (?:ids?|id cards?|identity cards?|passports?|driver'?s? licen[cs]es?|driving licen[cs]es?|ssn|social security cards?|birth certificates?|diplomas?|degrees?|transcripts?|receipts?|invoices?|checks?|cheques?|bank statements?|pay ?stubs?|payslips?|doctor'?s? notes?|medical certificates?|prescriptions?|money|currency|banknotes?|bills|dollar bills|dollars|euros|visas?|green cards?|work permits?|boarding pass(?:es)?|tickets?|vaccin\w* cards?|covid (?:tests?|certificates?)|licen[cs]e plates?|police badges?|official documents?|documents?|signatures?|stamps?|seals?|certificates?|screenshots? of (?:a )?(?:bank|payment|transfer|transaction))|counterfeit\w*|(?:print|make|create) (?:my own |fake |counterfeit )(?:money|currency|dollars|bills|banknotes)|(?:credit|debit) card (?:numbers?|details|with cvv|dump)|(?:stolen|leaked) (?:credit cards?|card numbers?|credentials|passwords|accounts?)|carding|(?:pipe|nail|car|letter|dirty|suicide|fertili[sz]er|pressure cooker) bombs?|suicide bomb(?:er|ing)s?|(?:make|build|assemble|homemade|diy|making|building) (?:a |an )?(?:bombs?|explosives?|ieds?|grenades?|detonators?|napalm|thermite|ricin|sarin|nerve agent)|bomb[- ]?making|explosives? (?:recipe|diagram|schematic|instructions|components|labeled|labelled)|\bieds?\b|molotov\w*|(?:3d[- ]?printed|ghost|untraceable) (?:guns?|firearms?|pistols?|rifles?)|(?:guns?|rifles?|pistols?|firearms?|weapons?) (?:blueprints?|schematics?|build instructions)|(?:build|make|assemble|print|machine) (?:a |your own |an )?(?:guns?|rifles?|pistols?|firearms?|silencers?|suppressors?|auto ?sears?)|full[- ]?auto conversion|auto ?sears?|glock switch\w*|bump stocks?|meth(?:amphetamine)? (?:lab|cook\w*|recipe)|cook(?:ing)? meth|drug (?:menu|price list|dealer ad|shop ad|store ad)|(?:buy|sell|selling|order|ordering|delivery of|price of|dealer|for sale)\b[\s\S]{0,25}\b(?:cocaine|heroin|meth|fentanyl|mdma|ecstasy|lsd|xanax|oxycodone|oxy|percocet|ketamine|crack cocaine|weed|cannabis|marijuana)|(?:cocaine|heroin|meth|fentanyl|mdma|ketamine|xanax|oxycodone)\b[\s\S]{0,25}\b(?:for sale|menu|price|delivery|shop|store|dealer)|(?:create|build|write|code|make|generate|design|develop) (?:a |an |some )?(?:working |functional )?(?:malware|ransomware|keylogger|spyware|stalkerware|computer virus|trojan|botnet|rootkit|infostealer|rat tool|credential stealer)|ransom(?:ware)? (?:note|screen|message|demand)|credential[- ]?(?:steal\w*|harvest\w*)|(?:steal|stealing|harvest|harvesting) (?:passwords|credentials|logins|card details)|sextortion|blackmail (?:letter|message|note)|human trafficking|how to (?:shoplift|launder|smuggle|pick a lock to break in|break into|hotwire|poach))\b`),
    ],
  },
  {
    rule: 'dangerous_groups',
    patterns: [
      re(String.raw`\b(?:isis|isil|daesh|islamic state|al[- ]?qa'?e?da|al[- ]?shabaa?b|boko haram|taliban|hamas|hezbollah|hizballah|houthis?|pkk|kkk|ku klux klan|neo[- ]?nazis?|aryan (?:nations?|brotherhood)|proud boys|atomwaffen|patriot front|oath keepers|wagner group|ms[- ]?13|mara salvatrucha|sinaloa cartel|cjng|jalisco cartel|los zetas|gulf cartel|cartel del noreste|tren de aragua|bloods and crips|crips gang|bloods gang|latin kings|hells angels|yakuza (?:recruitment|propaganda|glorif\w*)|mafia (?:recruitment|propaganda)|jihadi?s?t?s?|mujahideen|martyrdom (?:video|poster|operation))\b`),
      re(String.raw`\b(?:terrorist|terrorism|extremist|jihad\w*|militia|gang|cartel|mafia) (?:recruitment|propaganda|poster|flag|flags|logo|emblem|insignia|anthem|manifesto|hero|heroes|glorif\w*|training)|\b(?:recruitment|propaganda) (?:poster|video|flyer|material|image) for\b|\bjoin (?:the )?(?:jihad|isis|cartel|gang|militia)\b|\b(?:mass shooter|school shooter) (?:manifesto|hero|tribute|fan ?art)\b|\b(?:christchurch|columbine|buffalo|el paso|uvalde|parkland) (?:shooter|shooting)\b|\bunabomber\b|\bbin laden\b|\bosama\b|\bbaghdadi\b`),
    ],
  },
  {
    rule: 'private_info',
    patterns: [
      re(String.raw`\b(?:dox\w*|home address(?:es)?|(?:phone|cell|mobile|telephone) numbers? of|personal (?:phone|address|details|information|data) of|social security numbers?|\bssn\b|(?:private|leaked|stolen|hacked|intimate) (?:photos?|pictures?|pics|images?|nudes?|videos?|selfies?)|revenge porn|hidden (?:camera|cam)s?|spy ?cams?|creep ?shots?|voyeur\w*|without (?:her|his|their) (?:consent|permission|knowledge)|(?:from|using|off) (?:her|his|their|my \w+'?s?) (?:instagram|facebook|tiktok|snapchat|linkedin|dating|tinder) (?:profile|photos?|pics?|pictures?|account)|(?:my|a|her|his) (?:ex|ex-?girlfriend|ex-?boyfriend|ex-?wife|ex-?husband)(?:'s)? (?:photo|face|picture|pic|selfie|body|nudes?)|(?:my|a|her|his) (?:neighbou?r|co-?worker|classmate|teacher|boss|crush|stepsister|stepmom|stepdaughter|sister-in-law)(?:'s)? (?:body|nudes?|naked)|license plate (?:of|number of)|(?:where|where does) (?:she|he|they) lives?|gps location of|stalk(?:ing|er) (?:her|him|them|someone|my))\b`),
    ],
  },
  {
    rule: 'jailbreak',
    patterns: [
      re(String.raw`\b(?:ignore (?:all |any |the |your |these )?(?:previous |prior |above |earlier |safety |content )?(?:instructions|rules|guidelines|policies|policy|filters|restrictions)|disregard (?:the |your |all )?(?:rules|policy|guidelines|filters|instructions)|bypass(?:ing)? (?:the |your |any |all )?(?:filters?|safety|content (?:policy|filter)|moderation|restrictions|censorship|guardrails|nsfw filter)|(?:disable|turn off|remove|skip|get around|work around|evade|circumvent|trick) (?:the |your |any )?(?:safety|filters?|nsfw filter|censorship|guardrails|content policy|moderation|restrictions)|jail ?break\w*|dan mode|developer mode|no (?:restrictions|filters|censorship)|uncensored|unfiltered (?:version|mode|output|content|image|ai|model)|unrestricted mode|without (?:any )?(?:censorship|filters|restrictions)|nsfw (?:allowed|enabled|mode|on)|pretend (?:you are|you'?re|to be) (?:an? )?(?:uncensored|unrestricted|evil|unfiltered)|you have no (?:rules|restrictions|filters)|policy doesn'?t apply|the rules don'?t apply|(?:i am|i'?m) (?:the |an )?(?:admin|administrator|developer|owner) (?:so|and) (?:allow|approve|override)|override (?:the )?(?:policy|safety|filter)|safety override|(?:spell|write) it (?:backwards|in reverse|with (?:spaces|dots|symbols))|in (?:base64|rot13)|encode(?:d)? (?:it|this|the prompt)|replace (?:the )?(?:banned|forbidden|blocked) words?|use (?:a )?(?:code ?word|euphemism|synonym)s? (?:for|so))\b`),
    ],
  },
];

/** The first rule the text breaks, or null when it passes the fast check. */
export function screenMediaText(text: string): RuleHit | null {
  if (text.trim() === '') return null;
  const variants = screeningVariants(text.slice(0, 40_000));
  for (const spec of RULES) {
    for (const variant of variants) {
      if (spec.patterns.some((pattern) => pattern.test(variant))) {
        return { rule: spec.rule, severe: isSevere(spec.rule) };
      }
    }
  }
  return null;
}
