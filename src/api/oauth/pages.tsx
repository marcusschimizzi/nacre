import type { Child } from 'hono/jsx';

/**
 * The consent and error pages (spec §9.3): server-rendered with Hono JSX, which escapes every
 * interpolated value, so the client name (untrusted, from registration) can't inject markup. No
 * script and no cookie.
 */

/** The select's "create new agent" value. Can't be an agent id: ids have no `_`. */
export const NEW_AGENT = '__new__';

const STYLE = `
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f5f2;color:#1d1c1a}
main{max-width:32rem;margin:2rem auto;padding:1.5rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px #0002}
h1{font-size:1.3rem;margin:0 0 1rem}
label{display:block;font-weight:600;margin:1rem 0 .25rem}
select,input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;border:1px solid #bbb;border-radius:6px}
.hint{font-size:.85rem;color:#666;margin:.25rem 0 0}
.warn{background:#fff4d6;border:1px solid #e0b400;padding:.5rem .75rem;border-radius:6px}
.error{background:#fde8e8;border:1px solid #d33;padding:.5rem .75rem;border-radius:6px}
.buttons{display:flex;gap:.75rem;margin-top:1.5rem}
button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:1px solid #444;background:#fff;cursor:pointer}
button[value=approve]{background:#1d1c1a;color:#fff}
code{font-size:.85em}
@media (prefers-color-scheme: dark){body{background:#1b1a18;color:#eee}main{background:#262522}
select,input,button{background:#1b1a18;color:#eee;border-color:#555}button[value=approve]{background:#eee;color:#111}
.hint{color:#aaa}.warn{background:#3a3214}.error{background:#3a1d1d}}
`;

function Layout(props: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{props.title}</title>
        <style>{STYLE}</style>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export interface ConsentPageProps {
  clientId: string;
  /** Untrusted (dynamic registration). */
  clientName: string | null;
  redirectHost: string;
  loopback: boolean;
  /** The enabled agents, for the select. */
  agents: { agentId: string; displayName: string }[];
  /** An agent id from `agents`, or `NEW_AGENT`. */
  selected: string;
  newAgentId: string;
  signedRequest: string;
  /** A page-level message (wrong password, unknown agent, …). */
  error?: string | undefined;
  /** A message about the new agent id field. */
  fieldError?: string | undefined;
}

export function ConsentPage(p: ConsentPageProps) {
  const name = p.clientName?.trim() ? p.clientName : '(unnamed client)';
  return (
    <Layout title="Connect to Nacre">
      <h1>
        Connect <strong>{name}</strong> to Nacre?
      </h1>
      <p>
        It will read and write your Nacre memory as the agent you choose. After you answer, you go
        back to <strong>{p.redirectHost}</strong>.
      </p>
      {p.loopback ? (
        <p class="warn">
          That address is on this computer (loopback). Approve only if you just started this
          connection from an app on this device.
        </p>
      ) : null}
      <p class="hint">
        Client id <code>{p.clientId}</code>
      </p>
      {p.error ? <p class="error">{p.error}</p> : null}
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="request" value={p.signedRequest} />
        <label for="agent">Acts as agent</label>
        <select id="agent" name="agent">
          {p.agents.map((a) => (
            <option value={a.agentId} selected={p.selected === a.agentId}>
              {a.displayName === a.agentId ? a.agentId : `${a.agentId} (${a.displayName})`}
            </option>
          ))}
          <option value={NEW_AGENT} selected={p.selected === NEW_AGENT}>
            Create new agent
          </option>
        </select>
        <label for="new_agent_id">New agent id</label>
        <input
          id="new_agent_id"
          name="new_agent_id"
          value={p.newAgentId}
          maxlength={32}
          autocomplete="off"
          spellcheck={false}
          autocapitalize="none"
        />
        <p class="hint">
          Used only when "Create new agent" is selected. Lowercase letters, digits and single
          dashes, 2 to 32 characters.
        </p>
        {p.fieldError ? <p class="error">{p.fieldError}</p> : null}
        <label for="password">Owner password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
        />
        <div class="buttons">
          <button type="submit" name="decision" value="approve">
            Approve
          </button>
          <button type="submit" name="decision" value="deny">
            Deny
          </button>
        </div>
      </form>
    </Layout>
  );
}

/** For failures that must not redirect (unknown client, unregistered redirect URI, bad form). */
export function ErrorPage(props: { message: string }) {
  return (
    <Layout title="Nacre sign-in">
      <h1>This sign-in request can't be used</h1>
      <p>{props.message}</p>
      <p class="hint">Start the connection again from the app.</p>
    </Layout>
  );
}
