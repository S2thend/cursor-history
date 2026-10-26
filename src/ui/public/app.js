/**
 * cursor-history UI client.
 *
 * A dependency-free single-page app over the local JSON API. All history text
 * is inserted as text nodes, never as HTML, because conversation content is
 * untrusted input.
 */

const DIRECT_TIMESTAMP_SOURCES = new Set([
  'composer-created-at',
  'composer-timing',
  'store-turn-timing',
]);

const MESSAGE_TYPES = ['user', 'assistant', 'tool', 'thinking', 'error'];

const state = {
  route: 'sessions',
  workspace: '',
  workspaces: [],
  sessions: [],
  showAll: false,
  cross: false,
  filter: '',
  only: new Set(),
  detail: null,
  query: '',
  results: [],
  expandText: false,
  fullOutput: false,
  fullThinking: false,
};

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('Raw HTML insertion is not permitted.');
    else if (key === 'checked' || key === 'disabled' || key === 'selected') {
      // Reflect state as a live property. Setting these as string attributes
      // would leave a checkbox checked even when the value is `false`.
      node[key] = Boolean(value);
    } else if (key === 'value') {
      node.value = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const content = () => document.getElementById('content');
const statusLeft = (text) => {
  document.getElementById('status-left').textContent = text;
};
const statusRight = (text) => {
  document.getElementById('status-right').textContent = text;
};

function render(node) {
  const root = content();
  root.replaceChildren(node);
  root.scrollTop = 0;
}

function renderError(title, detail, retry) {
  render(
    el('div', { class: 'error-state' }, [
      el('h2', { class: 'page-title', text: title }),
      el('p', { text: detail }),
      retry
        ? el('button', { class: 'btn', type: 'button', text: 'Try again', onClick: retry })
        : null,
    ])
  );
}

function renderLoading(label) {
  render(
    el('div', { class: 'empty-state' }, [
      el('p', { class: 'spinner', 'aria-hidden': 'true' }),
      el('p', { text: label }),
    ])
  );
}

async function api(path, params = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url);
  } catch {
    // A rejected fetch here means the local server itself is unreachable —
    // usually because it was stopped or is bound to a different port. That is
    // a different problem from a server-side error, so say so plainly.
    const offline = new Error(
      `Can't reach the local server at ${window.location.origin}. It may have been stopped, or this tab may be pointing at an older port. Start it with: cursor-history ui`
    );
    offline.offline = true;
    throw offline;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? `${response.status} ${response.statusText}`);
    if (body.scope) error.scope = body.scope;
    throw error;
  }
  return body;
}

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour12: false });
};

const formatCount = (value) => (typeof value === 'number' ? value.toLocaleString() : '—');

function workspaceLabel(path, id) {
  if (path) return path;
  if (id === 'global') return '(global)';
  return id ?? '(unknown)';
}

/** Classify a message the same way the CLI's `--only` filter does. */
function messageTypes(message) {
  const types = new Set();
  const text = message.content ?? '';
  const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  if (calls.length > 0 || text.includes('[Tool:')) types.add('tool');
  if (calls.some((call) => call.status === 'error') || text.includes('[Error]')) types.add('error');
  if (message.thinking || text.includes('[Thinking]')) types.add('thinking');
  if (message.role === 'user') types.add('user');
  if (message.role === 'assistant' && text.trim().length > 0) types.add('assistant');
  return types;
}

/** Primary presentation type for colour and the role label. */
function primaryType(messageTypesSet) {
  for (const candidate of ['error', 'tool', 'thinking', 'user', 'assistant']) {
    if (messageTypesSet.has(candidate)) return candidate;
  }
  return 'assistant';
}

const ROLE_LABEL = {
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
  thinking: 'Thinking',
  error: 'Error',
};

/** Build inline text with fenced and inline code, using text nodes only. */
function richText(text) {
  const fragment = document.createDocumentFragment();
  const segments = String(text).split(/```/u);
  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      const newline = segment.indexOf('\n');
      const language = newline === -1 ? '' : segment.slice(0, newline).trim();
      const code = newline === -1 ? segment : segment.slice(newline + 1);
      fragment.append(
        el('pre', { class: 'code', 'data-lang': language || null, text: code.replace(/\n$/u, '') })
      );
      return;
    }
    for (const [i, piece] of segment.split('`').entries()) {
      if (!piece) continue;
      fragment.append(i % 2 === 1 ? el('code', { text: piece }) : document.createTextNode(piece));
    }
  });
  return fragment;
}

