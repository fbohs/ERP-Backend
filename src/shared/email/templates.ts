function shell(title: string, previewText: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${title}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${previewText}&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;</span>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;">

          <!-- Logo / wordmark -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <span style="font-size:22px;font-weight:700;color:#18181b;letter-spacing:-0.5px;">ERP</span>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);padding:40px 40px 32px;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0;font-size:12px;color:#71717a;line-height:1.6;">
                You received this email because an action was requested on your account.<br />
                If you did not request this, you can safely ignore it.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(label: string, url: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center" style="padding:28px 0 8px;">
        <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${url}" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="10%" fillcolor="#18181b"><w:anchorlock/><center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:600;">${label}</center></v:roundrect><![endif]-->
        <!--[if !mso]><!-->
        <a href="${url}" style="display:inline-block;background-color:#18181b;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;letter-spacing:0.1px;">${label}</a>
        <!--<![endif]-->
      </td>
    </tr>
  </table>`;
}

function fallbackLink(url: string): string {
  return `<p style="margin:20px 0 0;font-size:12px;color:#71717a;text-align:center;word-break:break-all;">
    Or copy this link into your browser:<br />
    <a href="${url}" style="color:#71717a;">${url}</a>
  </p>`;
}

function expiryNote(minutes: number): string {
  return `<p style="margin:20px 0 0;font-size:13px;color:#71717a;text-align:center;">
    This link expires in <strong>${minutes} minute${minutes !== 1 ? 's' : ''}</strong>.
  </p>`;
}

export function passwordResetEmail(opts: {
  name: string;
  resetUrl: string;
  ttlMinutes: number;
}): string {
  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181b;letter-spacing:-0.3px;">Reset your password</h1>
    <p style="margin:0 0 0;font-size:15px;color:#52525b;line-height:1.6;">Hi ${opts.name},</p>
    <p style="margin:12px 0 0;font-size:15px;color:#52525b;line-height:1.6;">
      We received a request to reset the password for your account. Click the button below to choose a new one.
    </p>
    ${ctaButton('Reset password', opts.resetUrl)}
    ${expiryNote(opts.ttlMinutes)}
    <hr style="margin:28px 0 0;border:none;border-top:1px solid #e4e4e7;" />
    ${fallbackLink(opts.resetUrl)}
  `;
  return shell('Reset your password', 'Reset your ERP account password.', body);
}

export function tenantWelcomeEmail(opts: {
  name: string;
  tenantName: string;
  email: string;
  temporaryPassword: string;
  loginUrl: string;
}): string {
  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181b;letter-spacing:-0.3px;">Welcome to ${opts.tenantName}</h1>
    <p style="margin:0 0 0;font-size:15px;color:#52525b;line-height:1.6;">Hi ${opts.name},</p>
    <p style="margin:12px 0 0;font-size:15px;color:#52525b;line-height:1.6;">
      Your account has been created. Use the credentials below to sign in for the first time.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0 0;background-color:#f4f4f5;border-radius:8px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Your login details</p>
          <p style="margin:0 0 6px;font-size:14px;color:#18181b;"><strong>Email:</strong> ${opts.email}</p>
          <p style="margin:0;font-size:14px;color:#18181b;"><strong>Temporary password:</strong> <span style="font-family:monospace;background:#e4e4e7;padding:2px 6px;border-radius:4px;">${opts.temporaryPassword}</span></p>
        </td>
      </tr>
    </table>
    ${ctaButton('Sign in to your account', opts.loginUrl)}
    <p style="margin:20px 0 0;font-size:13px;color:#71717a;text-align:center;">
      For your security, you will be asked to set a new password on first sign-in.
    </p>
    <hr style="margin:28px 0 0;border:none;border-top:1px solid #e4e4e7;" />
    ${fallbackLink(opts.loginUrl)}
  `;
  return shell(
    `Welcome to ${opts.tenantName}`,
    `Your ${opts.tenantName} account is ready — sign in to get started.`,
    body,
  );
}

export function userWelcomeEmail(opts: {
  name: string;
  tenantName: string;
  role: string;
  email: string;
  temporaryPassword: string;
  loginUrl: string;
}): string {
  const roleLabel = opts.role
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');

  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181b;letter-spacing:-0.3px;">Welcome to ${opts.tenantName}</h1>
    <p style="margin:0 0 0;font-size:15px;color:#52525b;line-height:1.6;">Hi ${opts.name},</p>
    <p style="margin:12px 0 0;font-size:15px;color:#52525b;line-height:1.6;">
      Your <strong>${roleLabel}</strong> account on <strong>${opts.tenantName}</strong> has been created.
      Use the credentials below to sign in for the first time.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0 0;background-color:#f4f4f5;border-radius:8px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">Your login details</p>
          <p style="margin:0 0 6px;font-size:14px;color:#18181b;"><strong>Email:</strong> ${opts.email}</p>
          <p style="margin:0;font-size:14px;color:#18181b;"><strong>Temporary password:</strong> <span style="font-family:monospace;background:#e4e4e7;padding:2px 6px;border-radius:4px;">${opts.temporaryPassword}</span></p>
        </td>
      </tr>
    </table>
    ${ctaButton('Sign in to your account', opts.loginUrl)}
    <p style="margin:20px 0 0;font-size:13px;color:#71717a;text-align:center;">
      For your security, you will be asked to set a new password on first sign-in.
    </p>
    <hr style="margin:28px 0 0;border:none;border-top:1px solid #e4e4e7;" />
    ${fallbackLink(opts.loginUrl)}
  `;
  return shell(
    `Welcome to ${opts.tenantName}`,
    `Your ${opts.tenantName} ${roleLabel} account is ready — sign in to get started.`,
    body,
  );
}

export function platformLoginEmail(opts: {
  name: string;
  loginUrl: string;
  ttlMinutes: number;
}): string {
  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181b;letter-spacing:-0.3px;">Sign in to Platform Console</h1>
    <p style="margin:0 0 0;font-size:15px;color:#52525b;line-height:1.6;">Hi ${opts.name},</p>
    <p style="margin:12px 0 0;font-size:15px;color:#52525b;line-height:1.6;">
      Here is your one-time sign-in link for the ERP Platform Console. This link can only be used once.
    </p>
    ${ctaButton('Sign in', opts.loginUrl)}
    ${expiryNote(opts.ttlMinutes)}
    <hr style="margin:28px 0 0;border:none;border-top:1px solid #e4e4e7;" />
    ${fallbackLink(opts.loginUrl)}
  `;
  return shell('Sign in to Platform Console', 'Your one-time sign-in link for the ERP Platform Console.', body);
}
