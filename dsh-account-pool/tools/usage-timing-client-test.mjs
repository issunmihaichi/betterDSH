/** Focused timing UI tests, without providers, browser state or sibling plugin assumptions. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const bundle = process.argv[2] ?? new URL('../lib/client.js', import.meta.url);
const source = readFileSync(bundle, 'utf8');
let exported;
const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
const instrumented = source.replace('exports.compact = compact;', 'exports._timingTest = { dicts, UsagePanel, UsageRow }; exports.compact = compact;');
assert.notEqual(instrumented, source);
vm.runInNewContext(instrumented, {
  window: { __ModuleLoader__: { load(definition) { exported = definition.factory(name => { assert.equal(name, 'react'); return React; }); } } },
});
const { dicts, UsagePanel, UsageRow } = exported._timingTest;
const t = (locale) => (key, values = {}) => {
  let text = dicts[locale][key] ?? key;
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
};
const children = node => (node.children ?? []).flat(Infinity).filter(v => v != null);
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : children(node).map(text).join('');
const find = (node, type) => {
  if (node == null || typeof node !== 'object') return [];
  return [...(node.type === type ? [node] : []), ...children(node).flatMap(child => find(child, type))];
};
const row = { at: '2026-01-01T00:00:00.000Z', accountId: 'synthetic-account', model: 'synthetic-model', inputTokens: 100, outputTokens: 60, cacheReadTokens: 10, accountSwitches: 0, ok: true };

test('nullable formatting never turns missing measurements into zero', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, '250', {}]) {
    assert.equal(exported.formatUsageDuration(value), '—');
    assert.equal(exported.formatUsageTps(value), '—');
  }
  assert.equal(exported.formatUsageDuration(0), '0 ms');
  assert.equal(exported.formatUsageDuration(280), '280 ms');
  assert.equal(exported.formatUsageDuration(1250), '1.25 s');
  assert.equal(exported.formatUsageDuration(65000), '65.00 s');
  assert.equal(exported.formatUsageTps(0), '0.0 tok/s');
  assert.equal(exported.formatUsageTps(33.333), '33.3 tok/s');
});

test('nine bilingual columns align with measured and legacy records', () => {
  for (const locale of ['zh', 'en']) {
    const translate = t(locale);
    const tree = UsagePanel({ t: translate, list: [], rows: [row], summary: { ok: 1, failed: 0, input: 100, output: 60 }, filters: { account: '', model: '' }, status: 'ready', onFilter() {} });
    const headers = find(tree, 'th');
    assert.equal(headers.length, 9);
    assert.deepEqual(headers.slice(4, 7).map(text), locale === 'zh' ? ['首字', '输出时长', 'TPS'] : ['First token', 'Output duration', 'TPS']);
    assert.ok(headers.slice(4, 7).every(cell => cell.props.scope === 'col' && !!cell.props.title));
    const measured = UsageRow({ t: translate, row: { ...row, firstTokenMs: 280, outputDurationMs: 2000, outputTps: 30 } });
    assert.equal(find(measured, 'td').length, 9);
    assert.deepEqual(find(measured, 'td').slice(4, 7).map(text), ['280 ms', '2.00 s', '30.0 tok/s']);
    const legacy = UsageRow({ t: translate, row });
    assert.deepEqual(find(legacy, 'td').slice(4, 7).map(text), ['—', '—', '—']);
    assert.ok(find(legacy, 'td').slice(4, 7).every(cell => cell.props.title === translate('usageTimingUnavailable')));
  }
});

test('timing dictionaries remain balanced and table remains horizontally scrollable', () => {
  for (const key of ['colFirstToken', 'colOutputDuration', 'colOutputTps', 'firstTokenHint', 'outputDurationHint', 'outputTpsHint', 'usageTimingHint', 'usageTimingUnavailable']) {
    assert.equal(typeof dicts.zh[key], 'string');
    assert.equal(typeof dicts.en[key], 'string');
  }
  assert.match(source, /\.dap-usage-table\{min-width:1050px\}/);
  assert.match(source, /\.dap-table-wrap\{[^}]*overflow-x:auto/);
  assert.match(source, /\.dap-usage-table \.dap-timing\{[^}]*white-space:nowrap/);
});
