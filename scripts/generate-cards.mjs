#!/usr/bin/env node
/**
 * Generate the two profile cards used by README.md:
 *   assets/stats.svg      — totals / activity summary
 *   assets/top-langs.svg  — language breakdown
 *
 * Data comes straight from the GitHub REST API (plus GraphQL for the
 * contribution counters when a token is available).  The workflow
 * .github/workflows/profile-cards.yml runs this script daily, commits the
 * refreshed SVGs, and the README references them with a relative path — so
 * the profile never depends on a third-party card service again.
 *
 * Local usage:  GITHUB_TOKEN=ghp_xxx node scripts/generate-cards.mjs
 * Without a token it still works, but the contribution numbers fall back to
 * "n/a" because GraphQL requires authentication.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOGIN = process.env.GH_LOGIN || 'bishop9910';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const API = 'https://api.github.com';
const OUT_DIR = path.resolve(process.cwd(), 'assets');

/* ------------------------------------------------------------------ theme */

const T = {
  bgTop: '#1d1626',
  bgBottom: '#0d0b12',
  border: '#3b3244',
  title: '#f0f6fc',
  text: '#e6edf3',
  dim: '#8b949e',
  faint: '#6e7681',
  line: '#21262d',
  track: '#21262d',
  pink: '#ff79c6',
  pinkSoft: '#ffb3d9',
  violet: '#c792ea',
};

const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif";

/* -------------------------------------------------------------- fetch data */

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

