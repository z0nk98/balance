// Shared by the Money lent, Expenses and Bills pages: the GitHub connection
// and the secrets this device may remember (GitHub key, passphrase).
(function (root) {
  'use strict';

  const TOKEN_KEY = 'balance:github-token';
  const PASS_KEY = 'balance:passphrase';

  function GitHub(repo, token) {
    const base = `https://api.github.com/repos/${repo}`;
    let branch = 'main';

    async function req(method, path, body, accept = 'application/vnd.github+json') {
      const res = await fetch(base + path, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res;
    }

    async function json(method, path, body) {
      const res = await req(method, path, body);
      if (!res.ok) {
        const err = new Error(`GitHub error ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }

    return {
      async connect() {
        const res = await req('GET', '');
        if (res.status === 401) throw new Error('GitHub didn’t accept that key. Check that you copied all of it and that it hasn’t expired.');
        if (res.status === 404) throw new Error(`That key can’t see ${repo}. Give it access to this repository.`);
        if (!res.ok) throw new Error(`GitHub error ${res.status}. Try again.`);
        const info = await res.json();
        if (info.permissions && !info.permissions.push) {
          throw new Error('That key can only read. Give it “Contents: Read and write” permission.');
        }
        branch = info.default_branch || 'main';
      },

      async readText(path) {
        const res = await req('GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`, null, 'application/vnd.github.raw+json');
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Couldn’t load ${path} (GitHub error ${res.status})`);
        return res.text();
      },

      async listDir(path) {
        const res = await req('GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`);
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`Couldn’t list ${path} (GitHub error ${res.status})`);
        const items = await res.json();
        return Array.isArray(items) ? items.filter((i) => i.type === 'file').map((i) => i.name) : [];
      },

      // One commit with all changes; `content: null` deletes the file.
      async commit(message, files) {
        const ref = await json('GET', `/git/ref/heads/${branch}`);
        const parent = await json('GET', `/git/commits/${ref.object.sha}`);
        const tree = await json('POST', '/git/trees', {
          base_tree: parent.tree.sha,
          tree: files.map(([path, content]) =>
            content === null
              ? { path, mode: '100644', type: 'blob', sha: null }
              : { path, mode: '100644', type: 'blob', content }),
        });
        const commit = await json('POST', '/git/commits', { message, tree: tree.sha, parents: [ref.object.sha] });
        const res = await req('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
        if (res.status === 422) {
          const err = new Error('Your data was changed somewhere else (another device or tab). Reload this page to get the latest, then redo your last change.');
          err.conflict = true;
          throw err;
        }
        if (!res.ok) throw new Error(`GitHub error ${res.status} while saving`);
      },
    };
  }

  // get | remembered (kept on this device?) | clear | local (remember) |
  // session (this tab's visit only)
  function remembered(key, action, value) {
    try {
      if (action === 'get') return localStorage.getItem(key) || sessionStorage.getItem(key);
      if (action === 'remembered') return localStorage.getItem(key);
      if (action === 'clear') {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      }
      if (action === 'local') {
        localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
      }
      if (action === 'session') {
        sessionStorage.setItem(key, value);
        localStorage.removeItem(key);
      }
    } catch {
      // Storage unavailable: nothing is remembered.
    }
    return null;
  }

  async function loadConfig() {
    const res = await fetch(`config.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('config.json is missing');
    return res.json();
  }

  root.Account = {
    GitHub,
    loadConfig,
    token: (action, value) => remembered(TOKEN_KEY, action, value),
    passphrase: (action, value) => remembered(PASS_KEY, action, value),
  };
})(window);