function tokenBadge(message) {
  const usage = message.tokenUsage;
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return null;
  const parts = [`${formatCount(usage.inputTokens)} in`, `${formatCount(usage.outputTokens)} out`];
  if (message.durationMs) parts.push(`${(message.durationMs / 1000).toFixed(1)}s`);
  return el('span', { class: 'token', text: `[${parts.join(' → ')}]` });
}

function toolCallCard(call, fullOutput) {
  const head = [
    el('span', { class: `status-dot ${call.status ?? 'completed'}`, 'aria-hidden': 'true' }),
    el('span', { class: 'tool-name', text: call.name }),
    call.status && call.status !== 'completed'
      ? el('span', { class: 'badge warn', text: call.status })
      : null,
    tokenBadge(call),
  ];
  const body = [];
  if (call.params && Object.keys(call.params).length > 0) {
    body.push(el('pre', { class: 'code', text: JSON.stringify(call.params, null, 2) }));
  }
  if (call.error) body.push(el('div', { class: 'msg-body', text: call.error }));
  if (call.result) {
    body.push(
      el('div', { class: fullOutput ? 'msg-body' : 'msg-body clamped' }, [richText(call.result)])
    );
  }
  return el('details', { class: 'block', open: true }, [
    el('summary', {}, [el('span', { class: 'tool-head' }, head)]),
    el('div', { class: 'block-body' }, body),
  ]);
}

function messageCard(message, options) {
  const types = messageTypes(message);
  const kind = primaryType(types);
  const showTime = DIRECT_TIMESTAMP_SOURCES.has(message.timestampSource);
  const role = [el('b', { text: ROLE_LABEL[kind] ?? 'Assistant' })];

  if (options.matchedType) {
    role.push(el('span', { class: 'badge', text: options.matchedType }));
  }
  if (showTime) role.push(el('span', { text: formatTime(message.timestamp) }));
  if (message.source) role.push(el('span', { class: 'badge', text: message.source }));
  if (message.model) role.push(el('span', { text: message.model }));
  const badge = tokenBadge(message);
  if (badge) role.push(badge);

  const body = [];
  const text = message.content ?? '';
  const hasStructuredTool = Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
  if (text.trim().length > 0) {
    body.push(
      el('div', { class: options.expandText ? 'msg-body' : 'msg-body clamped' }, [richText(text)])
    );
  }
  for (const block of message.codeBlocks ?? []) {
    if (typeof block === 'string') body.push(el('pre', { class: 'code', text: block }));
    else if (block?.content) body.push(el('pre', { class: 'code', text: block.content }));
  }
  for (const call of message.toolCalls ?? []) {
    body.push(toolCallCard(call, options.fullOutput));
  }
  if (message.thinking && !text.includes('[Thinking]')) {
    body.push(
      el('details', { class: 'block' }, [
        el('summary', { text: options.fullThinking ? 'Reasoning' : 'Reasoning (collapsed)' }),
        el('div', { class: 'block-body' }, [
          el('div', { class: options.fullThinking ? 'msg-body' : 'msg-body clamped' }, [
            richText(message.thinking),
          ]),
        ]),
      ])
    );
  }
  void hasStructuredTool;

  return el('article', { class: `msg ${kind}` }, [el('div', { class: 'msg-role' }, role), ...body]);
}

/* ------------------------------------------------------------------ views */

function sessionRow(session) {
  const ambiguous = session.resolutionState === 'ambiguous';
  const row = el('tr', { class: ambiguous ? 'row-ambiguous' : 'clickable' }, [
    el('td', { class: 'num', text: String(session.index ?? '') }),
    el('td', { class: 'col-title' }, [
      el('div', { class: 'title-cell', text: session.title || '(untitled session)' }),
      el('div', {
        class: 'preview-cell',
        text: ambiguous
          ? `${session.occurrenceCount ?? 2} divergent copies — not addressable; resolve with a workspace scope`
          : session.preview || '(empty session)',
      }),
    ]),
    el('td', { class: 'num', text: formatCount(session.messageCount) }),
    el('td', {
      class: 'badge ' + (session.resolutionState === 'complete' ? 'full' : 'partial'),
      text: session.resolvedSource ?? session.source ?? 'unknown',
    }),
    el('td', { class: 'path', text: workspaceLabel(session.workspacePath, session.workspaceId) }),
    el('td', { class: 'num', text: formatDate(session.lastUpdatedAt) }),
  ]);
  if (!ambiguous) {
    row.addEventListener('click', () => navigate(`#/session/${encodeURIComponent(session.id)}`));
  }
  return row;
}

