import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../src/ui/public/app.js', import.meta.url), 'utf8').replace(
  /bootstrap\(\);\s*$/,
  ''
);

class Element {
  children: unknown[] = [];
  textContent = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, (event: unknown) => void> = {};
  classList = { toggle() {} };
  append(...children: unknown[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: unknown[]) {
    this.children = children;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  addEventListener(name: string, listener: (event: unknown) => void) {
    this.listeners[name] = listener;
  }
}

function browser() {
  const nodes = new Map<string, Element>();
  const pending: Array<{ url: URL; resolve(value: unknown): void; reject(error: Error): void }> =
    [];
  const context = createContext({
    Node: Element,
    URL,
    performance,
    window: {
      location: { origin: 'http://localhost:4700', hash: '#/sessions' },
      addEventListener() {},
    },
    document: {
      getElementById(id: string) {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
      },
      createElement: () => new Element(),
      createDocumentFragment: () => new Element(),
      createTextNode: (text: string) => ({ textContent: text }),
      querySelectorAll: () => [],
    },
    fetch: (url: URL) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
  });
  runInContext(source, context);
  const evaluate = (code: string) => runInContext(code, context);
  const reply = (index: number, body: unknown) =>
    pending[index]!.resolve({ ok: true, json: async () => body });
  return { evaluate, reply, pending, nodes };
}

describe('UI navigation regressions', () => {
  it('ignores an old workspace response arriving after the active one', async () => {
    const { evaluate, reply } = browser();
    evaluate('viewSessions = () => {};');
    const old = evaluate("state.workspace = '/a'; loadSessions()");
    const current = evaluate("setScope('/b'); loadSessions()");
    reply(1, { sessions: [{ id: 'current' }] });
    await current;
    reply(0, { sessions: [{ id: 'stale' }] });
    await old;
    expect(evaluate('state.sessions[0].id')).toBe('current');
  });

  it('does not render a late error over another route', async () => {
    const { evaluate, pending, nodes } = browser();
    const old = evaluate('loadSessions()');
    evaluate(
      "window.location.hash = '#/search'; viewSearch = () => {}; route(); statusLeft('Search view');"
    );
    pending[0]!.reject(new Error('offline'));
    await old;
    expect(nodes.get('status-left')!.textContent).toBe('Search view');
  });

  it('sends refresh explicitly for only the requested read', async () => {
    const { evaluate, reply, pending } = browser();
    evaluate('viewSessions = () => {};');
    const refreshed = evaluate('loadSessions(true)');
    expect(pending[0]!.url.searchParams.get('refresh')).toBe('1');
    reply(0, { sessions: [] });
    await refreshed;
    const normal = evaluate('loadSessions()');
    expect(pending[1]!.url.searchParams.has('refresh')).toBe(false);
    reply(1, { sessions: [] });
    await normal;
  });

  it('renders untrusted history as text and leaves filtered source messages unchanged', () => {
    const { evaluate } = browser();
    const text = '<img src=x onerror=alert(1)>';
    expect(evaluate(`el('div', { text: ${JSON.stringify(text)} }).textContent`)).toBe(text);
    expect(() => evaluate("el('div', { html: '<b>unsafe</b>' })")).toThrow(/Raw HTML/);
    evaluate(
      "state.detail = { messages: [{ role: 'user', content: 'hello' }] }; state.only.add('user'); viewDetail();"
    );
    expect(evaluate('JSON.stringify(state.detail.messages)')).toBe(
      '[{"role":"user","content":"hello"}]'
    );
  });
});
