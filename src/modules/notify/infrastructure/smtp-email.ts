import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import type { EmailPort } from "../application/ports";
import { assertEmailCarriesNoCaseContent } from "../domain/policies";
import type { EmailParams } from "../domain/types";

/**
 * Email through the relay the Supabase project is already configured with.
 *
 * WHY THIS AND NOT RESEND. The plan named Resend, and `resend` is still in
 * package.json, but the project turned out to already have custom SMTP
 * configured for Supabase Auth: `server.aveshost.net` as
 * `noreply@primaddc.com`, sending as "Prima Due Diligence Consult". Every
 * password-reset and invitation PDDC has ever sent went through it, so its
 * SPF, DKIM and DMARC records are already right for that domain and its
 * reputation is already established.
 *
 * Standing up a second sender would have meant a second domain to
 * authenticate, a second set of DNS records to keep correct, and two
 * different addresses writing to the same people about the same system. One
 * sender identity is worth more than the convenience of an HTTPS API, so the
 * notifications go out the same way the auth emails already do. Resend
 * remains available behind `EmailPort` if PDDC ever wants the delivery
 * webhooks it offers, which is the point of the port.
 *
 * WHAT THIS COSTS, honestly. SMTP has no idempotency key and no delivery
 * callbacks, so two things PRD 12.2 asks for are not available on this
 * transport:
 *
 *   - "idempotency key passed to Resend, so retries never duplicate". There
 *     is nothing to pass it to. The guarantee is enforced on our side
 *     instead: the outbox row is claimed before the send and its status
 *     moves out of `queued`, so a second worker cannot pick it up. A crash
 *     between the send and the status write could still duplicate one
 *     message, which is the right way round for an alert: a notification
 *     seen twice is a nuisance, a missed safety check-in is not.
 *
 *   - `delivered` and `bounced`, which arrive by webhook from Resend. Over
 *     SMTP we learn only that the relay accepted the message, so a send
 *     reaches `sent` and stops there. A bounce comes back to the mailbox
 *     rather than to the platform. Recorded in docs/PROGRESS.md as a
 *     deviation for PDDC to accept or to fund Resend for.
 *
 * The transporter is created once and reused. A new SMTP connection per
 * email would be slower than the send itself, and relays dislike it.
 */

let cached: Transporter | null = null;

function settings() {
  // Defaulted to the project's own configuration, so only the password has to
  // be supplied. Anything else is an override for a different environment.
  const host = process.env.SMTP_HOST ?? "server.aveshost.net";
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER ?? "noreply@primaddc.com";
  const pass = process.env.SMTP_PASSWORD;
  const fromName = process.env.SMTP_FROM_NAME ?? "Prima Due Diligence Consult";

  if (!pass) {
    throw new Error(
      "SMTP_PASSWORD is not set, so no notification email can be sent. It is the password for " +
        `${user} on ${host}, the same relay this Supabase project already uses for its ` +
        "authentication emails. The in-app notification is unaffected: it is written in the " +
        "business transaction and does not depend on this.",
    );
  }

  return { host, port, user, pass, fromName };
}

function transporter(): Transporter {
  if (cached) return cached;

  const { host, port, user, pass } = settings();

  cached = nodemailer.createTransport({
    host,
    port,
    // 587 is STARTTLS: the connection opens in the clear and is upgraded, so
    // `secure` is false and the upgrade is required rather than optional.
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
  });

  return cached;
}

/**
 * The email body, rendered from the template and the safe parameters.
 *
 * This is the only place an email body comes into existence, which is the
 * design: `notify.outbox` has no body column, so there is nowhere for case
 * content to have been stored on the way here, and `params` cannot hold
 * anything but the five permitted keys. The body therefore says what
 * happened only in general terms and points at the platform, where the
 * reader's own permissions decide what they see.
 */
function render(
  template: string,
  params: EmailParams,
): { subject: string; html: string } {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://iims.primaddc.com";
  const label = params.categoryLabel ?? "Notification";
  const greeting = params.recipientName ? `${params.recipientName},` : "Hello,";
  const link = params.link ? `${appUrl}${params.link}` : appUrl;

  const about = params.caseReference
    ? `<p style="margin:0 0 16px">It concerns case <strong>${params.caseReference}</strong>.</p>`
    : "";
  const due = params.dueAt
    ? `<p style="margin:0 0 16px">Due <strong>${params.dueAt}</strong>.</p>`
    : "";

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;background:#f7f6f2;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2733">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px">
    <p style="margin:0 0 4px;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#0b1f3a">PDDC IIMS</p>
    <p style="margin:0 0 24px;font-size:12px;color:#6b7280">Investigation Management &amp; Intelligence Platform</p>
    <h1 style="margin:0 0 16px;font-size:17px;font-weight:600">${label}</h1>
    <p style="margin:0 0 16px">${greeting}</p>
    <p style="margin:0 0 16px">There is something waiting for you in the investigation platform.</p>
    ${about}
    ${due}
    <p style="margin:0 0 24px">
      <a href="${link}" style="display:inline-block;background:#2e9e4f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Open the platform</a>
    </p>
    <p style="margin:0 0 8px;font-size:12px;color:#6b7280">
      This email deliberately contains no case detail. Sign in to see it, where your
      own permissions and clearance apply.
    </p>
    <p style="margin:0;font-size:12px;color:#6b7280">
      Authorised use only. All access is recorded in an append-only audit trail.
    </p>
  </div>
</body></html>`;

  // The case reference is the most an email may name (PRD 12.2), and it is
  // useful in a subject line because it lets somebody file the mail without
  // opening it.
  const subject = params.caseReference
    ? `[PDDC IIMS] ${label} - ${params.caseReference}`
    : `[PDDC IIMS] ${label}`;

  return { subject, html };
}

export function createSmtpEmail(): EmailPort {
  return {
    async send({ to, template, params, idempotencyKey }) {
      // The same rule the database enforces, checked again here because this
      // is the last moment before the content leaves the platform.
      assertEmailCarriesNoCaseContent(params);

      const { user, fromName } = settings();
      const { subject, html } = render(template, params);

      const info = await transporter().sendMail({
        from: { name: fromName, address: user },
        to,
        subject,
        html,
        text:
          "There is something waiting for you in the PDDC investigation platform. " +
          "Sign in to see it. This email deliberately contains no case detail.",
        headers: {
          // Not provider idempotency, which SMTP does not have, but it does
          // give a thread a stable identity and makes a duplicate visible in
          // a mailbox rather than silent.
          "X-PDDC-Idempotency-Key": idempotencyKey,
          "X-Auto-Response-Suppress": "All",
          "Auto-Submitted": "auto-generated",
        },
      });

      return { providerId: info.messageId ?? null };
    },
  };
}
