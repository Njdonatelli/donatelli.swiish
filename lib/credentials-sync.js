'use strict';
// outputs/data/credentials.json repeats four facts from site.json for the /security/ page, and the
// website build (rule R3) refuses to run when the two disagree. Every admin commit that changes one
// of those facts therefore rewrites the matching registry values in the same commit. Only value and
// date move: status, verify, note and label are the owner's own claims about the fact.

const LINKEDIN = /^https:\/\/(www\.)?linkedin\.com\/in\//;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function derive(site) {
  const owner = isObj(site.owner) ? site.owner : {};
  const derived = {
    owner_name: owner.name,
    owner_location: `${owner.city}, ${owner.regionName}`,
    contact_email: site.contactEmail,
  };
  // No LinkedIn link on the card leaves the registry's LinkedIn entry as the owner set it.
  const linkedin = (Array.isArray(site.ownerSameAs) ? site.ownerSameAs : []).find((u) => typeof u === 'string' && LINKEDIN.test(u));
  if (linkedin) derived.owner_linkedin = linkedin;
  return derived;
}

function syncCredentials(credentialsText, site, todayIso) {
  const credentials = JSON.parse(credentialsText);
  const entries = isObj(credentials.entries) ? credentials.entries : {};
  const changedKeys = [];
  for (const [key, value] of Object.entries(derive(site))) {
    const entry = entries[key];
    // The registry decides which facts it tracks; an entry it lacks is not created here.
    if (!isObj(entry) || value === undefined || entry.value === value) continue;
    entry.value = value;
    entry.date = todayIso;
    changedKeys.push(key);
  }
  // Untouched text stays byte-for-byte, so an unchanged registry never lands in the commit.
  if (changedKeys.length === 0) return { text: credentialsText, changedKeys };
  return { text: JSON.stringify(credentials, null, 2) + '\n', changedKeys };
}

module.exports = { syncCredentials };
