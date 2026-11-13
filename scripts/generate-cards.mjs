#!/usr/bin/env node
/**
 * Profile cards for github.com/bishop9910 — terminal edition.
 *
 * Every card is a self-contained SVG: no third-party card service, no image
 * CDN, no JavaScript at runtime. Animation is CSS keyframes plus a little
 * SMIL, which keeps playing inside an <img> tag on the GitHub profile page.
 *
 * Outputs (committed, refreshed daily by .github/workflows/profile-cards.yml):
 *   assets/terminal.svg   — animated hero: typing session + neofetch panel
 *   assets/stats.svg      — totals as a CLI table with dot leaders
 *   assets/top-langs.svg  — language shares as filled progress bars
 *   assets/heatmap.svg    — 52-week contribution grid, swept in
 *   assets/recent.svg     — most recently pushed repositories
 *
 * Data: GitHub REST (public) + GraphQL (contribution calendar). A token is
 * optional for REST, mandatory for the contribution numbers; Actions always
 * supplies secrets.GITHUB_TOKEN.
 *
 * Local usage:
 *   node scripts/generate-cards.mjs
 *   GITHUB_TOKEN=ghp_xxx node scripts/generate-cards.mjs
 *   CARDS_DEMO=1 CARDS_OUT=.preview/assets node scripts/generate-cards.mjs
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOGIN = process.env.GH_LOGIN || 'bishop9910';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const DEMO = process.env.CARDS_DEMO === '1' || process.argv.includes('--demo');
const API = 'https://api.github.com';
const OUT_DIR = path.resolve(process.cwd(), process.env.CARDS_OUT || 'assets');
const CACHE_FILE = path.resolve(process.cwd(), '.cache/github.json');

/* ------------------------------------------------------------------ theme */

const C = {
  win: '#12121b',
  border: '#2b2b3d',
  hair: '#20202e',
  text: '#d7dcea',
  dim: '#7d8698',
  comment: '#5b6274',
  pink: '#ff79c6',
  violet: '#bd93f9',
  cyan: '#8be9fd',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  red: '#ff5555',
  track: '#232331',
};

const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

const FS = 12.5;
const CW = FS * 0.6; // monospace advance estimate
const LH = 19;

/* -------------------------------------------------------------- utilities */

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const pad = (s, n) => (String(s).length >= n ? String(s) : s + ' '.repeat(n - String(s).length));

const STAMP = new Date().toISOString().slice(0, 10);

