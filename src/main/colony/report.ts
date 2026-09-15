// The colony step report: one HTML page per card, showing what every step cost
// and what it added — tokens, findings, and the code it changed.
//
// The question it exists to answer is whether a stage earns its tokens. So the
// page leads with the ratio (tokens per NEW finding) and marks the steps that
// produced neither a new finding nor a change, rather than leading with totals.
//
// WHERE IT GOES: `<project root>/.floe/colony/reports/`, in the main checkout and
// never in the card's worktree. A report in the worktree rides on the task branch
// and lands on base with the merge; a report in the root survives the merge, the
// worktree's removal and any branch the root has checked out.
//
// The folder carries its own `.gitignore` of `*`. That is not tidiness:
// `mergeWorktree` refuses when the main checkout has anything untracked, and not
// every machine ignores `.floe/` globally — without it the first report would
// block every merge after it.
//
// Self-contained on purpose: no stylesheet, no script, no fetch. It is opened
// straight from disk, possibly long after the app that wrote it has changed.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { treeDiff, type TreeDiffFile } from '../git'
import type { ColonyTask } from './store'

/** Where a project's reports live. */
export const reportsDirFor = (project: string): string => join(project, '.floe', 'colony', 'reports')

/** Patch text kept per step, per view. Counts are always complete (see `treeDiff`). */
const PATCH_BUDGET = 150_000

export interface ReportStep {
  stage: string
  harness?: string
  model?: string
  verdict: string
  why?: string
  startedAt: number
  endedAt: number
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd?: number }
  findingsDeclared: boolean
  findings: { severity: string; fresh: boolean; seenIn?: string; text: string }[]
  message: string
  /** This step's own changes: its end against its start. */
  files: TreeDiffFile[]
  /** Everything since the card's first step started, as of this step's end. */
  sinceStart: TreeDiffFile[]
}

export interface ReportData {
  task: { id: string; name: string; kind: string; branch?: string; brief: string; stage: string; mergedAt?: number }
  generatedAt: number
  steps: ReportStep[]
}

/**
 * Gather the page's data: every measured visit, with its diffs computed now.
 *
 * Only visits that carry a `step` count — a card the report started tracking
 * midway has earlier visits with nothing measured, and drawing them as zero-cost
 * steps would be the exact false signal the report is meant to catch.
 */
export async function reportData(task: ColonyTask): Promise<ReportData> {
  const measured = task.visits.filter((v) => v.step)
  const start = measured[0]?.step?.treeBefore
  const diff = async (from?: string, to?: string): Promise<TreeDiffFile[]> =>
    task.worktreePath && from && to ? treeDiff(task.worktreePath, from, to, PATCH_BUDGET).catch(() => []) : []

  const steps: ReportStep[] = []
  for (const visit of measured) {
    const step = visit.step as NonNullable<typeof visit.step>
    steps.push({
      stage: visit.stage,
      harness: step.harness,
      model: step.model,
      verdict: visit.verdict,
      why: visit.why,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      usage: step.usage,
      findingsDeclared: step.findingsDeclared,
      findings: step.findings,
      message: step.message,
      files: await diff(step.treeBefore, step.treeAfter),
      sinceStart: await diff(start, step.treeAfter)
    })
  }
  return {
    task: {
      id: task.id,
      name: task.name,
      kind: task.kind,
      branch: task.branch,
      brief: task.brief,
      stage: task.stage,
      mergedAt: task.mergedAt
    },
    generatedAt: Date.now(),
    steps
  }
}