function viewSessions() {
  const toolbar = el('div', { class: 'toolbar' }, [
    el('input', {
      class: 'input grow',
      id: 'filter',
      type: 'search',
      placeholder: 'Filter loaded sessions by title, preview, or path…',
      value: state.filter,
      onInput: (event) => {
        state.filter = event.target.value;
        updateRows();
      },
    }),
    el('label', { class: 'field' }, [
      el('input', {
        type: 'checkbox',
        checked: state.showAll,
        onChange: (event) => {
          state.showAll = event.target.checked;
          loadSessions();
        },
      }),
      'Show all',
    ]),
    el('label', { class: 'field' }, [
      el('input', {
        type: 'checkbox',
        checked: state.cross,
        disabled: !state.workspace,
        onChange: (event) => {
          state.cross = event.target.checked;
          loadSessions();
        },
      }),
      'Include related sources',
    ]),
  ]);

  const tbody = el('tbody');
  const table = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '#' }),
        el('th', { text: 'Session' }),
        el('th', { class: 'num', text: 'Messages' }),
        el('th', { text: 'Source' }),
        el('th', { text: 'Workspace' }),
        el('th', { class: 'num', text: 'Last updated' }),
      ]),
    ]),
    tbody,
  ]);

  function updateRows() {
    const term = state.filter.toLowerCase();
    const filtered = term
      ? state.sessions.filter((session) =>
          `${session.title ?? ''} ${session.preview ?? ''} ${session.workspacePath ?? ''}`
            .toLowerCase()
            .includes(term)
        )
      : state.sessions;
    tbody.replaceChildren(...filtered.map(sessionRow));
    statusRight(`${filtered.length} of ${state.sessions.length} session(s)`);
  }

  render(
    el('div', {}, [
      el('h1', { class: 'page-title', text: 'Sessions' }),
      el('p', {
        class: 'page-sub',
        text: `${state.workspace ? 'Scoped to one workspace.' : 'All discovered sessions, newest first.'} Click a row to open it.`,
      }),
      toolbar,
      state.sessions.length === 0
        ? el('p', {
            class: 'hint',
            text: 'No sessions matched. Try “Show all” or clear the filter.',
          })
        : table,
    ])
  );
  updateRows();
}

function viewWorkspaces() {
  const rows = state.workspaces.map((workspace) => {
    const browse = () => {
      setScope(workspace.path);
      navigate('#/sessions');
    };
    const row = el('tr', { class: workspace.addressable ? 'clickable' : 'row-ambiguous' }, [
      el('td', { class: 'path', text: workspaceLabel(workspace.path, workspace.id) }),
      el('td', { class: 'num', text: formatCount(workspace.sessionCount) }),
      el('td', {}, [
        el('button', {
          class: 'btn small',
          type: 'button',
          text: workspace.addressable ? 'Browse' : 'Not addressable',
          disabled: !workspace.addressable,
          onClick: (event) => {
            event.stopPropagation();
            browse();
          },
        }),
      ]),
    ]);
    if (workspace.addressable) row.addEventListener('click', browse);
    return row;
  });

  render(
    el('div', {}, [
      el('h1', { class: 'page-title', text: 'Workspaces' }),
      el('p', {
        class: 'page-sub',
        text: 'Every workspace Cursor has stored history for, ordered by session count. Store-only sessions report no filesystem path.',
      }),
      el('table', { class: 'table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Workspace path' }),
            el('th', { class: 'num', text: 'Sessions' }),
            el('th', { text: '' }),
          ]),
        ]),
        el('tbody', {}, rows),
      ]),
    ])
  );
  statusRight(`${state.workspaces.length} workspace(s)`);
}

