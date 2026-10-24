import type { RequestIdVariables } from 'hono/request-id';
import type { TokenKind } from '../shared/tokens.js';

/** Who is calling, set by the token middleware on success (spec §4 token columns). */
export interface AuthContext {
  agentId: string;
  tokenId: string;
  kind: Exclude<TokenKind, 'oauth_refresh'>;
  /** OAuth tokens only: the registered client. */
  oauthClientId: string | null;
  readScopes: string[];
  writeScopes: string[];
  labelCeiling: string;
  rights: string[];
}

export interface AppEnv {
  Variables: RequestIdVariables & { auth?: AuthContext };
}