function shortBytes(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function ago(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const days = Math.max(0, Math.round((Date.now() - then) / 86400000));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

/* --------------------------------------------------------------- fetching */

async function rest(endpoint) {
  const res = await fetch(API + endpoint, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'bishop9910-profile-cards',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GET ${endpoint} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function graphql(query, variables) {
  if (!TOKEN) return null;
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'bishop9910-profile-cards',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL -> ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors[0].message}`);
  return body.data;
}

async function collectLive() {
  const user = await rest(`/users/${LOGIN}`);

  const repos = [];
  for (let page = 1; page <= 3; page += 1) {
    const chunk = await rest(`/users/${LOGIN}/repos?per_page=100&page=${page}&type=owner&sort=pushed`);
    repos.push(...chunk);
    if (chunk.length < 100) break;
  }
  const own = repos.filter((r) => !r.fork);

  // Languages by bytes over the 20 most substantial repositories, so a pile of
  // scratch repos cannot skew the ranking.
  const langTotals = {};
  for (const repo of [...own].sort((a, b) => b.size - a.size).slice(0, 20)) {
    try {
      const langs = await rest(`/repos/${repo.full_name}/languages`);
      for (const [name, bytes] of Object.entries(langs)) {
        langTotals[name] = (langTotals[name] || 0) + bytes;
      }
    } catch (err) {
      console.warn(`skip ${repo.full_name}: ${err.message}`);
    }
  }

  let activity = null;
  let weeks = null;
  try {
    const data = await graphql(
      `query ($login: String!) {
        user(login: $login) {
          contributionsCollection {
            totalCommitContributions
            totalPullRequestContributions
            totalIssueContributions
            contributionCalendar {
              totalContributions
              weeks { contributionDays { date contributionCount } }
            }
          }
        }
      }`,
      { login: LOGIN },
    );
    const c = data?.user?.contributionsCollection;
    if (c) {
      activity = {
        commits: c.totalCommitContributions,
        prs: c.totalPullRequestContributions,
        issues: c.totalIssueContributions,
        contributions: c.contributionCalendar?.totalContributions ?? null,
      };
      weeks = c.contributionCalendar?.weeks?.map((w) =>
        w.contributionDays.map((day) => ({ date: day.date, count: day.contributionCount })),
      );
    }
  } catch (err) {
    console.warn(`contribution graph unavailable: ${err.message}`);
  }

  const stars = own.reduce((sum, r) => sum + r.stargazers_count, 0);
  const recent = [...own]
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, 6)
    .map((r) => ({
      name: r.name,
      lang: r.language,
      stars: r.stargazers_count,
      pushed: r.pushed_at,
    }));

  return {
    login: LOGIN,
    followers: user.followers,
    repos: own.length,
    stars,
    activity,
    weeks,
    langTotals,
    recent,
    sample: false,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------- demo */

function demoData() {
  const now = Date.now();
  const weeks = [];
  let seed = 9910;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let w = 0; w < 52; w += 1) {
    const days = [];
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(now - (51 - w) * 7 * 86400000 + d * 86400000);
      const r = rnd();
      const count = r > 0.55 ? Math.floor(rnd() * 12) : r > 0.3 ? Math.floor(rnd() * 3) : 0;
      days.push({ date: date.toISOString().slice(0, 10), count });
    }
    weeks.push(days);
  }
  return {
    login: LOGIN,
    followers: 6,
    repos: 17,
    stars: 21,
    activity: { commits: 412, prs: 23, issues: 17, contributions: 486 },
    weeks,
    langTotals: {
      Vue: 1361000,
      Go: 1126000,
      TypeScript: 931000,
      Python: 620000,
      Dart: 468000,
      'C++': 261000,
      HTML: 122000,
      Stylus: 61000,
      Shell: 22000,
    },
    recent: [
      { name: 'koharu-frontend', lang: 'Vue', stars: 4, pushed: new Date(now - 2 * 86400000).toISOString() },
      { name: 'bs9p', lang: 'C++', stars: 2, pushed: new Date(now - 5 * 86400000).toISOString() },
      { name: 'bs-blog', lang: 'TypeScript', stars: 3, pushed: new Date(now - 9 * 86400000).toISOString() },
      { name: 'bishop9910', lang: 'JavaScript', stars: 1, pushed: new Date(now - 16 * 86400000).toISOString() },
      { name: 'gatenet', lang: 'Python', stars: 6, pushed: new Date(now - 34 * 86400000).toISOString() },
      { name: 'vimrc', lang: 'Shell', stars: 0, pushed: new Date(now - 90 * 86400000).toISOString() },
    ],
    sample: true,
    generatedAt: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------------- drawing */

const LANG_COLOR = {
  Vue: '#41b883',
  Go: '#00add8',
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572a5',
  Dart: '#00b4ab',
  'C++': '#f34b7d',
  C: '#8e8e8e',
  Rust: '#dea584',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Shell: '#89e051',
  Java: '#b07219',
  Kotlin: '#a97bff',
  Swift: '#f05138',
  'C#': '#178600',
  Lua: '#5b6ee1',
  Stylus: '#ff6347',
  Dockerfile: '#384d54',
  Nix: '#7e7eff',
  Makefile: '#427819',
};

const langColor = (name) => LANG_COLOR[name] || C.violet;

/** Monospace text run: [{t, fill, weight}] laid out left to right. */
function tokens(x, y, parts, opts = {}) {
  let cursor = x;
  let out = '';
  for (const part of parts) {
    const fill = part.fill || opts.fill || C.text;
    const weight = part.weight ? ` font-weight="${part.weight}"` : opts.weight ? ` font-weight="${opts.weight}"` : '';
    const size = opts.size ? ` font-size="${opts.size}"` : '';
    out += `<text x="${cursor.toFixed(1)}" y="${y}" fill="${fill}"${weight}${size}>${esc(part.t)}</text>`;
    cursor += part.t.length * (opts.cw || CW);
  }
  return out;
}

/** Flowing text: one <text> with tspans, so glyph advance never has to be guessed. */
function flow(x, y, parts) {
  const spans = parts
    .map((p) => {
      const weight = p.weight ? ` font-weight="${p.weight}"` : '';
      const cls = p.cls ? ` class="${p.cls}"` : '';
      return `<tspan fill="${p.fill || C.text}"${weight}${cls}>${esc(p.t)}</tspan>`;
    })
    .join('');
  return `<text x="${x}" y="${y}" xml:space="preserve">${spans}</text>`;
}

/** Animated wrapper: cls is "t" (type in), "f" (fade up). */
const g = (cls, delay, inner) =>
  `<g class="${cls}" style="animation-delay:${Number(delay).toFixed(2)}s">${inner}</g>`;

function frame(width, height, title, body) {
  const dots =
    `<circle cx="18" cy="15" r="4.5" fill="${C.red}" opacity="0.8"/>` +
    `<circle cx="34" cy="15" r="4.5" fill="${C.yellow}" opacity="0.8"/>` +
    `<circle cx="50" cy="15" r="4.5" fill="${C.green}" opacity="0.8"/>`;
  return `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${C.win}" stroke="${C.border}"/>
  <path d="M0.5 30 H${width - 0.5}" stroke="${C.hair}"/>
  ${dots}<text x="${width / 2}" y="19" text-anchor="middle" fill="${C.comment}" font-size="10.5">${esc(
    title,
  )}</text>
  ${body}`;
}

const CSS = `
  text { font-family: ${MONO}; font-size: ${FS}px; }
  /* Content stays visible by default; the animations only build up from a
     hidden start frame, so a renderer that ignores CSS still shows the text. */
  .t { animation: type .55s steps(32, end) both; }
  .f { animation: fade .5s ease-out both; }
  .b { animation: blink 1.1s steps(1) infinite; }
  @keyframes type { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .t, .f, .b { animation: none !important; } }
`;

function doc(width, height, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    title,
  )}">
  <title>${esc(title)}</title>
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${C.pink}"/>
      <stop offset="55%" stop-color="${C.violet}"/>
      <stop offset="100%" stop-color="${C.cyan}"/>
    </linearGradient>
    <linearGradient id="art" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${C.pink}"/>
      <stop offset="100%" stop-color="${C.violet}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0" r="1.1">
      <stop offset="0%" stop-color="${C.pink}" stop-opacity="0.10"/>
      <stop offset="55%" stop-color="${C.violet}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="1" fill="#ffffff" opacity="0.03"/>
    </pattern>
    <style>${CSS}</style>
  </defs>
  ${body}
</svg>
`;
}

/* --------------------------------------------------------------- hero card */

const ART = ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝', '╚═════╝ '];

const PIX = ['1111', '1..1', '1..1', '1111', '1..1', '1..1', '1111'];

function heroCard(d) {
  const W = 780;
  const H = 342;
  const x0 = 24;
  const y0 = 56;

  const prompt = (cmd) => [
    { t: 'bishop9910@github', fill: C.pink },
    { t: ':', fill: C.dim },
    { t: '~', fill: C.cyan },
    { t: '$ ', fill: C.violet },
    { t: cmd, fill: C.text },
  ];

  const lines = [];
  let y = y0;
  let delay = 0.1;

  const typed = (parts) => {
    lines.push(g('t', delay, flow(x0, y, parts)));
    y += LH;
    delay += 0.62;
  };
  const out = (parts, step = 0.16) => {
    lines.push(g('f', delay, flow(x0, y, parts)));
    y += LH;
    delay += step;
  };

  typed(prompt('whoami'));
  out([{ t: '  bishop9910', fill: C.pink, weight: 600 }]);
  typed(prompt('cat about.md'));
  out([{ t: '  Student · anime · coding · galgame', fill: C.text }]);
  out([{ t: '  "Building things with fun("', fill: C.dim }]);
  out([{ t: '  # still compiling a few half-finished ideas', fill: C.comment }]);
  typed(prompt('neofetch --off'));

  const info = [
    ['OS', 'Windows 11 · Arch', 'Github', '@bishop9910'],
    ['Shell', 'pwsh · zsh', 'Followers', String(d.followers)],
    ['Langs', 'TypeScript · Go · Vue', 'Timezone', 'UTC+8'],
    ['Editor', 'VS Code · nvim', 'Uptime', '24 years'],
    ['Repos', `${d.repos} · ★ ${d.stars}`, 'Theme', 'pink · violet'],
    ['Contact', 'bishop9910@163.com', 'Status', 'always compiling'],
  ];

  // Pixel monogram, drawn as rects so it never depends on font glyph coverage.
  const cell = 12;
  const artX = x0 + 12;
  const artTop = y + (info.length * LH - PIX.length * cell) / 2;
  for (let r = 0; r < PIX.length; r += 1) {
    for (let c = 0; c < PIX[r].length; c += 1) {
      if (PIX[r][c] !== '1') continue;
      lines.push(
        `<rect x="${artX + c * cell}" y="${artTop + r * cell}" width="${cell - 2}" height="${cell - 2}" rx="2.5" fill="url(#art)" class="f" style="animation-delay:${(delay + r * 0.05).toFixed(2)}s"/>`,
      );
    }
  }

  const infoX = artX + PIX[0].length * cell + 34;
  const colB = 470;
  info.forEach(([k, v, k2, v2]) => {
    lines.push(
      g(
        'f',
        delay,
        `<text x="${infoX}" y="${y}" fill="${C.cyan}">${esc(k)}</text>` +
          `<text x="${infoX + 84}" y="${y}" fill="${C.dim}">${esc(v)}</text>` +
          `<text x="${colB}" y="${y}" fill="${C.cyan}">${esc(k2)}</text>` +
          `<text x="${colB + 84}" y="${y}" fill="${C.dim}">${esc(v2)}</text>`,
      ),
    );
    y += LH;
    delay += 0.1;
  });

  lines.push(
    g(
      'f',
      delay,
      flow(x0, y, [
        { t: 'bishop9910@github', fill: C.pink },
        { t: ':', fill: C.dim },
        { t: '~', fill: C.cyan },
        { t: '$ ', fill: C.violet },
        { t: '▊', fill: C.pink, cls: 'b' },
      ]),
    ),
  );

  const body = frame(
    W,
    H,
    `${d.login}@github — zsh — 96×24`,
    `<g clip-path="url(#heroClip)">
    <rect x="0" y="30" width="${W}" height="${H - 30}" fill="url(#glow)"/>
    ${lines.join('\n    ')}
  </g>
  <rect x="0" y="30" width="${W}" height="${H - 30}" fill="url(#scan)" opacity="0.45"/>
  <clipPath id="heroClip"><rect x="0" y="30" width="${W}" height="${H - 30}"/></clipPath>
  <rect x="0.5" y="0.5" width="${W - 1}" height="1.5" fill="url(#accent)" opacity="0.5"/>`,
  );

  return doc(W, H, `${d.login} terminal`, body);
}
/* -------------------------------------------------------------- stats card */

function statsCard(d) {
  const W = 404;
  const H = 250;
  const x0 = 22;
  const y0 = 54;

  const a = d.activity;
  const rows = [
    ['total stars', d.stars],
    ['public repos', d.repos],
    ['commits / year', a ? a.commits : 'n/a'],
    ['contributions', a ? a.contributions : 'n/a'],
    ['pull requests', a ? a.prs : 'n/a'],
    ['followers', d.followers],
  ];

  let out = g('t', 0.1, tokens(x0, y0, [{ t: '~$ ', fill: C.violet }, { t: 'gh stats', fill: C.text }]));

  const labelX = x0 + 2 * CW;
  const valueX = W - 22;
  let y = y0 + 30;
  rows.forEach((row, i) => {
    const delay = 0.3 + i * 0.12;
    const label = row[0];
    const leaderStart = labelX + label.length * CW + 8;
    const leaderEnd = valueX - 46;
    const dots = '·'.repeat(Math.max(2, Math.floor((leaderEnd - leaderStart) / CW)));
    out += g(
      'f',
      delay,
      `<text x="${labelX}" y="${y}" fill="${C.dim}">${esc(label)}</text>` +
        `<text x="${leaderStart.toFixed(1)}" y="${y}" fill="${C.hair}" letter-spacing="1.2">${esc(dots)}</text>` +
        `<text x="${valueX}" y="${y}" text-anchor="end" fill="${C.pink}" font-weight="600">${esc(String(row[1]))}</text>`,
    );
    y += 25;
  });

  out += `<text x="${x0}" y="${H - 16}" fill="${C.comment}" font-size="10.5"># updated ${STAMP}${d.sample ? ' · sample' : ''}</text>`;

  return doc(W, H, 'GitHub stats', frame(W, H, `${d.login}@github — stats`, out));
}

/* --------------------------------------------------------------- langs card */

function langsCard(d) {
  const W = 404;
  const H = 250;
  const x0 = 22;
  const y0 = 54;

  const total = Object.values(d.langTotals).reduce((s, n) => s + n, 0) || 1;
  const ranked = Object.entries(d.langTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  let out = g('t', 0.1, tokens(x0, y0, [{ t: '~$ ', fill: C.violet }, { t: 'gh langs --top 6', fill: C.text }]));

  const nameX = x0 + 2 * CW;
  const barX = nameX + 13 * CW;
  const barW = 196;
  const pctX = W - 22;

  let y = y0 + 30;
  ranked.forEach(([name, bytes], i) => {
    const pct = (bytes / total) * 100;
    const delay = 0.3 + i * 0.13;
    const barW2 = ((barW * pct) / 100).toFixed(1);
    const fill = langColor(name);
    out += g(
      'f',
      delay,
      `<text x="${nameX}" y="${y}" fill="${fill}">${esc(pad(name, 12))}</text>` +
        `<rect x="${barX}" y="${y - 7.5}" width="${barW}" height="6" rx="3" fill="${C.track}"/>` +
        `<rect x="${barX}" y="${y - 7.5}" width="${barW2}" height="6" rx="3" fill="${fill}" opacity="0.92"><animate attributeName="width" from="0" to="${barW2}" dur="0.9s" begin="${(delay + 0.12).toFixed(2)}s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.2 1" keyTimes="0;1"/></rect>` +
        `<text x="${pctX}" y="${y}" text-anchor="end" fill="${C.text}" font-size="11">${pct.toFixed(1)}%</text>`,
    );
    y += 25;
  });

  out += `<text x="${x0}" y="${H - 16}" fill="${C.comment}" font-size="10.5"># share of ${shortBytes(
    total,
  )} bytes · ${STAMP}${d.sample ? ' · sample' : ''}</text>`;

  return doc(W, H, 'Top languages', frame(W, H, `${d.login}@github — langs`, out));
}

/* ------------------------------------------------------------- heatmap card */

function heatmapCard(d) {
  const W = 812;
  const H = 210;
  const x0 = 24;
  const cmdY = 54;

  let out = g('t', 0.1, tokens(x0, cmdY, [{ t: '~$ ', fill: C.violet }, { t: 'gh contributions --weeks 52', fill: C.text }]));

  const weeks = d.weeks || [];
  const cols = weeks.length;
  const cell = 11;
  const gap = 3;
  const gridX = x0 + 36;
  const gridY = 76;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let lastMonth = -1;
  for (let w = 0; w < cols; w += 1) {
    const first = weeks[w][0];
    if (!first) continue;
    const month = new Date(first.date).getUTCMonth();
    if (month !== lastMonth) {
      lastMonth = month;
      out += `<text x="${gridX + w * (cell + gap)}" y="${gridY - 8}" fill="${C.comment}" font-size="9.5">${
        months[month]
      }</text>`;
    }
  }

  ['Mon', 'Wed', 'Fri'].forEach((label, i) => {
    out += `<text x="${x0}" y="${gridY + (i * 2 + 1) * (cell + gap) + cell - 3}" fill="${C.comment}" font-size="9.5">${label}</text>`;
  });

  const ramp = ['#1c1c28', '#4a2740', '#8a3c6f', '#cf5fa3', C.pink];
  const level = (n) => (n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4);

  let cells = '';
  for (let w = 0; w < cols; w += 1) {
    for (let day = 0; day < 7; day += 1) {
      const entry = weeks[w][day];
      if (!entry) continue;
      cells += `<rect x="${gridX + w * (cell + gap)}" y="${gridY + day * (cell + gap)}" width="${cell}" height="${cell}" rx="2.5" fill="${
        ramp[level(entry.count)]
      }"><title>${entry.date}: ${entry.count}</title></rect>`;
    }
  }

  const gridW = cols * (cell + gap);
  out += `<mask id="sweepMask"><rect x="${gridX}" y="${gridY - 2}" width="${gridW}" height="${
    7 * (cell + gap)
  }" fill="#fff"><animate attributeName="width" from="0" to="${gridW}" dur="1.2s" begin="0.45s" fill="freeze" calcMode="spline" keySplines="0.25 0.8 0.25 1" keyTimes="0;1"/></rect></mask>`;
  out += `<g mask="url(#sweepMask)">${cells}</g>`;

  if (!cols) {
    out += `<text x="${gridX}" y="${gridY + 60}" fill="${C.comment}" font-size="11">no contribution data — run inside GitHub Actions</text>`;
  }

  const ly = H - 16;
  for (let i = 0; i < ramp.length; i += 1) {
    out += `<rect x="${W - 24 - 92 + i * 14}" y="${ly - 9}" width="10" height="10" rx="2.5" fill="${ramp[i]}"/>`;
  }
  out += `<text x="${W - 24 - 110}" y="${ly}" text-anchor="end" fill="${C.comment}" font-size="9.5">less</text>`;
  out += `<text x="${W - 24 - 10}" y="${ly}" fill="${C.comment}" font-size="9.5">more</text>`;
  out += `<text x="${x0}" y="${ly}" fill="${C.comment}" font-size="10.5"># ${
    d.activity ? d.activity.contributions : '—'
  } contributions in the last year · ${STAMP}${d.sample ? ' · sample' : ''}</text>`;

  return doc(W, H, 'Contribution graph', frame(W, H, `${d.login}@github — contributions`, out));
}

/* -------------------------------------------------------------- repos card */

function reposCard(d) {
  const W = 812;
  const H = 252;
  const x0 = 24;
  const y0 = 54;

  let out = g('t', 0.1, tokens(x0, y0, [{ t: '~$ ', fill: C.violet }, { t: 'gh repos --sort pushed --limit 6', fill: C.text }]));

  const rows = (d.recent || []).slice(0, 6);
  const nameX = x0 + 2 * CW;
  const langX = 264;
  const starX = 470;
  const timeX = W - 24;

  let y = y0 + 30;
  rows.forEach((repo, i) => {
    const delay = 0.28 + i * 0.1;
    const name = repo.name.length > 26 ? `${repo.name.slice(0, 25)}…` : repo.name;
    let row = `<text x="${nameX}" y="${y}" fill="${C.pink}">▸ ${esc(pad(name, 26))}</text>`;
    if (repo.lang) {
      row += `<circle cx="${langX}" cy="${y - 4}" r="4" fill="${langColor(repo.lang)}"/>`;
      row += `<text x="${langX + 12}" y="${y}" fill="${C.dim}">${esc(pad(repo.lang.slice(0, 12), 14))}</text>`;
    }
    row += `<text x="${starX}" y="${y}" fill="${C.yellow}">★ ${repo.stars}</text>`;
    row += `<text x="${timeX}" y="${y}" text-anchor="end" fill="${C.comment}">${esc(ago(repo.pushed))}</text>`;
    out += g('f', delay, row);
    y += 26;
  });

  if (!rows.length) {
    out += `<text x="${nameX}" y="${y}" fill="${C.comment}" font-size="11">no public repositories yet</text>`;
  }

  out += `<text x="${x0}" y="${H - 16}" fill="${C.comment}" font-size="10.5"># ${rows.length} of ${d.repos} public repos · ${STAMP}${d.sample ? ' · sample' : ''}</text>`;

  return doc(W, H, 'Recent repositories', frame(W, H, `${d.login}@github — repos`, out));
}

/* ------------------------------------------------------------------ write */

async function writeCard(name, svg) {
  await writeFile(path.join(OUT_DIR, name), `${svg.trimEnd()}\n`, 'utf8');
}

async function loadData() {
  if (DEMO) {
    console.log('demo data');
    return demoData();
  }
  try {
    const live = await collectLive();
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(live), 'utf8');
    return live;
  } catch (err) {
    console.warn(`live fetch failed (${err.message}); trying cache`);
    try {
      const cached = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
      console.log(`cache from ${cached.generatedAt}`);
      return cached;
    } catch {
      console.warn('no cache; falling back to demo data');
      return demoData();
    }
  }
}

async function main() {
  const data = await loadData();
  await mkdir(OUT_DIR, { recursive: true });
  await writeCard('terminal.svg', heroCard(data));
  await writeCard('stats.svg', statsCard(data));
  await writeCard('top-langs.svg', langsCard(data));
  await writeCard('heatmap.svg', heatmapCard(data));
  await writeCard('recent.svg', reposCard(data));
  console.log(
    `wrote 5 cards to ${path.relative(process.cwd(), OUT_DIR) || '.'} — ${data.repos} repos · ${data.stars} stars · ` +
      (data.activity ? `${data.activity.contributions} contributions` : 'contributions n/a'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
