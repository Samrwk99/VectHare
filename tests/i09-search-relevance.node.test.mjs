/** I09 focused regressions: chronology, lexical retrieval, World Info and fusion. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { lexicalTokens, containsLexicalPhrase } from '../utils/lexical-tokenization.js';
import { mergeSemanticWorldInfoChunks } from '../utils/world-info-dedup.js';
import { BM25Scorer } from '../core/bm25-scorer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const quiet = { log() {}, warn() {}, error() {}, debug() {} };

async function keywordApi() {
    const context = vm.createContext({ console: quiet });
    const bm25 = await import('../core/bm25-scorer.js');
    const module = new vm.SourceTextModule(source('core/keyword-boost.js'), { context });
    await module.link(spec => {
        let values;
        if (spec === './bm25-scorer.js') values = { porterStemmer: bm25.porterStemmer };
        else if (spec === '../utils/lexical-tokenization.js') values = { lexicalTokens, containsLexicalPhrase };
        else if (spec === '../../../../../script.js') values = { substituteParams: x => x };
        else throw new Error(`Unexpected import ${spec}`);
        return new vm.SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    return module.namespace;
}

async function hybridApi() {
    const context = vm.createContext({ console: quiet });
    const bm25 = await import('../core/bm25-scorer.js');
    const module = new vm.SourceTextModule(source('core/hybrid-search.js'), { context });
    await module.link(spec => {
        const values = spec === '../backends/backend-manager.js'
            ? { getBackend: () => null }
            : spec === './bm25-scorer.js'
                ? { createBM25Scorer: bm25.createBM25Scorer, tokenize: bm25.tokenize }
                : spec === './lexical-provider.js' ? {lexicalCandidates: async()=>({mode:'none',items:[]})} : null;
        assert.ok(values, `Unexpected hybrid import ${spec}`);
        return new vm.SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
    });
    await module.evaluate();
    return module.namespace;
}

function chatQuery(messages, depth) {
    // Execute the real small query helper without requiring a live SillyTavern host.
    const src = source('core/chat-vectorization.js');
    const start = src.indexOf('function buildSearchQuery(');
    const end = src.indexOf('\n}\n', start) + 2;
    assert.ok(start !== -1 && end > start);
    return vm.runInNewContext(`${src.slice(start, end)}\nbuildSearchQuery`, { substituteParams: x => x })(messages, { query: depth });
}

test('#140 search query selects last N in oldest-to-newest order without mutating chat', () => {
    const chat = [{ mes: 'first' }, { is_system: true, mes: 'hidden' }, { mes: 'second' }, { mes: 'third' }];
    assert.equal(chatQuery(chat, 2), 'second\nthird');
    assert.equal(chat[0].mes, 'first');
});
test('#137 semantic WI query builders do not reverse the selected window', () => {
    const chat = source('core/chat-vectorization.js');
    const wi = source('core/world-info-integration.js');
    assert.match(chat, /const recentMessages = chat\s*\.filter\(x => !x\.is_system\)\s*\.slice\(-Math\.max\(/);
    assert.match(wi, /const recentMessages = chat\s*\.filter\(m => !m\.is_system\)\s*\.slice\(-Math\.max\(/);
    assert.doesNotMatch(wi.slice(wi.indexOf('export async function applySemanticEntriesToPrompt')), /\.reverse\(\)/);
});
test('#97 WI merge de-duplicates only identical collection-qualified records', () => {
    const existing = [{ hash: '77', collectionId: 'lorebookA', score: 0.5 }];
    const wi = [{ hash: '77', collectionId: 'lorebookA', score: 0.9 },
        { hash: '77', collectionId: 'lorebookB', score: 0.8 },
        { hash: '77', collectionId: 'lorebookB', score: 0.8 }];
    const merged = mergeSemanticWorldInfoChunks(existing, wi);
    assert.equal(merged.chunks.length, 2);
    assert.equal(merged.uniqueWIChunks.length, 1);
    assert.equal(merged.chunks.at(-1), existing[0]);
});
test('#233 repeated words contribute to document BM25 term frequency', () => {
    const bm = new BM25Scorer({ sublinearTf: false, coverageBonus: false });
    bm.indexDocuments([{ text: 'dragon dragon dragon' }, { text: 'dragon' }, { text: 'unrelated' }]);
    assert.equal(bm.documentTermFreqs[0].get('dragon'), 3);
    assert.equal(bm.documentTermFreqs[1].get('dragon'), 1);
    assert.ok(bm.scoreDocument(['dragon'], 0) > bm.scoreDocument(['dragon'], 1));
});
test('#234 accented words, Cyrillic and Japanese remain searchable', () => {
    const bm = new BM25Scorer();
    bm.indexDocuments([{ text: 'café café mañana Привет 東京大学' }, { text: 'unrelated apples' }]);
    for (const query of ['café', 'mañana', 'привет', '東京']) {
        const tokens = lexicalTokens(query, { minLength: 2 });
        assert.ok(tokens.length, query);
        assert.ok(bm.scoreDocument(tokens, 0) > 0, query);
    }
    assert.ok(containsLexicalPhrase('東京大学', '東京'));
});
test('#19 query-token word boundaries match words instead of literal backspace', async () => {
    const api = await keywordApi();
    const hits = api.applyKeywordBoost([{ hash: 'x', score: 0.6, keywords: ['dragon'] }], 'a dragon appears');
    assert.ok(hits[0].keywordBoosted);
    assert.doesNotMatch(source('core/keyword-boost.js'), /\x08/);
});
test('#171 keyword match rejects substrings but accepts multiword phrases', async () => {
    const api = await keywordApi();
    const row = { hash: 1, score: 0.3, keywords: [{ text: 'mel', weight: 2 }, { text: 'blue dragon', weight: 2 }] };
    const partial = api.applyKeywordBoost([row], 'melody');
    assert.equal(partial[0].keywordBoosted, false);
    const phrase = api.applyKeywordBoost([row], 'a blue dragon appears');
    assert.deepEqual(Array.from(phrase[0].matchedKeywords), ['blue dragon']);
});
test('#99 keyword bonus respects weight and never forces a perfect similarity', async () => {
    const api = await keywordApi();
    const weak = api.applyKeywordBoost([{ score: 0.2, keywords: [{ text: 'dragon', weight: 1.1 }] }], 'dragon');
    const strong = api.applyKeywordBoost([{ score: 0.2, keywords: [{ text: 'dragon', weight: 2.0 }] }], 'dragon');
    assert.ok(weak[0].score > 0.2 && weak[0].score < strong[0].score);
    assert.ok(strong[0].score < 1);
    assert.match(source('core/chat-vectorization.js'), /const boosted = applyKeywordBoost\(/);
});
test('#53 tied scores preserve nonzero relevance under weighted fusion', async () => {
    const { weightedCombination } = await hybridApi();
    const v = [{ hash: 11, score: 0.7 }, { hash: 12, score: 0.7 }];
    const t = [{ hash: 11, bm25Score: 2 }, { hash: 12, bm25Score: 2 }];
    const result = weightedCombination(v, t, 0.5, 0.5);
    assert.ok(result.every(x => x.combinedScore > 0));
});
test('#127 RRF ordering remains based on raw reciprocal ranks', async () => {
    const { reciprocalRankFusion } = await hybridApi();
    const fusion = reciprocalRankFusion([
        [{ hash: 'A', score: 0.01 }, { hash: 'B', score: 0.99 }],
        [{ hash: 'A', bm25Score: 0.01 }, { hash: 'B', bm25Score: 100 }],
    ]);
    assert.equal(fusion[0].result.hash, 'A');
    assert.ok(fusion[0].rawRrfScore > fusion[1].rawRrfScore);
    assert.ok(fusion[1].rrfScore > fusion[0].rrfScore, 'display confidence may differ from RRF rank');
});
test('#201 overfetch never undercounts requested top K > 100', async () => {
    const api = await keywordApi();
    for (const k of [1, 10, 100, 101, 150, 500]) assert.ok(api.getOverfetchAmount(k) >= k);
});
test('#234 keyword extractors preserve normalized non-ASCII tokens', async () => {
    const api = await keywordApi();
    const text = 'café café café Привет Привет 東京大学 東京大学';
    const extracted = api.extractTextKeywords(text, { level: 'aggressive' }).map(x => x.text);
    const bm25 = api.extractBM25Keywords(text, { level: 'aggressive' }).map(x => x.text);
    assert.ok(extracted.some(x => x.includes('café')), `text: ${extracted}`);
    assert.ok(extracted.some(x => x.includes('привет')), `text: ${extracted}`);
    assert.ok(bm25.some(x => x.includes('東京')), `bm25: ${bm25}`);
});
