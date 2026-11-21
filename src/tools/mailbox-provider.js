// Who runs a domain's mailboxes, read from the MX hosts email-validate already
// looks up: no further query and no outside data. A provider is recognized by
// the registrable suffix of an MX host (a short table kept here); a domain on
// the built-in list of throwaway-inbox services reads "disposable"; an MX
// inside the address's own domain reads "self-hosted"; anything else reads
// "unknown". A signal about where mail is hosted, not a deliverability
// verdict. Pure and dependency-free.

/** [provider id, name, type, MX host suffixes]. `type`: "hosted" (mailboxes
 *  run by the provider), "gateway" (a filtering service in front of mailboxes
 *  hosted elsewhere) or "forwarding" (mail is passed on to another address). */
const PROVIDERS = [
  ["google", "Google Workspace / Gmail", "hosted", ["google.com", "googlemail.com", "smtp.goog"]],
  ["microsoft", "Microsoft 365 / Outlook", "hosted", ["protection.outlook.com", "outlook.com", "mx.microsoft", "hotmail.com"]],
  ["zoho", "Zoho Mail", "hosted", ["zoho.com", "zoho.eu", "zoho.in", "zoho.com.au", "zoho.jp", "zohomail.com", "zohomail.eu"]],
  ["proton", "Proton Mail", "hosted", ["protonmail.ch", "proton.me"]],
  ["yahoo", "Yahoo Mail / AOL", "hosted", ["yahoodns.net"]],
  ["icloud", "Apple iCloud Mail", "hosted", ["mail.icloud.com", "icloud.com"]],
  ["fastmail", "Fastmail", "hosted", ["messagingengine.com"]],
  ["amazon", "Amazon SES / WorkMail", "hosted", ["amazonaws.com", "awsapps.com"]],
  ["rackspace", "Rackspace Email", "hosted", ["emailsrvr.com"]],
  ["godaddy", "GoDaddy Email", "hosted", ["secureserver.net"]],
  ["namecheap", "Namecheap Private Email", "hosted", ["privateemail.com"]],
  ["ionos", "IONOS Mail", "hosted", ["ionos.com", "ionos.de", "ionos.co.uk", "ionos.fr", "ionos.es", "kundenserver.de", "1and1.com"]],
  ["ovh", "OVHcloud Mail", "hosted", ["ovh.net", "mail.ovh.ca"]],
  ["gandi", "Gandi Mail", "hosted", ["gandi.net"]],
  ["yandex", "Yandex Mail", "hosted", ["yandex.net", "yandex.ru"]],
  ["mailru", "Mail.ru", "hosted", ["mail.ru"]],
  ["gmx", "GMX / mail.com", "hosted", ["gmx.net", "gmx.com", "mail.com"]],
  ["tuta", "Tuta Mail", "hosted", ["tutanota.de", "tuta.com"]],
  ["migadu", "Migadu", "hosted", ["migadu.com"]],
  ["titan", "Titan Email", "hosted", ["titan.email"]],
  ["hostinger", "Hostinger Email", "hosted", ["hostinger.com"]],
  ["tencent", "Tencent QQ Mail", "hosted", ["qq.com"]],
  ["netease", "NetEase Mail", "hosted", ["163.com", "netease.com", "126.com"]],
  ["mailgun", "Mailgun inbound", "hosted", ["mailgun.org"]],
  ["sendgrid", "SendGrid inbound", "hosted", ["sendgrid.net"]],
  ["mimecast", "Mimecast", "gateway", ["mimecast.com", "mimecast.co.za", "mimecast-offshore.com"]],
  ["proofpoint", "Proofpoint", "gateway", ["pphosted.com", "ppe-hosted.com"]],
  ["barracuda", "Barracuda Email Protection", "gateway", ["barracudanetworks.com"]],
  ["cloudflare", "Cloudflare Email Routing", "forwarding", ["mx.cloudflare.net"]],
  ["improvmx", "ImprovMX", "forwarding", ["improvmx.com"]],
  ["forwardemail", "Forward Email", "forwarding", ["forwardemail.net"]],
  ["namecheap-forwarding", "Namecheap email forwarding", "forwarding", ["registrar-servers.com"]],
];

// Throwaway-inbox services, by the address's domain or its MX host.
const DISPOSABLE = [
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "sharklasers.com", "grr.la",
  "10minutemail.com", "10minutemail.net", "yopmail.com", "yopmail.fr", "yopmail.net", "temp-mail.org", "tempmail.com", "tempmail.net",
  "trashmail.com", "trashmail.net", "getnada.com", "maildrop.cc", "dispostable.com", "throwawaymail.com", "mailnesia.com", "fakeinbox.com",
  "mohmal.com", "emailondeck.com", "tempr.email", "discard.email", "mintemail.com", "spamgourmet.com", "mytemp.email", "moakt.com",
  "tempmailo.com", "temp-mail.io", "minuteinbox.com", "burnermail.io", "33mail.com", "inboxkitten.com", "mail7.io", "tmail.ws",
];

const clean = (host) => String(host ?? "").trim().toLowerCase().replace(/\.+$/, "");
const under = (host, suffix) => host === suffix || host.endsWith(`.${suffix}`);

/**
 * The mailbox provider for a domain, from its MX hosts (priority order).
 * Returns null when there is no MX host (nothing receives mail), else
 * { id, name, type } with type one of hosted, gateway, forwarding,
 * disposable, self-hosted, unknown. The first MX host a table entry matches
 * decides; `domain` is the address's own domain.
 */
export function mailboxProviderOf(mxRecords, domain) {
  const hosts = (Array.isArray(mxRecords) ? mxRecords : []).slice(0, 20).map(clean).filter(Boolean);
  if (!hosts.length) return null;
  const dom = clean(domain);
  if (DISPOSABLE.some((d) => under(dom, d) || hosts.some((h) => under(h, d)))) return { id: "disposable", name: "Disposable inbox service", type: "disposable" };
  for (const host of hosts) {
    for (const [id, name, type, suffixes] of PROVIDERS) if (suffixes.some((sfx) => under(host, sfx))) return { id, name, type };
  }
  if (dom && hosts.some((h) => under(h, dom))) return { id: "self-hosted", name: "Self-hosted (mail server on the domain itself)", type: "self-hosted" };
  return { id: "unknown", name: "Unrecognized mail host", type: "unknown" };
}

export const MAILBOX_PROVIDER_TYPES = Object.freeze(["hosted", "gateway", "forwarding", "disposable", "self-hosted", "unknown"]);
export const __mailboxProviders = Object.freeze({ PROVIDERS, DISPOSABLE });