function viewSearch() {
  const input = el('input', {
    class: 'input grow',
    id: 'query',
    type: 'search',
    placeholder: 'Search all message text…',
    value: state.query,
  });
  const form = el(
    'form',
    {
      class: 'toolbar',
      onSubmit: (event) => {
        event.preventDefault();
        state.query = input.value.trim();
        if (state.query) runSearch();
      },
    },
    [input, el('button', { class: 'btn primary', type: 'submit', text: 'Search' })]
  );

  const results = state.results.map((result) => {
    const snippets = result.snippets ?? [];
    const roles = [...new Set(snippets.map((snippet) => snippet.role).filter(Boolean))];
    return el(
      'div',
      {
        class: 'result',
        onClick: () => navigate(`#/session/${encodeURIComponent(result.sessionId)}`),
      },
      [
        el('div', { class: 'result-head' }, [
          el('b', { text: `#${result.index ?? '?'}` }),
          el('span', { class: 'path', text: workspaceLabel(result.workspacePath, null) }),
          el('span', { text: `${formatCount(result.matchCount)} match(es)` }),
          ...roles.map((role) => el('span', { class: 'badge', text: role })),
        ]),
        ...snippets.map((snippet) => el('div', { class: 'result-snippet' }, [highlight(snippet)])),
      ]
    );
  });

  render(
    el('div', {}, [
      el('h1', { class: 'page-title', text: 'Search' }),
      el('p', {
        class: 'page-sub',
        text: `${state.workspace ? 'Searching the selected workspace.' : 'Searching every workspace.'} Matching is case-insensitive; results link to the whole session.`,
      }),
      state.workspace
        ? null
        : el('p', {
            class: 'hint',
            text: 'A global search has to read every session, so it can take a couple of minutes the first time. Pick a workspace scope for a much faster search.',
          }),
      form,
      state.results.length === 0 && state.query
        ? el('p', { class: 'hint', text: 'No matches.' })
        : el('div', {}, results),
    ])
  );
  statusRight(state.query ? `${state.results.length} matching session(s)` : '');
}

/** Render one snippet, marking the server-reported match ranges. */
function highlight(snippet) {
  const fragment = document.createDocumentFragment();
  const text = snippet.text ?? '';
  const ranges = (snippet.matches ?? []).filter(
    ([start, end]) =>
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end <= text.length &&
      end > start
  );
  if (ranges.length === 0) {
    fragment.append(el('div', { text }));
    return fragment;
  }
  const ordered = [...ranges].sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [start, end] of ordered) {
    if (start < cursor) continue;
    if (start > cursor) fragment.append(document.createTextNode(text.slice(cursor, start)));
    fragment.append(el('mark', { text: text.slice(start, end) }));
    cursor = end;
  }
  if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
  return fragment;
}

function checkbox(label, key, onChange) {
  return el('label', { class: 'field' }, [
    el('input', {
      type: 'checkbox',
      checked: state[key],
      onChange: (event) => {
        state[key] = event.target.checked;
        onChange();
      },
    }),
    label,
  ]);
}

