import { GoogleAuth, OAuth2Client } from "google-auth-library";

function authorizationValue(headers) {
  if (typeof headers?.get === "function") return headers.get("authorization");
  return headers?.authorization || headers?.Authorization;
}

export class GoogleProxyIdentity {
  constructor({ iapAudience, backendAudience, oauthClient = new OAuth2Client(), googleAuth = new GoogleAuth() }) {
    this.iapAudience = iapAudience;
    this.backendAudience = backendAudience;
    this.oauthClient = oauthClient;
    this.googleAuth = googleAuth;
    this.backendClientPromise = null;
  }

  async verifyIap(assertion) {
    if (!assertion || !this.iapAudience) throw Object.assign(new Error("IAP authentication is required"), { status: 401 });
    try {
      const { pubkeys } = await this.oauthClient.getIapPublicKeys();
      const ticket = await this.oauthClient.verifySignedJwtWithCertsAsync(
        assertion,
        pubkeys,
        this.iapAudience,
        ["https://cloud.google.com/iap"],
      );
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload?.email) throw new Error("IAP identity is incomplete");
      return { sub: payload.sub, email: payload.email };
    } catch {
      throw Object.assign(new Error("IAP assertion is invalid"), { status: 401 });
    }
  }

  async backendAuthorization() {
    if (!this.backendAudience) throw new Error("BACKEND_AUDIENCE is required");
    this.backendClientPromise ||= this.googleAuth.getIdTokenClient(this.backendAudience);
    const client = await this.backendClientPromise;
    const authorization = authorizationValue(await client.getRequestHeaders());
    if (!authorization?.startsWith("Bearer ")) throw new Error("Unable to obtain backend identity token");
    return authorization;
  }
}
