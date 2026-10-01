'use strict';
// outputs/data/credentials.json repeats four facts from site.json for the /security/ page, and the
// website build (rule R3) refuses to run when the two disagree. Every admin commit that changes one
// of those facts therefore rewrites the matching registry values in the same commit. Value and date
// move; status, verify, note and label are the owner's own claims about the fact, with one exception
// below for the contact email: the sync can mark it pending, and later undo only that mark of its own.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A LinkedIn profile on any LinkedIn host (www., a country subdomain, any letter case).
function isLinkedInProfile(u) {
  if (typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)linkedin\.com$/i.test(url.hostname) && /^\/in\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function derive(site, entries) {
  const owner = isObj(site.owner) ? site.owner : {};
  const sameAs = Array.isArray(site.ownerSameAs) ? site.ownerSameAs : [];
  const current = isObj(entries.owner_linkedin) ? entries.owner_linkedin.value : null;
  return {
    owner_name: owner.name,
    owner_location: `${owner.city}, ${owner.regionName}`,
    contact_email: site.contactEmail,
    // R3 fails when the registry names a LinkedIn URL the card does not list, and the admin cannot
    // edit the registry, so the card decides: its first profile link, else the registry value if the
    // card still lists it, else null (which /security/ shows as not published yet).
    owner_linkedin: sameAs.find(isLinkedInProfile) ?? (current != null && sameAs.includes(current) ? current : null),
  };
}

const DEMOTED_BY = 'admin-sync';

const domainOf = (email) => (typeof email === 'string' && email.includes('@') ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : null);

function syncCredentials(credentialsText, site, todayIso) {
  const credentials = JSON.parse(credentialsText);
  const entries = isObj(credentials.entries) ? credentials.entries : {};
  const siteDomain = typeof site.name === 'string' ? site.name.toLowerCase() : null;
  const changedKeys = [];
  for (const [key, value] of Object.entries(derive(site, entries))) {
    const entry = entries[key];
    // The registry decides which facts it tracks; an entry it lacks is not created here.
    if (!isObj(entry) || value === undefined || entry.value === value) continue;
    entry.value = value;
    changedKeys.push(key);
    // The contact entry's check is that the address is on the site's own domain. An address on
    // another domain cannot carry that "Verified" badge, so it shows as pending, with the date the
    // owner last confirmed a value, until the owner checks it in the registry.
    if (key === 'contact_email' && value !== null && siteDomain && domainOf(value) !== siteDomain) {
      if (entry.status === 'verified') {
        entry.status = 'pending';
        // The website reads only the owner's fields, so this mark stays out of the page; it lets an
        // address back on the domain get its badge again without the owner editing the registry.
        entry.demotedBy = DEMOTED_BY;
      }
      continue;
    }
    // Back on the domain: undo the sync's own demotion. A pending status the owner set has no mark and stays.
    if (key === 'contact_email' && value !== null && entry.demotedBy === DEMOTED_BY) {
      if (entry.status === 'pending') entry.status = 'verified';
      delete entry.demotedBy;
    }
    entry.date = todayIso;
  }
  // Untouched text stays byte-for-byte, so an unchanged registry never lands in the commit.
  if (changedKeys.length === 0) return { text: credentialsText, changedKeys };
  return { text: JSON.stringify(credentials, null, 2) + '\n', changedKeys };
}

module.exports = { syncCredentials, isLinkedInProfile };
