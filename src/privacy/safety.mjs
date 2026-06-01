const forbiddenKeyFragments = [
  "authorization",
  "clipboard",
  "cookie",
  "documentbody",
  "fullurl",
  "keystroke",
  "messagebody",
  "password",
  "rawdocument",
  "rawmessage",
  "rawtext",
  "secret",
  "token"
];

const queryUrlPattern = /\bhttps?:\/\/[^\s"'<>?]+\/?[^\s"'<>]*\?[^\s"'<>]+/i;
const credentialPattern = /\b(password|token|cookie|authorization|api[_-]?key)=/i;

export function assertPrivacySafe(value, location = "payload") {
  const violations = [];
  scan(value, location, violations);

  if (violations.length > 0) {
    const message = violations.map((violation) => `${violation.location}: ${violation.reason}`).join("; ");
    throw new Error(`Privacy validation failed: ${message}`);
  }
}

export function privacyRedactions() {
  return [
    "no_keystrokes",
    "no_clipboard_capture",
    "no_audio_capture",
    "no_raw_document_bodies",
    "no_raw_message_bodies",
    "query_strings_removed"
  ];
}

function scan(value, location, violations) {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, `${location}[${index}]`, violations));
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const forbidden = forbiddenKeyFragments.find((fragment) => normalizedKey.includes(fragment));
      if (forbidden) {
        violations.push({ location: `${location}.${key}`, reason: `forbidden field name contains ${forbidden}` });
      }
      scan(child, `${location}.${key}`, violations);
    }
    return;
  }

  if (typeof value === "string") {
    if (queryUrlPattern.test(value)) {
      violations.push({ location, reason: "full URL with query string" });
    }
    if (credentialPattern.test(value)) {
      violations.push({ location, reason: "credential-like string" });
    }
  }
}