function viewDetail() {
  const session = state.detail;
  const messages = session.messages ?? [];
  const selectedType = (message) => [...state.only].find((type) => messageTypes(message).has(type));
  const filtered = state.only.size ? messages.filter(selectedType) : messages;

  const banner = [];
  if (Array.isArray(session.sources) && session.sources.length > 1) {
    banner.push(
      `Merged from ${session.sources.join(' + ')} (preferred: ${session.preferredSource ?? 'n/a'})`
    );
  }
  if (session.resolutionState && session.resolutionState !== 'complete') {
    banner.push(`Resolution: ${session.resolutionState}`);
  }

  const toggles = el('div', { class: 'toolbar' }, [
    el('button', {
      class: 'btn',
      type: 'button',
      text: '← Back',
      onClick: () => navigate('#/sessions'),
    }),
    ...[
      ['expandText', 'Full messages'],
      ['fullOutput', 'Full tool output'],
      ['fullThinking', 'Full reasoning'],
    ].map(([key, label]) => checkbox(label, key, viewDetail)),
    el('span', { class: 'grow' }),
    el('span', { class: 'field', text: 'Show only:' }),
    ...MESSAGE_TYPES.map((type) =>
      el('button', {
        class: 'btn small' + (state.only.has(type) ? ' primary' : ''),
        type: 'button',
        text: type,
        onClick: () => {
          if (state.only.has(type)) state.only.delete(type);
          else state.only.add(type);
          viewDetail();
        },
      })
    ),
    ...[
      ['md', 'Markdown'],
      ['json', 'JSON'],
    ].map(([format, label]) =>
      el('button', {
        class: 'btn small',
        type: 'button',
        text: label,
        onClick: () => download(session.id, format),
      })
    ),
  ]);

  const usage = session.usage;
  const meta = el('div', { class: 'meta-grid' }, [
    el('div', {}, [
      'Workspace ',
      el('b', { text: workspaceLabel(session.workspacePath, session.workspaceId) }),
    ]),
    el('div', {}, ['Messages ', el('b', { text: formatCount(session.messageCount) })]),
    el('div', {}, ['Created ', el('b', { text: formatDate(session.createdAt) })]),
    el('div', {}, ['Updated ', el('b', { text: formatDate(session.lastUpdatedAt) })]),
    el('div', {}, [
      'Source ',
      el('b', { text: String(session.resolvedSource ?? session.source ?? '—') }),
    ]),
    usage && usage.contextUsagePercent !== undefined
      ? el('div', {}, [
          'Context ',
          el('b', {
            text: `${usage.contextUsagePercent.toFixed(1)}% of ${formatCount(usage.contextTokenLimit)} tokens`,
          }),
        ])
      : null,
  ]);

  render(
    el('div', {}, [
      el('div', { class: 'detail-head' }, [
        el('h2', { text: session.title || '(untitled session)' }),
        el('p', { class: 'path', text: session.id }),
        meta,
        banner.length > 0 ? el('p', { class: 'hint', text: banner.join(' · ') }) : null,
      ]),
      toggles,
      state.only.size > 0
        ? el('p', {
            class: 'hint',
            text: `Showing ${filtered.length} of ${messages.length} message(s) matching the selected kinds.`,
          })
        : el('p', { class: 'hint', text: `${messages.length} message(s) in canonical order.` }),
      ...filtered.map((message) =>
        messageCard(message, {
          expandText: state.expandText,
          fullOutput: state.fullOutput,
          fullThinking: state.fullThinking,
          matchedType: selectedType(message),
        })
      ),
    ])
  );
  statusRight(`${filtered.length} / ${messages.length} message(s)`);
}

