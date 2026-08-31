import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { OAuth2Client } from "google-auth-library";
import { forbidden, serviceUnavailable } from "../lib/errors.js";

const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"];

function latestVersion(resource) {
  return resource.includes("/versions/") ? resource : `${resource}/versions/latest`;
}

export class GoogleOAuthProvider {
  constructor(config, secretManager = new SecretManagerServiceClient()) {
    this.config = config;
    this.secretManager = secretManager;
  }

  async #client() {
    const resource = this.config.googleOAuthClientSecretResource;
    if (!resource || !this.config.googleClientId || !this.config.googleOAuthRedirectUri) {
      throw serviceUnavailable("oauth_not_configured", "Google OAuth is not configured");
    }
    const [version] = await this.secretManager.accessSecretVersion({ name: latestVersion(resource) });
    const secret = version.payload?.data?.toString("utf8");
    if (!secret) throw serviceUnavailable("oauth_secret_unavailable", "Google OAuth client secret is unavailable");
    return new OAuth2Client(this.config.googleClientId, secret, this.config.googleOAuthRedirectUri);
  }

  async authorizationUrl({ state, nonce, pkceChallenge }) {
    const client = await this.#client();
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state,
      code_challenge: pkceChallenge,
      code_challenge_method: "S256",
      nonce,
    });
  }

  async exchangeCode({ code, codeVerifier, nonce }) {
    const client = await this.#client();
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: this.config.googleOAuthRedirectUri });
    if (!tokens.id_token || !tokens.refresh_token) {
      throw forbidden("Google OAuth did not return the required tokens");
    }
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.googleClientId });
    const claims = ticket.getPayload();
    if (!claims?.sub || !claims.email || claims.email_verified !== true || claims.hd !== this.config.allowedDomain ||
        (claims.nonce && claims.nonce !== nonce)) {
      throw forbidden("Google OAuth identity is not authorized");
    }
    return { idToken: tokens.id_token, refreshToken: tokens.refresh_token, claims };
  }

  async storeRefreshToken(attendeeRef, refreshToken) {
    const project = this.config.googleCloudProject;
    if (!project) throw serviceUnavailable("secret_project_missing", "Secret Manager project is not configured");
    const parent = `projects/${project}`;
    const secretId = `openclaw-refresh-${attendeeRef}`;
    const resource = `${parent}/secrets/${secretId}`;
    try {
      await this.secretManager.createSecret({ parent, secretId, secret: { replication: { automatic: {} } } });
    } catch (error) {
      if (error.code !== 6) throw error;
    }
    await this.secretManager.addSecretVersion({
      parent: resource,
      payload: { data: Buffer.from(refreshToken, "utf8") },
    });
    return resource;
  }

  async refreshIdToken(secretResourceName) {
    const [version] = await this.secretManager.accessSecretVersion({ name: latestVersion(secretResourceName) });
    const refreshToken = version.payload?.data?.toString("utf8");
    if (!refreshToken) throw serviceUnavailable("refresh_token_unavailable", "Refresh token is unavailable");
    const client = await this.#client();
    const { tokens } = await client.refreshToken(refreshToken);
    if (!tokens.id_token) throw serviceUnavailable("id_token_unavailable", "Google did not return an ID token");
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.googleClientId });
    return { idToken: tokens.id_token, claims: ticket.getPayload() };
  }

  async accessToken(secretResourceName) {
    const [version] = await this.secretManager.accessSecretVersion({ name: latestVersion(secretResourceName) });
    const refreshToken = version.payload?.data?.toString("utf8");
    if (!refreshToken) throw serviceUnavailable("refresh_token_unavailable", "Refresh token is unavailable");
    const client = await this.#client();
    client.setCredentials({ refresh_token: refreshToken });
    const token = await client.getAccessToken();
    if (!token.token) throw serviceUnavailable("access_token_unavailable", "Google access token is unavailable");
    return token.token;
  }
}
