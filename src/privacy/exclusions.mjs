export const defaultExcludedApps = [
  "1Password",
  "Keychain Access",
  "System Settings"
];

export const defaultExcludedDomains = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "idp.example"
];

export function observationExclusionReason({ appName, domain, excludedApps, excludedDomains }) {
  const normalizedApp = appName.toLowerCase();
  if (excludedApps.some((app) => app.toLowerCase() === normalizedApp)) {
    return `frontmost app "${appName}" is excluded`;
  }

  if (domain && excludedDomains.some((excluded) => domain === excluded || domain.endsWith(`.${excluded}`))) {
    return `domain "${domain}" is excluded`;
  }

  return null;
}
