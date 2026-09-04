import { getConfig, type PacketChatConfig } from "@packetchat/config";

export type AuthEmailProvider = "manual" | "resend" | "smtp";

export type AuthEmailDelivery = {
  provider: AuthEmailProvider;
  status: "manual" | "sent" | "failed";
  id?: string;
  message?: string;
};

export type AuthEmailKind = "invite" | "password_reset";

export type AuthEmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  // The one-time link the body carries, kept apart so it can be stripped from any
  // failure text before that text reaches an API response or an audit row.
  linkUrl?: string;
};

export type AuthEmailSettings = {
  provider: AuthEmailProvider;
  from: string;
  timeoutMs: number;
  resendApiKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  smtpRejectUnauthorized: boolean;
};

// Transports are injectable so provider selection, failures and the timeout path
// can be exercised without a relay or an outbound request.
export type SmtpSender = (message: AuthEmailMessage, settings: AuthEmailSettings, signal: AbortSignal) => Promise<string | undefined>;

export type AuthEmailTransports = {
  fetch?: typeof fetch;
  sendSmtp?: SmtpSender;
};

class AuthEmailTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthEmailTimeoutError";
  }
}

// Same hazard as withEnqueueTimeout in packages/jobs: a relay that accepts the
// connection and then stops answering leaves the send promise pending forever
// and takes the admin request down with it. Bound every send so the catch below
// is reachable and the caller can fall back to hand-delivering the token.
async function withSendTimeout<T>(describe: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AuthEmailTimeoutError(`${describe} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function emailSettingsFromConfig(config: PacketChatConfig = getConfig()): AuthEmailSettings {
  return {
    provider: config.EMAIL_PROVIDER,
    from: config.EMAIL_FROM,
    timeoutMs: config.EMAIL_SEND_TIMEOUT_MS,
    resendApiKey: config.RESEND_API_KEY,
    smtpHost: config.SMTP_HOST,
    smtpPort: config.SMTP_PORT,
    smtpSecure: config.SMTP_SECURE,
    smtpUser: config.SMTP_USER,
    smtpPassword: config.SMTP_PASSWORD,
    smtpRejectUnauthorized: config.SMTP_REJECT_UNAUTHORIZED
  };
}

export function buildAuthEmailMessage(input: { to: string; kind: AuthEmailKind; url: string; expiresSeconds: number }): AuthEmailMessage {
  const isInvite = input.kind === "invite";
  const subject = isInvite ? "Accept your PacketChat invite" : "Reset your PacketChat password";
  const expiry = formatDuration(input.expiresSeconds);
  const action = isInvite ? "accept your invite" : "reset your password";
  const text = `Use this link to ${action}:\n\n${input.url}\n\nThis link expires in ${expiry}. If you did not expect this email, ignore it.`;
  const html = `<p>Use this link to ${action}:</p><p><a href="${escapeHtml(input.url)}">${escapeHtml(subject)}</a></p><p>This link expires in ${escapeHtml(expiry)}. If you did not expect this email, ignore it.</p>`;

  return { to: input.to, subject, text, html, linkUrl: input.url };
}

// Callers persist the invite or reset token before calling this and surface the
// URL in their response whatever comes back, so delivery never throws: a thrown
// error would lose the token the operator falls back to. The outcome is returned
// instead, and "failed" is never dressed up as "manual".
export async function sendAuthEmail(input: {
  to: string;
  kind: AuthEmailKind;
  url: string;
  expiresSeconds: number;
}): Promise<AuthEmailDelivery> {
  return deliverAuthEmail(buildAuthEmailMessage(input), emailSettingsFromConfig());
}

export async function deliverAuthEmail(
  message: AuthEmailMessage,
  settings: AuthEmailSettings,
  transports: AuthEmailTransports = {}
): Promise<AuthEmailDelivery> {
  if (settings.provider === "resend") return deliverViaResend(message, settings, transports);
  if (settings.provider === "smtp") return deliverViaSmtp(message, settings, transports);
  return { provider: "manual", status: "manual" };
}

// A configured provider that cannot send is reported as "failed", never as
// "manual": manual mode is a deliberate operator choice, a missing key is not,
// and the two must not look alike in the admin response.
async function deliverViaResend(message: AuthEmailMessage, settings: AuthEmailSettings, transports: AuthEmailTransports): Promise<AuthEmailDelivery> {
  if (!settings.resendApiKey) return { provider: "resend", status: "failed", message: "EMAIL_PROVIDER is resend but RESEND_API_KEY is not set" };

  const send = transports.fetch ?? fetch;
  try {
    return await withSendTimeout("Resend send", settings.timeoutMs, async (signal) => {
      const response = await send("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ from: settings.from, to: message.to, subject: message.subject, text: message.text, html: message.html }),
        signal
      });

      if (!response.ok) {
        const detail = await readResendError(response);
        return {
          provider: "resend" as const,
          status: "failed" as const,
          message: redactSecrets(`Resend returned ${response.status}${detail ? `: ${detail}` : ""}`, settings, message)
        };
      }

      const data = (await response.json().catch(() => null)) as { id?: string } | null;
      return { provider: "resend" as const, status: "sent" as const, id: data?.id };
    });
  } catch (error) {
    return { provider: "resend", status: "failed", message: redactSecrets(describeSendError("Resend request failed", error), settings, message) };
  }
}

async function deliverViaSmtp(message: AuthEmailMessage, settings: AuthEmailSettings, transports: AuthEmailTransports): Promise<AuthEmailDelivery> {
  if (!settings.smtpHost) return { provider: "smtp", status: "failed", message: "EMAIL_PROVIDER is smtp but SMTP_HOST is not set" };

  const send = transports.sendSmtp ?? sendWithNodemailer;
  try {
    const id = await withSendTimeout("SMTP send", settings.timeoutMs, (signal) => send(message, settings, signal));
    return { provider: "smtp", status: "sent", id };
  } catch (error) {
    return { provider: "smtp", status: "failed", message: redactSecrets(describeSendError("SMTP send failed", error), settings, message) };
  }
}

const sendWithNodemailer: SmtpSender = async (message, settings, signal) => {
  // Imported lazily so the mailer is only loaded by deployments that use SMTP.
  const { createTransport } = await import("nodemailer");
  const transporter = createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPassword } : undefined,
    connectionTimeout: settings.timeoutMs,
    greetingTimeout: settings.timeoutMs,
    socketTimeout: settings.timeoutMs,
    tls: { rejectUnauthorized: settings.smtpRejectUnauthorized }
  });

  // The timeout aborts the signal; closing the transport tears down the socket
  // instead of leaving it open until the relay decides to answer.
  const abort = () => transporter.close();
  signal.addEventListener("abort", abort, { once: true });

  try {
    const info = await transporter.sendMail({
      from: settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html
    });
    return typeof info?.messageId === "string" ? info.messageId : undefined;
  } finally {
    signal.removeEventListener("abort", abort);
    transporter.close();
  }
};

async function readResendError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return truncate(parsed.message);
  } catch {
    // Non-JSON error bodies are reported as-is.
  }
  return truncate(body);
}

function describeSendError(fallback: string, error: unknown): string {
  if (error instanceof AuthEmailTimeoutError) return error.message;
  if (error instanceof Error && error.message) return `${fallback}: ${truncate(error.message)}`;
  return fallback;
}

// Relay errors quote whatever failed, so they can carry the credential that was
// offered or the link that was being delivered. A delivery result is returned to
// an admin and written to an audit row, so neither may survive in it.
function redactSecrets(text: string, settings: AuthEmailSettings, message: AuthEmailMessage): string {
  let redacted = text;
  for (const secret of [settings.smtpPassword, settings.resendApiKey, message.linkUrl]) {
    if (secret && secret.length >= 4) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function truncate(value: string, max = 200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