function viewAbout() {
  const reference = [
    {
      cmd: 'cursor-history list',
      about: 'List chat sessions, or workspaces with --workspaces.',
      options: [
        '-n, --limit <number> — maximum sessions to show (default 20)',
        '-a, --all — ignore the limit',
        '--workspaces — list workspaces and their session counts instead',
        '--ids — include composer IDs for external tooling',
        '-b, --backup <path> — read a backup archive instead of live data',
      ],
    },
    {
      cmd: 'cursor-history show <index|composer-id>',
      about: 'Show one session with full message, tool, and reasoning detail.',
      options: [
        '-s, --short — truncate user and assistant messages to 300 chars',
        '-t, --think — show full reasoning text',
        '-f, --fullread — show full tool/file-read output',
        '-e, --error — show full error messages',
        '-o, --only <types> — user,assistant,tool,thinking,error',
      ],
    },
    {
      cmd: 'cursor-history search <query>',
      about: 'Case-insensitive full-text search across sessions.',
      options: [
        '-n, --limit <number> — maximum matches',
        '--context <chars> — snippet context width',
      ],
    },
    {
      cmd: 'cursor-history export [index]',
      about: 'Export one session, or every session, as Markdown or JSON.',
      options: [
        '--all — export every session',
        '-f, --format md|json',
        '-o, --output <path>',
        '--force',
      ],
    },
    {
      cmd: 'cursor-history migrate <source> <dest>',
      about: 'Move or copy every session between workspaces, rewriting stored file paths.',
      options: [
        '--copy — keep the originals',
        '--dry-run — preview only',
        '-f, --force',
        '--debug',
      ],
    },
    {
      cmd: 'cursor-history migrate-session <session> <dest>',
      about: 'Move or copy one session (or a comma-separated set).',
      options: ['--copy', '--dry-run', '-f, --force', '--debug'],
    },
    {
      cmd: 'cursor-history backup',
      about: 'Create a verified zip archive of Cursor history.',
      options: ['--output <path>', '--force', '--shared — request shared file permissions'],
    },
    {
      cmd: 'cursor-history restore <archive>',
      about: 'Restore a backup archive, verifying checksums first.',
      options: ['--target <path>', '--force'],
    },
    {
      cmd: 'cursor-history list-backups',
      about: 'List known backup archives with manifest metadata.',
      options: ['--directory <path>'],
    },
    {
      cmd: 'cursor-history ui',
      about: 'Serve this read-only web app locally and open it in a browser.',
      options: [
        '-p, --port <number> — port to bind (default 4700)',
        '--host <host> — interface to bind (defaults to loopback only)',
        '--no-open — do not open a browser window',
        '-b, --backup <path> — read a backup archive instead of live data',
      ],
    },
  ];

  render(
    el('div', {}, [
      el('h1', { class: 'page-title', text: 'Commands & options' }),
      el('p', {
        class: 'page-sub',
        text: 'Everything the CLI can do, and the global options that apply to every command.',
      }),
      el('div', { class: 'ref' }, [
        el('h3', { text: 'Global options' }),
        el('ul', {}, [
          el('li', {}, [
            el('code', { class: 'cmd', text: '--json' }),
            ' — structured output on stdout, fatal JSON on stderr',
          ]),
          el('li', {}, [
            el('code', { class: 'cmd', text: '--data-path <path>' }),
            ' — read one custom Cursor workspaceStorage source',
          ]),
          el('li', {}, [
            el('code', { class: 'cmd', text: '-w, --workspace <path>' }),
            ' — exact-first workspace scope for reads and addressing',
          ]),
          el('li', {}, [
            el('code', { class: 'cmd', text: '--include-cross-workspace-sources' }),
            ' — include related sources for UUIDs already selected in scope',
          ]),
          el('li', {}, [
            el('code', { class: 'cmd', text: '--source-limit <field=value>' }),
            ' — raise one bounded read limit for this operation',
          ]),
        ]),
      ]),
      ...reference.map((entry) =>
        el('div', { class: 'ref' }, [
          el('h3', {}, [el('code', { class: 'cmd', text: entry.cmd })]),
          el('p', { class: 'hint', text: entry.about }),
          el(
            'ul',
            {},
            entry.options.map((option) => el('li', { text: option }))
          ),
        ])
      ),
      el('div', { class: 'ref' }, [
        el('h3', { text: 'This window' }),
        el('ul', {}, [
          el('li', {
            text: 'Runs a read-only local server bound to loopback; it never writes to your history.',
          }),
          el('li', { text: 'Reuses cached reads, so repeat navigation is fast.' }),
          el('li', {
            text: 'Ships no third-party front-end dependencies and renders all history as plain text.',
          }),
        ]),
      ]),
    ])
  );
}

/* ------------------------------------------------------------- navigation */

function navigate(hash) {
  if (window.location.hash === hash) route();
  else window.location.hash = hash;
}

let viewRequest = 0;

function route({ refresh = false } = {}) {
  const request = ++viewRequest;
  const hash = window.location.hash || '#/sessions';
  const [, name = 'sessions', arg = ''] = hash.match(/^#\/([^/]*)\/?(.*)$/u) ?? [];
  state.route = name;

  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.route === name);
  }

  if (name === 'workspaces') {
    ensureWorkspaces(refresh)
      .then(() => {
        if (request === viewRequest) viewWorkspaces();
      })
      .catch((error) => {
        if (request === viewRequest) showFailure(error);
      });
    return;
  }
  if (name === 'search') {
    if (refresh && state.query) runSearch(true);
    else viewSearch();
    return;
  }
  if (name === 'about') {
    viewAbout();
    return;
  }
  if (name === 'session') {
    loadDetail(decodeURIComponent(arg), refresh);
    return;
  }
  loadSessions(refresh);
}

function showFailure(error) {
  if (error.scope) {
    renderError('Not in this workspace', error.message, () => {
      setScope('');
      route();
    });
    return;
  }
  if (error.offline) {
    renderError('The local server is not running', error.message, () => {
      window.location.reload();
    });
    statusLeft('Server offline');
    return;
  }
  renderError('Something went wrong', error.message, () => route());
  statusLeft('Error');
}

async function ensureWorkspaces(refresh = false) {
  if (!refresh && state.workspaces.length > 0) return;
  const body = await api('/api/workspaces', { refresh: refresh ? 1 : undefined });
  state.workspaces = body.workspaces ?? [];
  populateScope();
}

