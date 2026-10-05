const REDACTED = '[REDACTED]'

/**
 * A small persistence/display safety net around ZSense Agent Core's native
 * security.redact_secrets policy. Keep this deliberately conservative: it
 * targets credentials, not ordinary identifiers such as phone numbers.
 */
export function redactSensitiveText(value) {
  if (typeof value !== 'string' || !value) return value

  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi, `${REDACTED} PRIVATE KEY`)
    .replace(/\b(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, `$1${REDACTED}:${REDACTED}@`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
    .replace(/\b((?:[A-Z0-9]+[_-])?(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|CLIENT[_-]?SECRET|SECRET|PASSWORD|PASSWD|PWD|PRIVATE[_-]?KEY))\b(\s*[:=]\s*)(["']?)([^\s"'`,;]{6,})\3/gi, `$1$2$3${REDACTED}$3`)
    .replace(/\b(?:sk|rk|pk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
}