async function collect() {
  const user = await rest(`/users/${LOGIN}`);

  const repos = [];
  for (let page = 1; page <= 4; page += 1) {
    const chunk = await rest(`/users/${LOGIN}/repos?per_page=100&page=${page}&type=owner&sort=pushed`);
    repos.push(...chunk);
    if (chunk.length < 100) break;
  }
  const own = repos.filter((r) => !r.fork);
  const stars = own.reduce((sum, r) => sum + r.stargazers_count, 0);

  // Languages by bytes.  Repos are queried from the most substantial ones
  // down so a pile of tiny scratch repos cannot skew the ranking.
  const bySize = [...own].sort((a, b) => b.size - a.size).slice(0, 20);
  const langBytes = new Map();
  for (const repo of bySize) {
    try {
      const langs = await rest(`/repos/${repo.full_name}/languages`);
      for (const [name, bytes] of Object.entries(langs)) {
        langBytes.set(name, (langBytes.get(name) || 0) + bytes);
      }
    } catch (err) {
      console.warn(`skip ${repo.full_name}: ${err.message}`);
    }
  }

  let activity = null;
  try {
    const data = await graphql(
      `query ($login: String!) {
        user(login: $login) {
          contributionsCollection {
            totalCommitContributions
            totalPullRequestContributions
            totalIssueContributions
            totalRepositoriesWithContributedCommits
            contributionCalendar { totalContributions }
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
        contributedRepos: c.totalRepositoriesWithContributedCommits,
        contributions: c.contributionCalendar.totalContributions,
      };
    }
  } catch (err) {
    console.warn(`contributions unavailable: ${err.message}`);
  }

  return { user, repoCount: own.length, stars, activity, langBytes };
}

/* ----------------------------------------------------------------- helpers */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const num = (n) => (n == null ? 'n/a' : n.toLocaleString('en-US'));

const STAMP = new Date().toISOString().slice(0, 10);

/* Language colours follow GitHub's linguist palette; unknown languages fall
 * back to a rotating slice of the pink/violet accent range. */
const LANG_COLORS = {
  Vue: '#41b883',
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  'C++': '#f34b7d',
  C: '#555555',
  Python: '#3572a5',
  Go: '#00add8',
  Dart: '#00b4ab',
  Rust: '#dea584',
  Java: '#b07219',
  Kotlin: '#a97bff',
  'C#': '#178600',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Shell: '#89e051',
  PowerShell: '#012456',
  Dockerfile: '#384d54',
  Makefile: '#427819',
  Nix: '#7e7eff',
  'Jupyter Notebook': '#da5b0b',
  Lua: '#000080',
  PHP: '#4f5d95',
  Ruby: '#701516',
  Swift: '#f05138',
  Svelte: '#ff3e00',
  Astro: '#ff5d01',
  Blade: '#f7523f',
  Handlebars: '#f7931e',
};
const FALLBACK = [T.pink, T.violet, T.pinkSoft, '#e879b9', '#a78bfa'];

function langColor(name, index) {
  return LANG_COLORS[name] || FALLBACK[index % FALLBACK.length];
}

/* ------------------------------------------------------------------- cards */

function defs() {
  return `  <defs>
    <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${T.bgTop}"/>
      <stop offset="100%" stop-color="${T.bgBottom}"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${T.pink}"/>
      <stop offset="100%" stop-color="${T.violet}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0" r="0.9">
      <stop offset="0%" stop-color="${T.pink}" stop-opacity="0.20"/>
      <stop offset="60%" stop-color="${T.violet}" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="${T.pink}" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
}

function frame(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" font-family="${FONT}">
${defs()}
  <clipPath id="cardClip"><rect x="0" y="0" width="${width}" height="${height}" rx="12"/></clipPath>
  <g clip-path="url(#cardClip)">
    <rect x="0" y="0" width="${width}" height="${height}" fill="url(#cardBg)"/>
    <rect x="0" y="0" width="${width}" height="${height}" fill="url(#glow)"/>
    <rect x="0" y="0" width="${width}" height="3" fill="url(#accent)" opacity="0.9"/>
${body}
  </g>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="none" stroke="${T.border}"/>
</svg>
`;
}

function header(width, title, note) {
  return `  <text x="24" y="33" font-size="14" font-weight="700" fill="${T.title}">${esc(title)}</text>
  <text x="${width - 24}" y="33" font-size="10" fill="${T.faint}" text-anchor="end">${esc(note)}</text>
  <line x1="24" y1="46" x2="${width - 24}" y2="46" stroke="${T.line}" stroke-width="1"/>`;
}

function statsCard({ repoCount, stars, user, activity }) {
  const W = 480;
  const H = 214;

  const cells = [
    ['Total stars', num(stars)],
    ['Commits / year', num(activity?.commits)],
    ['Contributions', num(activity?.contributions)],
    ['Public repos', num(repoCount)],
    ['Pull requests', num(activity?.prs)],
    ['Followers', num(user.followers)],
  ];

  const colX = [24, 176, 328];
  const rowY = [
    { value: 92, label: 112 },
    { value: 160, label: 180 },
  ];

  const grid = cells
    .map(([label, value], i) => {
      const x = colX[i % 3];
      const y = rowY[Math.floor(i / 3)];
      return `  <text x="${x}" y="${y.value}" font-size="22" font-weight="700" fill="url(#accent)">${esc(value)}</text>
  <text x="${x}" y="${y.label}" font-size="10" fill="${T.dim}" letter-spacing="0.7">${esc(label.toUpperCase())}</text>`;
    })
    .join('\n');

  const body = `${header(W, 'GitHub stats', `updated ${STAMP}`)}
${grid}`;

  return frame(W, H, body);
}

function topLangsCard(langBytes) {
  const W = 480;
  const H = 236;

  const entries = [...langBytes.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0) || 1;

  const top = entries.slice(0, 5).map(([name, bytes], i) => ({
    name,
    bytes,
    pct: (bytes / total) * 100,
    color: langColor(name, i),
  }));
  const restBytes = entries.slice(5).reduce((sum, [, bytes]) => sum + bytes, 0);

  // Stacked proportion bar (rounded via clip so every segment keeps the shape)
  const barX = 24;
  const barY = 60;
  const barW = W - 48;
  const barH = 10;
  let cursor = 0;
  const segments = [];
  for (const seg of [...top, ...(restBytes > 0 ? [{ name: 'Other', bytes: restBytes, pct: (restBytes / total) * 100, color: T.faint }] : [])]) {
    const w = Math.max((seg.pct / 100) * barW, 2);
    segments.push(`  <rect x="${(barX + cursor).toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="${barH}" fill="${seg.color}"/>`);
    cursor += w;
  }

  const legend = top
    .map((seg, i) => {
      const y = 104 + i * 26;
      return `  <circle cx="27" cy="${y - 4}" r="4" fill="${seg.color}"/>
  <text x="40" y="${y}" font-size="12.5" fill="${T.text}">${esc(seg.name)}</text>
  <text x="${W - 24}" y="${y}" font-size="11.5" fill="${T.dim}" text-anchor="end">${seg.pct.toFixed(1)}%</text>`;
    })
    .join('\n');

  const body = `${header(W, 'Top languages', `by bytes · ${STAMP}`)}
  <clipPath id="barClip"><rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}"/></clipPath>
  <g clip-path="url(#barClip)">
${segments.join('\n')}
  </g>
${legend}`;

  return frame(W, H, body);
}

/* -------------------------------------------------------------------- main */

async function main() {
  const data = await collect();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'stats.svg'), statsCard(data), 'utf8');
  await writeFile(path.join(OUT_DIR, 'top-langs.svg'), topLangsCard(data.langBytes), 'utf8');
  console.log(
    `wrote assets/stats.svg + assets/top-langs.svg ` +
      `(${data.repoCount} repos, ${data.stars} stars, ${data.langBytes.size} languages)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
