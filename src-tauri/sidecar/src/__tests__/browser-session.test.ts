import { describe, expect, it } from 'vitest';
import { BrowserClient } from 'browser-rest-api';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { F95Client } from '../domain/f95/client';

describe('importBrowserSession', () => {
  it('writes cookies the HTTP client sends to F95Zone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f95-session-'));
    const client = new F95Client({ sessionDir: dir, sessionId: 'default' });
    const in30Days = Math.floor(Date.now() / 1000) + 30 * 86400;
    await client.importBrowserSession(
      [
        { name: 'xf_user', value: '123%2Cabc', domain: '.f95zone.to', path: '/', expires: in30Days, secure: true, httpOnly: true },
        { name: 'xf_session', value: 'sess', domain: 'f95zone.to', path: '/', expires: null, secure: true, httpOnly: true },
        { name: 'cf_clearance', value: 'cf', domain: '.f95zone.to', path: '/', expires: in30Days },
      ],
      'Mozilla/5.0 TestBrowser',
    );
    await client.close();

    const saved = JSON.parse(await fs.readFile(path.join(dir, 'default.json'), 'utf8'));
    expect(saved.headers['user-agent']).toBe('Mozilla/5.0 TestBrowser');

    // A fresh client (what the app makes on its next start) loads them back.
    const http = new BrowserClient({ session: 'default', sessionDir: dir });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = http as any;
    await internals.ready;
    const header: string = await internals.jar.getCookieString('https://f95zone.to/account/');
    expect(header).toContain('xf_user=123%2Cabc');
    expect(header).toContain('xf_session=sess');
    expect(header).toContain('cf_clearance=cf');
    const sub: string = await internals.jar.getCookieString('https://attachments.f95zone.to/x');
    expect(sub).toContain('xf_user=');
    expect(sub).not.toContain('xf_session=');
    await http.close();
  });
});
