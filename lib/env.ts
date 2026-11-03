/**
 * Fail fast and loudly on missing configuration, instead of letting
 * `process.env.X!` blow up mid-request with an unreadable error.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `[env] Missing required environment variable: ${name}. ` +
        `Set it in .env.local and in the Vercel project settings.`
    )
  }
  return value
}

export const SUPABASE_URL = required("NEXT_PUBLIC_SUPABASE_URL")
export const SUPABASE_PUBLISHABLE_KEY = required(
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
)

/** Canonical public URL of this deployment (inlined at build time). */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? ""

/**
 * Whether the app is served over TLS. Browsers drop `Secure` cookies on plain
 * http, so an http staging/preview deployment must not set that flag.
 */
export const IS_HTTPS_DEPLOYMENT = SITE_URL.startsWith("https://")

/** Host of the Supabase project, used to build CSP allowlists. */
export const SUPABASE_HOST = (() => {
  try {
    return new URL(SUPABASE_URL).host
  } catch {
    return ""
  }
})()