/** Only the latest navigation may render; late results cannot replace another scope. */
async function loadView(path, params, label, apply) {
  const request = ++viewRequest;
  renderLoading(`${label}…`);
  statusLeft(`${label}…`);
  const started = performance.now();
  try {
    const body = await api(path, params);
    if (request !== viewRequest) return;
    apply(body);
    statusLeft(`${label} finished in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    if (request === viewRequest) showFailure(error);
  }
}

function loadSessions(refresh = false) {
  return loadView(
    '/api/sessions',
    {
      workspace: state.workspace,
      limit: 200,
      all: state.showAll ? 1 : undefined,
      cross: state.cross ? 1 : undefined,
      refresh: refresh ? 1 : undefined,
    },
    'Reading sessions',
    (body) => {
      state.sessions = body.sessions ?? [];
      viewSessions();
    }
  );
}

function loadDetail(id, refresh = false) {
  return loadView(
    '/api/session',
    {
      id,
      workspace: state.workspace,
      refresh: refresh ? 1 : undefined,
    },
    'Reading session',
    (session) => {
      state.detail = session;
      viewDetail();
    }
  );
}

function runSearch(refresh = false) {
  return loadView(
    '/api/search',
    {
      q: state.query,
      workspace: state.workspace,
      limit: 200,
      refresh: refresh ? 1 : undefined,
    },
    'Searching',
    (body) => {
      state.results = body.results ?? [];
      viewSearch();
    }
  );
}

function download(id, format) {
  const url = new URL('/api/export', window.location.origin);
  url.searchParams.set('id', id);
  url.searchParams.set('format', format);
  if (state.workspace) url.searchParams.set('workspace', state.workspace);
  const link = el('a', { href: url.toString(), download: '' });
  document.body.append(link);
  link.click();
  link.remove();
}

function populateScope() {
  const select = document.getElementById('scope');
  const options = [
    el('option', { value: '', text: 'All workspaces (global)' }),
    ...state.workspaces.map((workspace) =>
      el('option', {
        value: workspace.addressable ? workspace.path : '',
        text: `${workspace.path ?? '(no path — Store only)'}  ·  ${workspace.sessionCount}`,
        disabled: !workspace.addressable,
      })
    ),
  ];
  select.replaceChildren(...options);
  select.value = state.workspace;
}

function setScope(workspace) {
  viewRequest += 1;
  state.workspace = workspace;
  state.sessions = [];
  state.detail = null;
  state.results = [];
  if (!workspace) state.cross = false;
  const select = document.getElementById('scope');
  if (select) select.value = workspace;
  statusLeft(workspace ? `Scoped to ${workspace}` : 'Global scope');
}

async function bootstrap() {
  populateScope();
  try {
    const status = await api('/api/status');
    document.getElementById('app-version').textContent = `v${status.version}`;
    document.getElementById('data-source').textContent = status.backupPath
      ? `backup: ${status.backupPath}`
      : status.dataPath
        ? `data: ${status.dataPath}`
        : 'default Cursor data path';
  } catch (error) {
    document.getElementById('data-source').textContent = 'unavailable';
    showFailure(error);
    return;
  }

  try {
    await ensureWorkspaces();
  } catch {
    /* Workspace discovery is optional for the session list. */
  }
  route();
}

document.getElementById('refresh').addEventListener('click', () => {
  state.workspaces = [];
  state.detail = null;
  state.results = [];
  ensureWorkspaces(true).catch(() => undefined);
  route({ refresh: true });
});
document.getElementById('scope').addEventListener('change', (event) => {
  setScope(event.target.value);
  if (state.route === 'search' && state.query) runSearch();
  else navigate('#/sessions');
});
for (const item of document.querySelectorAll('.nav-item')) {
  item.addEventListener('click', () => navigate(`#/${item.dataset.route}`));
}
window.addEventListener('hashchange', route);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.route === 'session') navigate('#/sessions');
  if (
    event.key === '/' &&
    !/^(INPUT|TEXTAREA|SELECT)$/u.test(document.activeElement?.tagName ?? '')
  ) {
    event.preventDefault();
    document.querySelector('#filter, #query')?.focus();
  }
});

bootstrap();
