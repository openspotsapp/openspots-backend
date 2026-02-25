import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendEmail({ to, subject, html, text }) {
  try {
    const { data, error } = await resend.emails.send({
      from: "OpenSpots <no-reply@openspots.app>",
      to,
      subject,
      html,
      text,
    });

    if (error) {
      console.error("Resend error:", error);
      throw error;
    }

    return data;
  } catch (err) {
    console.error("Email send failed:", err);
    throw err;
  }
}

// ============================
// EMAIL TEMPLATE HELPERS
// ============================
function baseEmailLayout({ title, preheader, innerHtml, supportEmail }) {
  // Preheader hidden text improves inbox preview
  const hiddenPreheader = preheader
    ? `<div style="display:none; font-size:1px; color:#0f2f28; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">${preheader}</div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0; padding:0; background:#0f2f28;">
  ${hiddenPreheader}
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f2f28; padding:24px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
          style="max-width:600px; background:#0b3a31; border-radius:16px; overflow:hidden;">
          <tr>
            <td style="padding:20px; text-align:center; color:#ffffff; font-family:Arial,sans-serif;">
              <h2 style="margin:0;">${title}</h2>
            </td>
          </tr>

          ${innerHtml}

          <tr>
            <td style="padding:14px; text-align:center; font-size:12px;
              color:#b7e3d8; font-family:Arial,sans-serif;">
              Need help? <a href="mailto:${supportEmail}" style="color:#b7e3d8; text-decoration:underline;">${supportEmail}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function socialBarHtml({ supportEmail, socials }) {
  // IMPORTANT: Use your *_green.png URLs (baked color) for consistent rendering.
  // socials = [{ href, img, alt }]
  const cells = socials.map(s => `
    <td style="padding:0 10px;">
      <a href="${s.href}">
        <img src="${s.img}" width="28" height="28" style="display:block; border:0; outline:none; text-decoration:none;" alt="${s.alt}" />
      </a>
    </td>
  `).join("");

  return `
  <tr>
    <td style="background:#ffffff; padding:16px;">
      <table align="center" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
          ${cells}
        </tr>
      </table>
    </td>
  </tr>`;
}

// ============================
// 1) WELCOME EMAIL
// ============================

export function buildWelcomeEmail({ firstName, appUrl, supportEmail }) {
  const subject = "Welcome to OpenSpots";

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0; padding:0; background:#0f2f28;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f2f28; padding:24px 0;">
    <tr>
      <td align="center">

        <!-- CARD -->
        <table width="600" cellpadding="0" cellspacing="0"
               style="max-width:600px; background:#0b3a31; border-radius:16px; overflow:hidden;">

          <!-- HEADER -->
          <tr>
            <td style="padding:20px; text-align:center; color:#ffffff; font-family:Arial,sans-serif;">
              <h2 style="margin:0;">Welcome to OpenSpots</h2>
            </td>
          </tr>

          <!-- BANNER -->
          <tr>
            <td>
              <img
                src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/vn7j7u7z71uh/email-banner.png"
                width="600"
                style="display:block; width:100%;"
                alt="OpenSpots"
              />
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:20px; color:#ffffff; font-family:Arial,sans-serif; line-height:1.5;">
              <p style="margin-top:0;">Hi ${firstName || "there"},</p>

              <p>
                You’re in. OpenSpots helps you park faster with verified locations
                and simple checkout.
              </p>
            </td>
          </tr>

          <!-- GIF -->
          <tr>
            <td align="center" style="padding:0 20px 20px;">
              <a href="${appUrl}">
                <img
                  src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/atr2s9fw0dps/openspots.gif"
                  width="560"
                  style="width:100%; max-width:560px; border-radius:12px;"
                  alt="OpenSpots Demo"
                />
              </a>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <a href="${appUrl}"
                 style="background:#1f6f5b; color:#ffffff; text-decoration:none;
                        padding:12px 20px; border-radius:10px;
                        font-family:Arial,sans-serif; font-weight:bold;">
                Open OpenSpots
              </a>
            </td>
          </tr>

          <!-- SOCIAL BAR -->
          <tr>
            <td style="background:#ffffff; padding:16px;">
              <table align="center" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:0 10px;">
                    <a href="mailto:${supportEmail}">
                      <img src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/bn5b41rovg31/badge_email.png" width="28" />
                    </a>
                  </td>
                  <td style="padding:0 10px;">
                    <a href="https://facebook.com/OpenSpotsApp">
                      <img src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/yp5p4pvic5zc/badge_facebok.png" width="28" />
                    </a>
                  </td>
                  <td style="padding:0 10px;">
                    <a href="https://instagram.com/openspotsapp">
                      <img src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/rtu0rbbejb8p/badge_instagram.png" width="28" />
                    </a>
                  </td>
                  <td style="padding:0 10px;">
                    <a href="https://twitter.com/openspotsapp">
                      <img src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/d6ltpc9lh02v/badge_X.png" width="28" />
                    </a>
                  </td>
                  <td style="padding:0 10px;">
                    <a href="https://tiktok.com/@openspots">
                      <img src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/8ivm5hp3yq17/badge_tiktok.png" width="28" />
                    </a>
                  </td>
                  <td style="padding:0 10px;">
                    <a href="https://youtube.com/@openspotsapp">
                      <img src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/m1160f9479nf/badge_youtube.png" width="28" />
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding:14px; text-align:center; font-size:12px;
                       color:#b7e3d8; font-family:Arial,sans-serif;">
              Need help? ${supportEmail}
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

  const text = `
Hi ${firstName || "there"},

Welcome to OpenSpots.
You can reserve venue parking and manage your sessions in My Spots.

OpenSpots: ${appUrl}
Need help? ${supportEmail}
`;

  return { subject, html, text };
}


// ============================
// 2) PAYMENT METHOD ADDED
// ============================
export function buildPaymentMethodAddedEmail({
  firstName,
  appUrl,
  supportEmail,
  cardBrand,
  last4,
  expMonth,
  expYear,
  socials
}) {
  const subject = "Payment method added ✅";
  const title = "Payment method added ✅";
  const preheader = "Your card is saved — you’re ready to park in seconds.";

  const cardLine = (cardBrand && last4)
    ? `${cardBrand.toUpperCase()} •••• ${last4}${expMonth && expYear ? ` (exp ${expMonth}/${expYear})` : ""}`
    : "Your payment method is now saved.";

  const innerHtml = `
    <!-- BANNER -->
    <tr>
      <td>
        <img
          src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/vn7j7u7z71uh/email-banner.png"
          width="600"
          style="display:block; width:100%;"
          alt="OpenSpots"
        />
      </td>
    </tr>

    <tr>
      <td style="padding:20px; color:#ffffff; font-family:Arial,sans-serif; line-height:1.5;">
        <p style="margin-top:0;">Hi ${firstName || "there"},</p>
        <p style="margin:0 0 12px;">${cardLine}</p>
        <p style="margin:0 0 16px;">Next time you reserve or start a session, checkout is instant.</p>

        <p style="margin:0 0 18px;">
          <a href="${appUrl}" style="background:#1f6f5b; color:#ffffff; text-decoration:none;
            padding:12px 20px; border-radius:10px; font-family:Arial,sans-serif; font-weight:bold; display:inline-block;">
            Open OpenSpots
          </a>
        </p>
      </td>
    </tr>
    ${socialBarHtml({ supportEmail, socials })}
  `;

  const html = baseEmailLayout({ title, preheader, innerHtml, supportEmail });

  const text = `Hi ${firstName || "there"},

Payment method added.

${cardBrand && last4 ? `${cardBrand.toUpperCase()} •••• ${last4}` : ""}

OpenSpots: ${appUrl}
Need help? ${supportEmail}
`;

  return { subject, html, text };
}

// ============================
// 3) RESERVATION CONFIRMED
// ============================
export function buildReservationConfirmationEmail({
  to,
  firstName,
  venueName,
  eventName,
  spotLabel,
  qrCodeUrl,
  confirmationCode,
  appUrl,
  supportEmail
}) {
  const subject = "Reservation Confirmed 🎟️ — Your Spot Is Ready";
  const title = "Reservation confirmed 🎟️";
  const preheader = `${venueName || "Your venue"} reservation is confirmed.`;

  const innerHtml = `
    <!-- BANNER -->
    <tr>
      <td>
        <img
          src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/vn7j7u7z71uh/email-banner.png"
          width="600"
          style="display:block; width:100%;"
          alt="OpenSpots"
        />
      </td>
    </tr>

    <tr>
      <td style="padding:20px; color:#ffffff; font-family:Arial,sans-serif; line-height:1.5;">
        <p style="margin-top:0;">Hi ${firstName || "there"},</p>
        <p style="margin:0 0 12px;">Your reservation is confirmed.</p>

        <table cellpadding="0" cellspacing="0" style="width:100%; background:#0f2f28; border-radius:12px; margin:14px 0;">
          <tr>
            <td style="padding:12px; color:#b7e3d8; font-family:Arial,sans-serif; font-size:13px;">
              <div><strong style="color:#ffffff;">Venue:</strong> ${venueName || "-"}</div>
              <div><strong style="color:#ffffff;">Event:</strong> ${eventName || "-"}</div>
              <div><strong style="color:#ffffff;">Spot:</strong> ${spotLabel || "-"}</div>
              <div style="margin-top:10px;">
                <strong style="color:#ffffff;">Confirmation Code:</strong>
                <span style="font-weight:bold; letter-spacing:1px;">${confirmationCode || "-"}</span>
              </div>
            </td>
          </tr>
        </table>

        ${qrCodeUrl ? `
        <div style="text-align:center; margin:18px 0;">
          <img src="${qrCodeUrl}" width="240" height="240" style="display:inline-block; border:0;" alt="Reservation QR Code" />
        </div>
        ` : ""}

        <p style="margin:0 0 18px; text-align:center;">
          <a href="${appUrl}/my-spots.html?tab=reservations" style="background:#1f6f5b; color:#ffffff; text-decoration:none;
            padding:12px 20px; border-radius:10px; font-family:Arial,sans-serif; font-weight:bold; display:inline-block;">
            View Reservation
          </a>
        </p>
      </td>
    </tr>
  `;

  const html = baseEmailLayout({ title, preheader, innerHtml, supportEmail });

  const text = `Hi ${firstName || "there"},

Your reservation is confirmed.
Venue: ${venueName || "-"}
Event: ${eventName || "-"}
Spot: ${spotLabel || "-"}
Confirmation Code: ${confirmationCode || "-"}

Manage: ${appUrl}/my-spots.html?tab=reservations
Need help? ${supportEmail}
`;

  return { subject, html, text };
}

// ============================
// 4) PARKING STARTED 
// ============================
export function buildParkingStartedEmail({
  firstName,
  supportEmail,
  appUrl,
  zoneNumber,
  startedAt,
  ratePerHour,
  socials
}) {
  const subject = "Parking started 🚗";
  const title = "Parking started 🚗";
  const preheader = `Session started${zoneNumber ? ` • Zone ${zoneNumber}` : ""}`;

  const innerHtml = `
    <!-- BANNER -->
    <tr>
      <td>
        <img
          src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/vn7j7u7z71uh/email-banner.png"
          width="600"
          style="display:block; width:100%;"
          alt="OpenSpots"
        />
      </td>
    </tr>

    <tr>
      <td style="padding:20px; color:#ffffff; font-family:Arial,sans-serif; line-height:1.5;">
        <p style="margin-top:0;">Hi ${firstName || "there"},</p>
        <p style="margin:0 0 12px;">
          Your parking session is now <strong>ACTIVE</strong>${zoneNumber ? ` for <strong>Zone ${zoneNumber}</strong>` : ""}.
        </p>

        <table cellpadding="0" cellspacing="0" style="width:100%; background:#0f2f28; border-radius:12px; margin:14px 0;">
          <tr>
            <td style="padding:12px; color:#b7e3d8; font-family:Arial,sans-serif; font-size:13px;">
              <div><strong style="color:#ffffff;">Start:</strong> ${startedAt || "Just now"}</div>
              ${typeof ratePerHour === "number" ? `<div><strong style="color:#ffffff;">Rate:</strong> $${ratePerHour.toFixed(2)}/hr</div>` : ""}
            </td>
          </tr>
        </table>

        <p style="margin:0 0 18px;">
          You can end your session anytime from <strong>My Spots</strong>.
        </p>

        <p style="margin:0 0 18px;">
          <a href="${appUrl}/my-spots.html" style="background:#1f6f5b; color:#ffffff; text-decoration:none;
            padding:12px 20px; border-radius:10px; font-family:Arial,sans-serif; font-weight:bold; display:inline-block;">
            View My Session
          </a>
        </p>
      </td>
    </tr>
    ${socialBarHtml({ supportEmail, socials })}
  `;

  const html = baseEmailLayout({ title, preheader, innerHtml, supportEmail });

  const text = `Hi ${firstName || "there"},

Your parking session is ACTIVE${zoneNumber ? ` (Zone ${zoneNumber})` : ""}.
Start: ${startedAt || "Just now"}
${typeof ratePerHour === "number" ? `Rate: $${ratePerHour.toFixed(2)}/hr` : ""}

Manage: ${appUrl}/my-spots.html
Need help? ${supportEmail}
`;

  return { subject, html, text };
}

// ============================
// 5) PARKING RECEIPT / COMPLETED
// ============================
export function buildParkingReceiptEmail({
  firstName,
  supportEmail,
  appUrl,
  zoneNumber,
  startTime,
  endTime,
  totalMinutes,
  totalAmount,
  socials
}) {
  const subject = "Receipt: parking completed ✅";
  const title = "Parking completed ✅";
  const preheader = `Receipt${zoneNumber ? ` • Zone ${zoneNumber}` : ""}`;

  const innerHtml = `
    <!-- BANNER -->
    <tr>
      <td>
        <img
          src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/vn7j7u7z71uh/email-banner.png"
          width="600"
          style="display:block; width:100%;"
          alt="OpenSpots"
        />
      </td>
    </tr>

    <tr>
      <td style="padding:20px; color:#ffffff; font-family:Arial,sans-serif; line-height:1.5;">
        <p style="margin-top:0;">Hi ${firstName || "there"},</p>
        <p style="margin:0 0 12px;">Your session is complete. Here’s your receipt:</p>

        <table cellpadding="0" cellspacing="0" style="width:100%; background:#0f2f28; border-radius:12px; margin:14px 0;">
          <tr>
            <td style="padding:12px; color:#b7e3d8; font-family:Arial,sans-serif; font-size:13px;">
              ${zoneNumber ? `<div><strong style="color:#ffffff;">Zone:</strong> ${zoneNumber}</div>` : ""}
              <div><strong style="color:#ffffff;">Start:</strong> ${startTime || "-"}</div>
              <div><strong style="color:#ffffff;">End:</strong> ${endTime || "-"}</div>
              <div><strong style="color:#ffffff;">Duration:</strong> ${typeof totalMinutes === "number" ? `${totalMinutes} min` : "-"}</div>
              <div style="margin-top:10px; font-size:16px;">
                <strong style="color:#ffffff;">Total:</strong> ${typeof totalAmount === "number" ? `$${totalAmount.toFixed(2)}` : "-"}
              </div>
            </td>
          </tr>
        </table>

        <p style="margin:0 0 18px;">
          <a href="${appUrl}/my-spots.html" style="background:#1f6f5b; color:#ffffff; text-decoration:none;
            padding:12px 20px; border-radius:10px; font-family:Arial,sans-serif; font-weight:bold; display:inline-block;">
            View Activity
          </a>
        </p>
      </td>
    </tr>
    ${socialBarHtml({ supportEmail, socials })}
  `;

  const html = baseEmailLayout({ title, preheader, innerHtml, supportEmail });

  const text = `Hi ${firstName || "there"},

Parking completed.
${zoneNumber ? `Zone: ${zoneNumber}\n` : ""}Start: ${startTime || "-"}
End: ${endTime || "-"}
Duration: ${typeof totalMinutes === "number" ? `${totalMinutes} min` : "-"}
Total: ${typeof totalAmount === "number" ? `$${totalAmount.toFixed(2)}` : "-"}

Activity: ${appUrl}/my-spots.html
Need help? ${supportEmail}
`;

  return { subject, html, text };
}

// ============================
// 6) PARKING CANCELLED
// ============================
export function buildParkingCancelledEmail({
  firstName,
  supportEmail,
  appUrl,
  zoneNumber,
  reason,
  socials
}) {
  const subject = "Parking cancelled";
  const title = "Parking cancelled";
  const preheader = reason || "No charge was made.";

  const innerHtml = `
    <!-- BANNER -->
    <tr>
      <td>
        <img
          src="https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/vn7j7u7z71uh/email-banner.png"
          width="600"
          style="display:block; width:100%;"
          alt="OpenSpots"
        />
      </td>
    </tr>

    <tr>
      <td style="padding:20px; color:#ffffff; font-family:Arial,sans-serif; line-height:1.5;">
        <p style="margin-top:0;">Hi ${firstName || "there"},</p>
        <p style="margin:0 0 12px;">
          Your parking session${zoneNumber ? ` for <strong>Zone ${zoneNumber}</strong>` : ""} was cancelled.
        </p>
        <p style="margin:0 0 16px; color:#b7e3d8;">
          ${reason || "No charge was made."}
        </p>

        <p style="margin:0 0 18px;">
          <a href="${appUrl}" style="background:#1f6f5b; color:#ffffff; text-decoration:none;
            padding:12px 20px; border-radius:10px; font-family:Arial,sans-serif; font-weight:bold; display:inline-block;">
            Find another spot
          </a>
        </p>
      </td>
    </tr>
    ${socialBarHtml({ supportEmail, socials })}
  `;

  const html = baseEmailLayout({ title, preheader, innerHtml, supportEmail });

  const text = `Hi ${firstName || "there"},

Your parking session${zoneNumber ? ` (Zone ${zoneNumber})` : ""} was cancelled.
${reason || "No charge was made."}

OpenSpots: ${appUrl}
Need help? ${supportEmail}
`;

  return { subject, html, text };
}
