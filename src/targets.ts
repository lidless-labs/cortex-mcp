import { Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const specialIpv6 = new BlockList();
specialIpv6.addSubnet("2001::", 23, "ipv6");
specialIpv6.addSubnet("2001:db8::", 32, "ipv6");
specialIpv6.addSubnet("2002::", 16, "ipv6");
specialIpv6.addSubnet("3fff::", 20, "ipv6");

const specialIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) specialIpv4.addSubnet(network, prefix, "ipv4");

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return !specialIpv4.check(address, "ipv4");
  if (isIP(address) !== 6) return false;
  return globalIpv6.check(address, "ipv6") && !specialIpv6.check(address, "ipv6");
}

/** Submission-time validation supplements the operator's worker egress policy. */
export async function validateObservableTarget(type: string, data: string, allowPrivate: boolean): Promise<void> {
  if (!["url", "ip", "domain", "fqdn"].includes(type)) return;
  let hostname = data;
  if (type === "url") {
    let url: URL;
    try { url = new URL(data); }
    catch { throw new Error("Observable must be an absolute HTTP or HTTPS URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Observable URL must use HTTP or HTTPS without credentials");
    }
    hostname = url.hostname;
  }
  hostname = hostname.replace(/^\[|\]$/g, "");
  if (allowPrivate) return;
  if (type === "ip") {
    // CIDR observables are valid IP data: check the base address and prefix length.
    const cidr = /^([^/]+)\/(\d{1,3})$/.exec(hostname);
    if (cidr) {
      const family = isIP(cidr[1]);
      if (!family || Number(cidr[2]) > (family === 4 ? 32 : 128)) throw new Error("Invalid observable network target");
      hostname = cidr[1];
    }
  }
  if (isIP(hostname)) {
    if (!publicAddress(hostname)) throw new Error("Private or special-purpose targets require CORTEX_ALLOW_PRIVATE_TARGETS=true");
    return;
  }
  if (type === "ip" || !/^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(hostname)) {
    throw new Error("Invalid observable network target");
  }
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const timer = setTimeout(() => resolver.cancel(), 5000);
  try {
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const addresses: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") addresses.push(...result.value);
      else if (!["ENODATA", "ENOTFOUND"].includes(result.reason?.code)) throw new Error("Could not validate observable target DNS");
    }
    if (!addresses.length || addresses.some(address => !publicAddress(address))) {
      throw new Error("Private, unresolved or special-purpose targets require CORTEX_ALLOW_PRIVATE_TARGETS=true");
    }
  } finally { clearTimeout(timer); }
}
