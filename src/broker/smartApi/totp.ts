import * as OTPAuth from "otpauth";

/** 6-digit TOTP from Angel base32 seed (SmartAPI `loginByPassword.totp`). */
export function generateTotpCode(base32Secret: string): string {
  const cleaned = base32Secret.replace(/\s/g, "").toUpperCase();
  const totp = new OTPAuth.TOTP({
    digits: 6,
    period: 30,
    algorithm: "SHA1",
    secret: OTPAuth.Secret.fromBase32(cleaned),
  });
  return totp.generate();
}
