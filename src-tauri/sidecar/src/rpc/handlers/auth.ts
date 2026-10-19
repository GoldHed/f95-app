import type { AppContext } from '../../domain/context';
import { RPC_ERROR, RpcError, type RpcHandler } from '../../rpc';
import type { ImportedCookie } from '../../domain/f95/client';

export function createAuthHandlers(ctx: AppContext): Record<string, RpcHandler> {
  return {
    login: async (p) => {
      const client = ctx.requireClient();
      const username = p.username;
      const password = p.password;
      if (typeof username !== 'string' || typeof password !== 'string') {
        throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'username and password required');
      }
      return client.login(username, password);
    },
    getProfile: async () => ctx.requireClient().getProfile(),
    getMemberProfile: async (p) => {
      const userId = p.userId;
      if (typeof userId !== 'string' || !userId.trim()) {
        throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'userId required');
      }
      return ctx.requireClient().getMemberProfile(userId.trim());
    },
    isLoggedIn: async () => ({ loggedIn: await ctx.requireClient().isLoggedIn() }),
    importBrowserSession: async (p) => {
      const cookies = p.cookies;
      if (!Array.isArray(cookies) || cookies.length === 0) {
        throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'cookies required');
      }
      const userAgent = typeof p.userAgent === 'string' && p.userAgent.trim() ? p.userAgent : null;
      await ctx.requireClient().importBrowserSession(cookies as ImportedCookie[], userAgent);
      ctx.resetDerivedClients();
      return { ok: true };
    },
    logout: async () => {
      const client = ctx.requireClient();
      await client.logout();
      ctx.resetDerivedClients();
      return { ok: true };
    },
  };
}