/** Write the card's report into its project. Overwrites the last one for this card. */
export async function writeReport(task: ColonyTask): Promise<{ file: string; data: ReportData }> {
  const dir = reportsDirFor(task.project)
  mkdirSync(dir, { recursive: true })
  const ignore = join(dir, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const file = join(dir, `${task.name}-${task.id.slice(-6)}.html`)
  const data = await reportData(task)
  writeFileSync(file, renderReport(data))
  return { file, data }
}

/** One line per step, for an agent: what it cost and what it added, without the patches. */
export function reportSummary(data: ReportData): Record<string, unknown>[] {
  return data.steps.map((s) => ({
    stage: s.stage,
    model: [s.harness, s.model].filter(Boolean).join(':') || 'default',
    verdict: s.verdict,
    tokens: s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite,
    costUsd: s.usage.costUsd,
    findings: s.findingsDeclared ? s.findings.length : null,
    newFindings: s.findings.filter((f) => f.fresh).length,
    filesChanged: s.files.length,
    linesAdded: s.files.reduce((n, f) => n + f.added, 0),
    linesDeleted: s.files.reduce((n, f) => n + f.deleted, 0)
  }))
}

/**
 * The page. Data goes in as JSON with every `<` escaped, so a finding or a diff
 * that contains `</script>` cannot end the script it is embedded in.
 */
export function renderReport(data: ReportData): string {
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    // The two line separators JSON allows and a script does not.
    .replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'))
  const title = data.task.name.replace(/[<>&"]/g, '')
  return [
    '<!doctype html>',
    '<html data-theme="dark">',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>colony report — ${title}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    `<body>${BODY}`,
    `<script id="data" type="application/json">${json}</script>`,
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>'
  ].join('\n')
}

const CSS = `
:root {
  --bg: #0d0e11; --panel: rgb(20 21 25); --line: #23252b; --line-soft: #1c1e23;
  --text: #c9ccd2; --text-strong: #e8eaee; --dim: #6d7280; --faint: #575d6a; --dimmer: #7f8797;
  --edge: #343a45; --well: rgb(27 29 35); --wash-1: #ffffff08; --wash-3: #ffffff0d; --wash-4: #ffffff12;
  --accent: #d3956d; --live: #6ea86e; --working: #6d93c9; --warn: #d0a95a; --bad: #d07a7a;
  --mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
html[data-theme="light"] {
  --bg: #ffffff; --panel: rgb(248 249 251); --line: #d7dae1; --line-soft: #e4e7ec;
  --text: #3d434e; --text-strong: #1b1e25; --dim: #767c88; --faint: #939aa6; --dimmer: #868d99;
  --edge: #c3c8d1; --well: #f1f3f6; --wash-1: #00000005; --wash-3: #0000000a; --wash-4: #0000000f;
  --accent: #b8703f; --live: #3f8a3f; --working: #3f6fae; --warn: #9c7420; --bad: #b24a4a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 12px/1.55 var(--mono); }
button, select { font: inherit; }
:focus-visible { outline: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
.act { border: 1px solid var(--edge); background: var(--wash-1); color: var(--text); padding: 2px 9px; cursor: pointer; font-size: 11px; }
.act:hover { background: var(--wash-3); }
.act[aria-pressed="true"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
h2 { font-size: 10px; letter-spacing: .09em; text-transform: uppercase; color: var(--dimmer); font-weight: 400; margin: 0 0 8px; }
.note { color: var(--faint); font-size: 11px; margin: 4px 0 18px; }
.report { max-width: 1180px; margin: 0 auto; padding: 22px 20px 60px; }
.rhead { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.rtitle { color: var(--text-strong); font-size: 16px; }
.rsub { color: var(--dim); }
.spacer { flex: 1; }
.brief { color: var(--dim); white-space: pre-wrap; margin: 6px 0 0; max-height: 4.6em; overflow: hidden; }
.kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); margin: 16px 0 16px; }
.kpi { background: var(--panel); padding: 10px 12px; }
.kpi b { display: block; color: var(--text-strong); font-size: 20px; font-weight: 400; }
.kpi > span { color: var(--dim); font-size: 11px; }
.verdict-box { margin: 0 0 18px; border: 1px solid var(--line); padding: 10px 12px; }
.verdict-box b { color: var(--text-strong); font-weight: 400; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 22px; }
@media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } .kpis { grid-template-columns: repeat(2, 1fr); } }
.box { border: 1px solid var(--line); background: var(--panel); padding: 12px; overflow: auto; }
.bars { display: grid; grid-template-columns: 110px 1fr 64px; gap: 6px 10px; align-items: center; }
.bar-l { color: var(--text); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.bar-l small { color: var(--faint); }
.bar-t { position: relative; height: 14px; cursor: pointer; }
.bar-f { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: 0 4px 4px 0; opacity: .8; min-width: 2px; }
.bar-t:hover .bar-f, .bar-t[data-sel] .bar-f { opacity: 1; }
.bar-t[data-waste] .bar-f { background: repeating-linear-gradient(45deg, var(--accent) 0 3px, transparent 3px 6px); border: 1px solid var(--accent); }
.bar-v { color: var(--dimmer); text-align: right; }
.legend { color: var(--faint); font-size: 11px; margin-top: 10px; display: flex; gap: 14px; flex-wrap: wrap; }
.sw { display: inline-block; width: 12px; height: 8px; background: var(--accent); margin-right: 5px; }
.sw[data-waste] { background: repeating-linear-gradient(45deg, var(--accent) 0 2px, transparent 2px 4px); border: 1px solid var(--accent); }
.tip { position: fixed; pointer-events: none; background: var(--well); border: 1px solid var(--edge); padding: 6px 9px; font-size: 11px; color: var(--text); display: none; z-index: 9; min-width: 180px; }
.tip b { color: var(--text-strong); font-weight: 400; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; color: var(--dimmer); font-weight: 400; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; padding: 4px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 5px 6px; border-bottom: 1px solid var(--line-soft); white-space: nowrap; }
.num { text-align: right; }
tr[data-id] { cursor: pointer; }
tr[data-id]:hover, tr[data-sel] { background: var(--wash-3); }
.add { color: var(--live); } .del { color: var(--bad); }
.tag { border: 1px solid var(--edge); padding: 0 5px; font-size: 10px; color: var(--dim); }
.tag[data-tone="pass"] { color: var(--live); border-color: color-mix(in srgb, var(--live) 40%, transparent); }
.tag[data-tone="return"] { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.tag[data-tone="stop"], .tag[data-tone="none"] { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.flow { display: flex; align-items: center; overflow-x: auto; padding: 14px 0 10px; margin-bottom: 18px; }
.node { border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 5px 10px; cursor: pointer; white-space: nowrap; text-align: left; }
.node small { display: block; color: var(--faint); font-size: 10px; }
.node[data-sel] { border-color: var(--accent); }
.node[data-verdict="return"] { border-style: dashed; }
.edge { width: 22px; height: 1px; background: var(--edge); flex: none; position: relative; }
.edge[data-back]::after { content: "\\21A9"; position: absolute; top: -15px; left: 5px; color: var(--warn); font-size: 11px; }
.detail { border: 1px solid var(--line); background: var(--panel); }
.tabs { display: flex; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.tab { background: none; border: 0; border-right: 1px solid var(--line-soft); color: var(--dim); padding: 7px 14px; cursor: pointer; }
.tab[aria-selected="true"] { color: var(--text-strong); background: var(--wash-3); }
.tabs .right { margin-left: auto; display: flex; align-items: center; gap: 6px; padding: 4px 10px; color: var(--faint); }
.pane { padding: 12px 14px; display: none; }
.pane[data-show] { display: block; }
.pane.flush { padding: 0; }
.dhead { display: flex; gap: 16px; color: var(--dim); margin-bottom: 12px; flex-wrap: wrap; }
.dhead b { color: var(--text-strong); font-weight: 400; }
.finding { display: grid; grid-template-columns: 34px 90px 1fr; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line-soft); }
.finding .code { color: var(--dimmer); }
.finding[data-dup] .txt { color: var(--faint); }
.sev { font-size: 10px; }
.sev[data-s="high"] { color: var(--bad); } .sev[data-s="med"] { color: var(--warn); } .sev[data-s="low"] { color: var(--dim); }
.dupof { color: var(--faint); font-size: 11px; }
.files { display: grid; grid-template-columns: 280px 1fr; min-height: 300px; max-height: 70vh; }
.flist { border-right: 1px solid var(--line); overflow: auto; }
.fitem { display: flex; gap: 6px; padding: 4px 8px; cursor: pointer; border-bottom: 1px solid var(--line-soft); }
.fitem span:first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.fitem[data-sel] { background: var(--wash-4); color: var(--text-strong); }
.diff { font-size: 11.5px; overflow: auto; }
.dl { white-space: pre; padding: 0 10px; }
.dl[data-k="+"] { background: color-mix(in srgb, var(--live) 12%, transparent); color: var(--text-strong); }
.dl[data-k="-"] { background: color-mix(in srgb, var(--bad) 12%, transparent); }
.dl[data-k="@"] { color: var(--working); padding-top: 6px; }
.dl[data-k="h"] { color: var(--faint); }
.msg { white-space: pre-wrap; color: var(--text); background: var(--well); border: 1px solid var(--line); padding: 10px; margin: 0; max-height: 70vh; overflow: auto; }
kbd { border: 1px solid var(--edge); padding: 0 4px; color: var(--dim); font-size: 10px; }
`

const BODY = `
<div class="report">
  <div class="rhead">
    <span class="rtitle" id="title"></span>
    <span class="rsub" id="sub"></span>
    <span class="spacer"></span>
    <button class="act" id="theme" title="Light or dark (t)">light / dark</button>
  </div>
  <p class="brief" id="brief"></p>
  <div class="kpis" id="kpis"></div>
  <div class="verdict-box" id="verdict"></div>
  <h2>step flow</h2>
  <div class="flow" id="flow"></div>
  <div class="grid2">
    <div class="box">
      <h2>tokens per step</h2>
      <div class="bars" id="bars"></div>
      <div class="legend"><span><i class="sw"></i>produced a new finding or a change</span><span><i class="sw" data-waste></i>no new finding, no change</span></div>
    </div>
    <div class="box">
      <h2>signal per step</h2>
      <table>
        <thead><tr><th>step</th><th class="num">tokens</th><th class="num">cost</th><th class="num">files</th><th class="num">lines</th><th class="num">found</th><th class="num">new</th><th class="num">tok/new</th><th>verdict</th></tr></thead>
        <tbody id="tbl"></tbody>
      </table>
    </div>
  </div>
  <div class="detail">
    <div class="tabs" role="tablist">
      <button class="tab" role="tab" aria-selected="true" data-pane="findings">1 findings</button>
      <button class="tab" role="tab" aria-selected="false" data-pane="changes">2 code changes</button>
      <button class="tab" role="tab" aria-selected="false" data-pane="message">3 final message</button>
      <span class="right">
        <button class="act" id="scope-step" aria-pressed="true" title="This step's own changes (c)">this step</button>
        <button class="act" id="scope-start" aria-pressed="false" title="Everything since the first step (c)">since first step</button>
      </span>
    </div>
    <div class="pane" data-pane="findings" data-show><div class="dhead" id="dhead"></div><div id="findings"></div></div>
    <div class="pane flush" data-pane="changes"><div class="files"><div class="flist" id="flist"></div><div class="diff" id="diff"></div></div></div>
    <div class="pane" data-pane="message"><pre class="msg" id="msg"></pre></div>
  </div>
  <p class="note"><kbd>j</kbd>/<kbd>k</kbd> step &middot; <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> tab &middot; <kbd>n</kbd>/<kbd>p</kbd> file &middot; <kbd>c</kbd> this step / since first step &middot; <kbd>t</kbd> theme</p>
</div>
<div class="tip" id="tip"></div>
`

// Plain concatenation below, no template literals: this whole script sits inside
// a TypeScript template string, and a backtick or a dollar-brace in it would be
// read by the wrong language.
const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var steps = data.steps;
  var sel = 0, tab = 'findings', scope = 'step', fileAt = 0;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var tok = function (u) { return u.input + u.output + u.cacheRead + u.cacheWrite; };
  var k = function (n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); };
  var money = function (s) { return s.usage.costUsd == null ? '\\u2014' : '$' + s.usage.costUsd.toFixed(2); };
  var fresh = function (s) { return s.findings.filter(function (f) { return f.fresh; }).length; };
  var lines = function (files) { return files.reduce(function (n, f) { return [n[0] + f.added, n[1] + f.deleted]; }, [0, 0]); };
  var waste = function (s) { return fresh(s) === 0 && s.files.length === 0; };
  var dur = function (ms) { var t = Math.max(0, Math.round(ms / 1000)), m = Math.floor(t / 60); return m ? m + 'm ' + String(t % 60).padStart(2, '0') + 's' : t + 's'; };
  var label = function (i) {
    var s = steps[i], same = steps.filter(function (x) { return x.stage === s.stage; });
    return same.length > 1 ? s.stage + ' #' + (steps.slice(0, i + 1).filter(function (x) { return x.stage === s.stage; }).length) : s.stage;
  };
  var firstRaised = function (text, before) {
    for (var i = 0; i < before; i++) if (steps[i].findings.some(function (f) { return f.fresh && f.text === text; })) return i;
    return -1;
  };

  function header() {
    var t = data.task;
    $('title').textContent = t.name;
    var span = steps.length ? steps[steps.length - 1].endedAt - steps[0].startedAt : 0;
    $('sub').textContent = t.kind + (t.branch ? ' \\u00b7 ' + t.branch : '') + ' \\u00b7 ' + steps.length + ' steps \\u00b7 ' + dur(span) +
      ' \\u00b7 ' + (t.mergedAt ? 'merged' : t.stage) + ' \\u00b7 written ' + new Date(data.generatedAt).toLocaleString();
    $('brief').textContent = t.brief;
    var total = steps.reduce(function (n, s) { return n + tok(s.usage); }, 0);
    var priced = steps.filter(function (s) { return s.usage.costUsd != null; });
    var cost = priced.reduce(function (n, s) { return n + s.usage.costUsd; }, 0);
    var found = steps.reduce(function (n, s) { return n + s.findings.length; }, 0);
    var news = steps.reduce(function (n, s) { return n + fresh(s); }, 0);
    var own = steps.reduce(function (n, s) { var l = lines(s.files); return [n[0] + l[0], n[1] + l[1]]; }, [0, 0]);
    var empty = steps.filter(waste).length;
    var kpi = function (b, span) { return '<div class="kpi"><b>' + b + '</b><span>' + span + '</span></div>'; };
    $('kpis').innerHTML =
      kpi(k(total), 'tokens, all steps') +
      kpi(priced.length ? '$' + cost.toFixed(2) : '\\u2014', priced.length === steps.length ? 'cost' : 'cost \\u00b7 ' + (steps.length - priced.length) + (steps.length - priced.length === 1 ? ' step' : ' steps') + ' unpriced') +
      kpi(found, 'findings \\u00b7 ' + news + ' new') +
      kpi('<span class="add">+' + own[0] + '</span> <span class="del">\\u2212' + own[1] + '</span>', 'lines, summed over steps') +
      kpi(empty, empty === 1 ? 'step with no signal' : 'steps with no signal');

    var ranked = steps.map(function (s, i) { return { i: i, per: fresh(s) ? tok(s.usage) / fresh(s) : Infinity }; })
      .filter(function (r) { return r.per !== Infinity; }).sort(function (a, b) { return a.per - b.per; });
    var parts = [];
    if (ranked.length) {
      var best = ranked[0];
      parts.push('<b>Cheapest signal:</b> ' + esc(label(best.i)) + ' \\u2014 ' + fresh(steps[best.i]) + ' new for ' + k(tok(steps[best.i].usage)) + ' tokens (' + k(best.per) + ' per finding).');
    }
    var none = steps.map(function (s, i) { return i; }).filter(function (i) { return waste(steps[i]); });
    if (none.length) parts.push('<b>No signal:</b> ' + none.map(function (i) { return esc(label(i)) + ' (' + k(tok(steps[i].usage)) + ')'; }).join(', ') + ' \\u2014 no new finding and no change.');
    var silent = steps.map(function (s, i) { return i; }).filter(function (i) { return !steps[i].findingsDeclared; });
    if (silent.length) parts.push('<b>No findings block:</b> ' + silent.map(function (i) { return esc(label(i)); }).join(', ') + ' \\u2014 counted as zero, not measured.');
    $('verdict').innerHTML = parts.join('<br>') || 'No steps measured yet.';
  }

  function render() {
    var max = Math.max.apply(null, steps.map(function (s) { return tok(s.usage); }).concat([1]));
    $('flow').innerHTML = steps.map(function (s, i) {
      return (i ? '<span class="edge"' + (steps[i - 1].verdict === 'return' ? ' data-back' : '') + '></span>' : '') +
        '<button class="node" data-i="' + i + '" data-verdict="' + esc(s.verdict) + '"' + (i === sel ? ' data-sel' : '') + '>' + esc(label(i)) +
        '<small>' + k(tok(s.usage)) + ' \\u00b7 ' + fresh(s) + ' new</small></button>';
    }).join('');
    $('bars').innerHTML = steps.map(function (s, i) {
      return '<span class="bar-l" data-i="' + i + '">' + esc(label(i)) + ' <small>' + esc(s.model || s.harness || '') + '</small></span>' +
        '<span class="bar-t" data-i="' + i + '"' + (waste(s) ? ' data-waste' : '') + (i === sel ? ' data-sel' : '') + '><span class="bar-f" style="width:' + (tok(s.usage) / max) * 100 + '%"></span></span>' +
        '<span class="bar-v">' + k(tok(s.usage)) + '</span>';
    }).join('');
    $('tbl').innerHTML = steps.map(function (s, i) {
      var l = lines(s.files), n = fresh(s);
      return '<tr data-i="' + i + '"' + (i === sel ? ' data-sel' : '') + '><td>' + esc(label(i)) + '</td><td class="num">' + k(tok(s.usage)) + '</td><td class="num">' + money(s) +
        '</td><td class="num">' + s.files.length + '</td><td class="num"><span class="add">+' + l[0] + '</span> <span class="del">\\u2212' + l[1] + '</span></td>' +
        '<td class="num">' + (s.findingsDeclared ? s.findings.length : '?') + '</td><td class="num">' + n + '</td><td class="num">' + (n ? k(tok(s.usage) / n) : '\\u2014') +
        '</td><td><span class="tag" data-tone="' + esc(s.verdict) + '">' + esc(s.verdict) + '</span></td></tr>';
    }).join('');
    detail();
  }

  function detail() {
    var s = steps[sel];
    if (!s) { $('dhead').textContent = 'No steps measured yet.'; return; }
    var l = lines(s.files);
    $('dhead').innerHTML = '<span><b>' + esc(label(sel)) + '</b> \\u00b7 ' + esc([s.harness, s.model].filter(Boolean).join(':') || 'default') + '</span>' +
      '<span>' + tok(s.usage).toLocaleString() + ' tokens</span><span>in ' + s.usage.input.toLocaleString() + ' \\u00b7 out ' + s.usage.output.toLocaleString() +
      ' \\u00b7 cache ' + (s.usage.cacheRead + s.usage.cacheWrite).toLocaleString() + '</span><span>' + money(s) + '</span><span>' + dur(s.endedAt - s.startedAt) + '</span>' +
      '<span><span class="add">+' + l[0] + '</span> <span class="del">\\u2212' + l[1] + '</span></span>' + (s.why ? '<span>\\u21a9 ' + esc(s.why) + '</span>' : '');
    if (!s.findingsDeclared) $('findings').innerHTML = '<p class="note">This step wrote no FINDINGS block, so what it found was not measured. Its final message is under 3.</p>';
    else if (!s.findings.length) $('findings').innerHTML = '<p class="note">FINDINGS: none.</p>';
    else $('findings').innerHTML = s.findings.map(function (f, i) {
      var from = f.fresh ? -1 : firstRaised(f.text, sel);
      var by = f.fresh ? '' : '<div class="dupof">already raised by ' + esc(from >= 0 ? label(from) : (f.seenIn || 'an earlier step')) + '</div>';
      return '<div class="finding"' + (f.fresh ? '' : ' data-dup') + '><span class="code">F' + (i + 1) + '</span><span class="sev" data-s="' + esc(f.severity) + '">' + esc(f.severity) + (f.fresh ? ' \\u00b7 new' : ' \\u00b7 seen') + '</span>' +
        '<span class="txt">' + esc(f.text) + by + '</span></div>';
    }).join('');
    $('msg').textContent = s.message || '(no message)';
    files();
  }

  function files() {
    var list = scope === 'step' ? steps[sel].files : steps[sel].sinceStart;
    $('scope-step').setAttribute('aria-pressed', scope === 'step');
    $('scope-start').setAttribute('aria-pressed', scope === 'start');
    if (!list.length) { $('flist').innerHTML = '<p class="note" style="padding:8px">' + (scope === 'step' ? 'No code changed in this step.' : 'No code changed yet.') + '</p>'; $('diff').innerHTML = ''; return; }
    fileAt = Math.min(fileAt, list.length - 1);
    $('flist').innerHTML = list.map(function (f, i) {
      return '<div class="fitem" data-f="' + i + '"' + (i === fileAt ? ' data-sel' : '') + ' title="' + esc(f.path) + '"><span>' + esc(f.path) + '</span>' +
        (f.binary ? '<span class="tag">bin</span>' : '<span class="add">+' + f.added + '</span><span class="del">\\u2212' + f.deleted + '</span>') + '</div>';
    }).join('');
    var f = list[fileAt];
    var body = f.patch ? f.patch.split('\\n').map(function (line) {
      var c = line.charAt(0), kind = line.indexOf('@@') === 0 ? '@' : /^(diff |index |--- |\\+\\+\\+ |new file|deleted file|similarity|rename )/.test(line) ? 'h' : c === '+' ? '+' : c === '-' ? '-' : ' ';
      return '<div class="dl" data-k="' + kind + '">' + esc(line) + '</div>';
    }).join('') : '<p class="note" style="padding:8px">' + (f.binary ? 'Binary file.' : 'Patch not kept \\u2014 this step\\u2019s diff was over the size budget. The counts are exact.') + '</p>';
    if (f.patch && f.truncated) body += '<p class="note" style="padding:8px">Cut here \\u2014 over the size budget.</p>';
    $('diff').innerHTML = body;
  }

  function setTab(name) {
    tab = name;
    document.querySelectorAll('.tab').forEach(function (t) { t.setAttribute('aria-selected', t.getAttribute('data-pane') === name); });
    document.querySelectorAll('.pane').forEach(function (p) { p.toggleAttribute('data-show', p.getAttribute('data-pane') === name); });
  }
  function pick(i) { if (i >= 0 && i < steps.length) { sel = i; fileAt = 0; render(); } }

  var tip = $('tip');
  document.addEventListener('mousemove', function (e) {
    var bar = e.target.closest && e.target.closest('.bar-t');
    if (!bar) { tip.style.display = 'none'; return; }
    var i = +bar.getAttribute('data-i'), s = steps[i], l = lines(s.files);
    tip.innerHTML = '<b>' + esc(label(i)) + '</b> \\u00b7 ' + esc(s.model || s.harness || 'default') + '<br>' + tok(s.usage).toLocaleString() + ' tokens \\u00b7 ' + money(s) +
      '<br>' + fresh(s) + ' new / ' + s.findings.length + ' findings<br><span class="add">+' + l[0] + '</span> <span class="del">\\u2212' + l[1] + '</span> in ' + s.files.length + ' files';
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 220) + 'px';
    tip.style.top = e.clientY + 10 + 'px';
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-i]');
    if (t) return pick(+t.getAttribute('data-i'));
    var f = e.target.closest('[data-f]');
    if (f) { fileAt = +f.getAttribute('data-f'); return files(); }
    var tb = e.target.closest('.tab');
    if (tb) return setTab(tb.getAttribute('data-pane'));
  });
  $('scope-step').onclick = function () { scope = 'step'; fileAt = 0; files(); };
  $('scope-start').onclick = function () { scope = 'start'; fileAt = 0; files(); };
  $('theme').onclick = function () { var h = document.documentElement; h.dataset.theme = h.dataset.theme === 'dark' ? 'light' : 'dark'; };
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var list = scope === 'step' ? (steps[sel] || { files: [] }).files : (steps[sel] || { sinceStart: [] }).sinceStart;
    if (e.key === 'j' || e.key === 'ArrowDown') pick(sel + 1);
    else if (e.key === 'k' || e.key === 'ArrowUp') pick(sel - 1);
    else if (e.key === '1' || e.key === '2' || e.key === '3') setTab(['findings', 'changes', 'message'][+e.key - 1]);
    else if (e.key === 'n' && fileAt < list.length - 1) { fileAt++; setTab('changes'); files(); }
    else if (e.key === 'p' && fileAt > 0) { fileAt--; setTab('changes'); files(); }
    else if (e.key === 'c') { scope = scope === 'step' ? 'start' : 'step'; fileAt = 0; setTab('changes'); files(); }
    else if (e.key === 't') $('theme').click();
  });

  header();
  render();
})();
`
