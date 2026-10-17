/**
 * ============================================================================
 * HYBRID SEARCH MODULE
 * ============================================================================
 * True hybrid search combining dense vector similarity with full-text (BM25)
 * search using Reciprocal Rank Fusion (RRF) or weighted linear combination.
 *
 * Supports native backend hybrid search and a bounded independent lexical
 * scan for clients with verified full-text chunk listing.
 *
 * @version 1.0.0
 * ============================================================================
 */

import { getBackend } from '../backends/backend-manager.js';
import { createBM25Scorer, tokenize } from './bm25-scorer.js';
import { createStreamingLexicalAccumulator } from './lexical-stream.js';

/** Default RRF constant (prevents division by zero, balances contribution) */
export const DEFAULT_RRF_K = 60;

/**
 * Perform hybrid search combining vector and full-text results
 *
 * @param {string} collectionId - Collection to search
 * @param {string} searchText - Query text
 * @param {number} topK - Number of results to return
 * @param {object} settings - VectHare settings
 * @param {object} options - Hybrid search options
 * @returns {Promise<{hashes: number[], metadata: object[]}>}
 */
export async function hybridSearch(collectionId, searchText, topK, settings, options = {}) {
    const backend = await getBackend(settings);

    const {
        fusionMethod = settings.hybrid_fusion_method || 'rrf',
        vectorWeight = settings.hybrid_vector_weight ?? 0.5,
        textWeight = settings.hybrid_text_weight ?? 0.5,
        rrfK = settings.hybrid_rrf_k || DEFAULT_RRF_K,
        queryVector = null
    } = options;

    // Check if backend supports native hybrid search and user prefers it
    const preferNative = settings.hybrid_native_prefer !== false;
    if (preferNative && backend.supportsHybridSearch && backend.supportsHybridSearch()) {
        console.log(`[HybridSearch] Using native hybrid search (${backend.constructor.name})`);
        try {
            return await backend.hybridQuery(collectionId, searchText, topK, settings, {
                vectorWeight,
                textWeight,
                fusionMethod,
                rrfK
            });
        } catch (error) {
            console.warn(`[HybridSearch] Native hybrid failed, falling back to client-side:`, error.message);
            // Fall through to client-side fusion
        }
    }

    // Client-side fusion for backends without native support
    console.log(`[HybridSearch] Using client-side ${fusionMethod.toUpperCase()} fusion`);
    return clientSideHybridSearch(
        backend,
        collectionId,
        searchText,
        topK,
        settings,
        { fusionMethod, vectorWeight, textWeight, rrfK, queryVector }
    );
}

/**
 * Independent lexical source. BM25 must be able to discover a chunk that dense
 * vector search never returned. A bounded complete inventory is required:
 * silently treating a partial scroll as the whole corpus distorts BM25 IDF.
 * Never cache another tenant's entries or fall back to unverified native hashes.
 */
async function collectLexicalCandidates(backend, collectionId, settings, onRow = null) {
    if (typeof backend.listChunks !== 'function') {
        throw new Error('Independent lexical search requires a text-capable listChunks backend');
    }
    const maxDocuments = Math.max(100, Math.min(100000,
        Math.trunc(Number(settings.hybrid_lexical_scan_limit ?? 20000) || 20000)));
    const seen = new Set();
    const docs = [];
    let cursor = null, offset = 0;
    const seenCursors = new Set();
    const qdrant = settings.vector_backend === 'qdrant';
    while (true) {
        const requestLimit = Math.min(200, maxDocuments - seen.size + 1);
        const page = await backend.listChunks(collectionId, settings,
            qdrant ? { cursor, pageSize: requestLimit }
                : { offset, limit: requestLimit });
        if (!page || !Array.isArray(page.items) || page.items.length > requestLimit)
            throw new Error('Malformed lexical inventory; refusing incomplete hybrid results');
        if (qdrant && (page.pageMode !== 'cursor' || typeof page.hasMore !== 'boolean'))
            throw new Error('Qdrant lexical retrieval requires verified cursor pagination');
        if (!qdrant && (!Number.isSafeInteger(page.total) || page.total < 0 || page.total < offset + page.items.length))
            throw new Error('Lexical inventory lacks an authoritative total count');
        for (const row of page.items) {
            const hash = row.hash ?? row.metadata?.hash;
            if (hash == null || row.metadata?.unverifiedNativeMetadata || typeof (row.text ?? row.metadata?.text) !== 'string') {
                throw new Error('Lexical inventory lacks verified chunk identities or text');
            }
            if (seen.has(String(hash))) continue;
            seen.add(String(hash));
            const doc={ hash, text: row.text ?? row.metadata?.text,
                title: row.metadata?.entryName ?? row.metadata?.title ?? '',
                tags: row.metadata?.keywords ?? [], metadata: row.metadata ?? row };
            if (seen.size > maxDocuments) {
                throw new Error(`Lexical search exceeded ${maxDocuments} documents; use native indexed hybrid search or narrow the collection (client-side scan is bounded)`);
            }
            if(onRow)onRow(doc);else docs.push(doc);
        }
        if (qdrant) {
            if (!page.hasMore) {
                if (page.cursor != null) throw new Error('Terminal Qdrant lexical page carries an unexpected cursor');
                break;
            }
            const next = page.cursor;
            const key=JSON.stringify(next);
            if (next == null || seenCursors.has(key) || key === JSON.stringify(cursor))
                throw new Error('Lexical inventory cursor made no progress');
            seenCursors.add(key);
            cursor = next;
        } else {
            offset += page.items.length;
            if (offset === page.total) break;
            if (offset > page.total) throw new Error('Lexical page exceeded authoritative total');
        }
        if (page.items.length === 0) throw new Error('Lexical inventory was truncated before completion');
    }
    return onRow ? seen.size : docs;
}

/**
 * Client-side hybrid search using dual queries + fusion
 *
 * @param {object} backend - Vector backend instance
 * @param {string} collectionId - Collection to search
 * @param {string} searchText - Query text
 * @param {number} topK - Number of results to return
 * @param {object} settings - VectHare settings
 * @param {object} options - Fusion options
 * @returns {Promise<{hashes: number[], metadata: object[]}>}
 */
async function clientSideHybridSearch(backend, collectionId, searchText, topK, settings, options) {
    const {
        fusionMethod,
        vectorWeight,
        textWeight,
        rrfK,
        queryVector
    } = options;

    // Fetch more results for fusion (need candidates from both methods)
    const expandedTopK = Math.min(65536, Math.max(topK, topK * 3));

    // 1. Vector search
    console.log(`[HybridSearch] Fetching ${expandedTopK} vector results from collection: ${collectionId}`);
    console.log(`[HybridSearch] Backend: ${backend.constructor.name}, Source: ${settings.source}`);

    let vectorResults;
    try {
        vectorResults = await backend.queryCollection(
            collectionId,
            searchText,
            expandedTopK,
            settings,
            queryVector
        );
        console.log(`[HybridSearch] Raw vector results:`, vectorResults ? `hashes=${vectorResults.hashes?.length}, metadata=${vectorResults.metadata?.length}` : 'null');
    } catch (error) {
        console.error(`[HybridSearch] Vector query failed:`, error);
        throw new Error(`Hybrid vector query failed for ${collectionId}: ${error.message}`, { cause: error });
    }

    if (!vectorResults || !Array.isArray(vectorResults.hashes) || !Array.isArray(vectorResults.metadata))
        throw new Error(`Malformed hybrid vector response for ${collectionId}; cannot treat a failed query as empty`);
    if (vectorResults.hashes.length !== vectorResults.metadata.length)
        throw new Error(`Malformed hybrid vector response for ${collectionId}: hash/metadata length mismatch`);
    // Do not return early when dense search is empty. Independent lexical
    // search can still discover keyword-only memories.

    // 2. Convert to format for BM25 scoring (include title and tags for field boosting)
    const resultsWithText = vectorResults.metadata.map((meta, idx) => ({
        hash: vectorResults.hashes[idx],
        text: meta.text || '',
        title: meta.entryName || meta.title || '',
        tags: meta.keywords || [],
        score: meta.score || 0,
        metadata: meta
    }));

    // 3. Score an independently enumerated lexical corpus, not just vectors.
    // Never silently interpret a failed/partial scan as a complete result.
    const bm25Options={k1:settings.bm25_k1 ?? 1.5,b:settings.bm25_b ?? 0.75,fieldBoosting:true};
    const shortlistSize=Math.min(65536,Math.max(topK*3,100));
    const requestedLimit=Math.max(100,Math.min(100000,Number(settings.hybrid_lexical_scan_limit ?? 20000)||20000));
    let bm25Results;
    if(requestedLimit>20000){
        // O(N) network scan is still necessary without a trustworthy native
        // sparse/text index, but query-scoped scoring avoids building an entire
        // corpus-sized vocabulary and term-frequency index in browser RAM.
        const accumulator=createStreamingLexicalAccumulator(searchText,bm25Options);
        const count=await collectLexicalCandidates(backend,collectionId,settings,doc=>accumulator.add(doc));
        console.log(`[HybridSearch] Query-scoped BM25 streamed ${count} docs, retained ${accumulator.retainedDocs} matching docs`);
        bm25Results=accumulator.results(shortlistSize).filter(row=>row.bm25Score>0);
    }else{
        const lexicalCorpus=await collectLexicalCandidates(backend,collectionId,settings);
        console.log(`[HybridSearch] Computing BM25 scores for ${lexicalCorpus.length} independent lexical candidates...`);
        bm25Results=performBM25Search(lexicalCorpus,searchText,bm25Options).filter(row=>row.bm25Score>0);
        bm25Results.length=Math.min(bm25Results.length,shortlistSize);
    }

    // 4. Fuse results
    let fusedResults;
    if (fusionMethod === 'rrf') {
        console.log(`[HybridSearch] Applying RRF fusion (k=${rrfK})...`);
        fusedResults = reciprocalRankFusion(
            [vectorResultsToRanked(vectorResults), bm25Results],
            rrfK
        );
    } else {
        console.log(`[HybridSearch] Applying weighted fusion (α=${vectorWeight}, β=${textWeight})...`);
        fusedResults = weightedCombination(
            vectorResultsToScored(vectorResults),
            bm25Results,
            vectorWeight,
            textWeight
        );
    }

    // 5. Return top K fused results
    const topResults = fusedResults.slice(0, topK);

    console.log(`[HybridSearch] Returning ${topResults.length} fused results`);
    if (topResults.length > 0) {
        // Log score distribution for debugging
        const scores = topResults.map(r => r.rrfScore || r.combinedScore || 0);
        console.log(`[HybridSearch] Score distribution: min=${Math.min(...scores).toFixed(4)}, max=${Math.max(...scores).toFixed(4)}`);
        console.log(`[HybridSearch] Top 3 results:`);
        topResults.slice(0, 3).forEach((r, i) => {
            const score = (r.rrfScore || r.combinedScore || 0).toFixed(4);
            const vRank = r.ranks?.vector || 'N/A';
            const tRank = r.ranks?.text || 'N/A';
            const vScore = (r.vectorScore || 0).toFixed(4);
            const tScore = (r.textScore || r.bm25Score || 0).toFixed(4);
            console.log(`  [${i + 1}] finalScore=${score}, vectorRank=${vRank}, textRank=${tRank}, vectorScore=${vScore}, textScore=${tScore}`);
        });
    }

    return {
        hashes: topResults.map(r => r.result?.hash ?? r.hash),
        metadata: topResults.map(r => ({
            ...(r.result?.metadata || r.metadata || {}),
            text: r.result?.text ?? r.text,
            hash: r.result?.hash ?? r.hash,
            score: r.rrfScore ?? r.combinedScore ?? 0,
            vectorScore: r.vectorScore ?? 0,
            textScore: r.textScore ?? r.bm25Score ?? 0,
            vectorRank: r.ranks?.vector,
            textRank: r.ranks?.text,
            fusionMethod: fusionMethod,
            hybridSearch: true,
            explain: {
                retrieval: 'hybrid',
                fusionMethod,
                vectorScore: r.vectorScore ?? 0,
                textScore: r.textScore ?? r.bm25Score ?? 0,
                vectorRank: r.ranks?.vector,
                textRank: r.ranks?.text,
                finalScore: r.rrfScore ?? r.combinedScore ?? 0
            }
        }))
    };
}

/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Combines multiple ranked lists using the formula:
 *   rrfScore(d) = Σ 1 / (k + rank_i(d))
 *
 * Where:
 * - d = document
 * - k = constant (typically 60)
 * - rank_i(d) = rank of document d in result list i (1-indexed)
 *
 * @param {Array[]} resultLists - Arrays of ranked results [{hash, score, ...}]
 * @param {number} k - RRF constant (default 60)
 * @returns {Array} Fused and sorted results with normalized scores
 */
export function reciprocalRankFusion(resultLists, k = DEFAULT_RRF_K) {
    const fusedScores = new Map();
    const listNames = ['vector', 'text'];

    resultLists.forEach((results, listIdx) => {
        if (!results || !Array.isArray(results)) return;

        results.forEach((result, rank) => {
            const docId = result.hash;
            if (docId === undefined || docId === null) return;

            if (!fusedScores.has(docId)) {
                fusedScores.set(docId, {
                    result,
                    rrfScore: 0,
                    rawRrfScore: 0,
                    ranks: {},
                    vectorScore: 0,
                    textScore: 0
                });
            }

            // RRF contribution: 1 / (k + rank)
            // rank is 0-indexed, so add 1 for 1-indexed ranking
            const rrfContribution = 1 / (k + rank + 1);
            const entry = fusedScores.get(docId);
            entry.rawRrfScore += rrfContribution;
            entry.ranks[listNames[listIdx]] = rank + 1;

            // Store individual scores for debugging
            if (listIdx === 0) {
                entry.vectorScore = result.score || 0;
            } else {
                entry.textScore = result.bm25Score || result.score || 0;
            }
        });
    });

    // Convert to array and sort by raw RRF score
    const sortedResults = Array.from(fusedScores.values())
        .sort((a, b) => b.rawRrfScore - a.rawRrfScore);

    // RRF determines ORDER, but display scores should reflect actual similarity
    // This ensures chunks with high semantic match show high %, while chunks that
    // are just highly ranked but don't match well show appropriately lower %
    if (sortedResults.length > 0) {
        const maxRrfScore = sortedResults[0].rawRrfScore;

        // BM25 scores are unbounded (typically 0 to 10+)
        // Use saturation function to normalize: score / (score + k)
        // This gives intuitive 0-1 values: 0→0%, k→50%, 2k→67%, etc.
        const BM25_SATURATION_K = 3.0; // Score of 3 = 50%, score of 6 = 67%, etc.

        for (const entry of sortedResults) {
            // Calculate RRF rank factor (1.0 for top, decreasing for lower)
            const rrfRankFactor = maxRrfScore > 0 ? entry.rawRrfScore / maxRrfScore : 0;

            // vectorScore: cosine similarity (already 0-1)
            const vectorScore = entry.vectorScore || 0;

            // Normalize BM25 using saturation function (independent of batch)
            const rawBM25 = entry.textScore || 0;
            const normalizedTextScore = rawBM25 / (rawBM25 + BM25_SATURATION_K);

            // Update textScore for display consistency
            entry.textScore = normalizedTextScore;

            const hasVector = vectorScore > 0.01;
            const hasText = normalizedTextScore > 0.01;

            if (hasVector && hasText) {
                // Both signals present - weighted average
                const combinedScore = (vectorScore * 0.55 + normalizedTextScore * 0.45);
                // Small boost (up to 8%) for having both signals
                const dualSignalBonus = 1.0 + (Math.min(vectorScore, normalizedTextScore) * 0.08);
                entry.rrfScore = Math.min(1.0, combinedScore * dualSignalBonus * (0.95 + 0.05 * rrfRankFactor));
            } else if (hasVector) {
                // Vector-only: penalize since no keyword overlap suggests lower relevance
                entry.rrfScore = vectorScore * 0.55 * (0.9 + 0.1 * rrfRankFactor);
            } else if (hasText) {
                // Text-only: decent relevance but missing semantic similarity
                entry.rrfScore = normalizedTextScore * 0.6 * (0.9 + 0.1 * rrfRankFactor);
            } else {
                // Fallback: pure RRF rank - very low confidence
                entry.rrfScore = rrfRankFactor * 0.25;
            }

            // Ensure score never exceeds 1.0
            entry.rrfScore = Math.min(1.0, entry.rrfScore);
        }

        // Re-sort by final score (may differ slightly from raw RRF order)
        sortedResults.sort((a, b) => b.rrfScore - a.rrfScore);
    }

    return sortedResults;
}

/**
 * Weighted Linear Combination
 *
 * Combines vector and text scores using weighted sum after normalization:
 *   combinedScore = α * normalizedVectorScore + β * normalizedTextScore
 *
 * @param {Array} vectorResults - Vector search results [{hash, score, ...}]
 * @param {Array} textResults - Text/BM25 search results [{hash, bm25Score, ...}]
 * @param {number} alpha - Weight for vector scores (default 0.5)
 * @param {number} beta - Weight for text scores (default 0.5)
 * @returns {Array} Combined and sorted results
 */
export function weightedCombination(vectorResults, textResults, alpha = 0.5, beta = 0.5) {
    // Normalize scores to [0, 1]
    const normalizedVector = normalizeScores(vectorResults, 'score');
    const normalizedText = normalizeScores(textResults, 'bm25Score');

    const combined = new Map();

    // Add all vector results
    for (const r of normalizedVector) {
        if (r.hash === undefined || r.hash === null) continue;

        combined.set(r.hash, {
            result: r,
            hash: r.hash,
            text: r.text,
            metadata: r.metadata,
            vectorScore: r.normalizedScore,
            textScore: 0,
            combinedScore: alpha * r.normalizedScore
        });
    }

    // Merge text results
    for (const r of normalizedText) {
        if (r.hash === undefined || r.hash === null) continue;

        if (combined.has(r.hash)) {
            const entry = combined.get(r.hash);
            entry.textScore = r.normalizedScore;
            entry.combinedScore += beta * r.normalizedScore;
        } else {
            combined.set(r.hash, {
                result: r,
                hash: r.hash,
                text: r.text,
                metadata: r.metadata,
                vectorScore: 0,
                textScore: r.normalizedScore,
                combinedScore: beta * r.normalizedScore
            });
        }
    }

    // Sort by combined score (descending)
    return Array.from(combined.values())
        .sort((a, b) => b.combinedScore - a.combinedScore);
}

/**
 * Min-max normalization of scores to [0, 1] range
 *
 * @param {Array} results - Results with scores
 * @param {string} scoreField - Field name containing the score
 * @returns {Array} Results with added normalizedScore field
 */
function normalizeScores(results, scoreField = 'score') {
    if (!results || results.length === 0) return [];

    const scores = results.map(r => r[scoreField] || 0);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const range = maxScore - minScore;
    // Relative min/max scaling maps a single positive hit (or tied positive hits)
    // to zero, which erroneously discards the only match. Use a stable positive
    // saturation in that case; preserve genuine zero scores.
    const tiedScore = maxScore > 0 ? maxScore / (maxScore + 1) : 0;
    return results.map(r => ({
        ...r,
        normalizedScore: range > 0 ? ((r[scoreField] ?? 0) - minScore) / range : tiedScore
    }));
}

/**
 * Perform BM25 search on a result set
 *
 * @param {Array} results - Results to score [{hash, text, ...}]
 * @param {string} query - Search query
 * @param {object} options - BM25 options
 * @returns {Array} Results sorted by BM25 score
 */
function performBM25Search(results, query, options = {}) {
    if (!results || results.length === 0) return [];
    if (!query || typeof query !== 'string') {
        console.warn('[HybridSearch] Invalid query for BM25 search');
        return results;
    }

    const scorer = createBM25Scorer(results, options);
    if (!scorer || scorer.totalDocs === 0) {
        console.warn('[HybridSearch] Failed to create BM25 scorer or no documents indexed');
        return results;
    }

    // Get BM25 scores for all results
    const scoredResults = results.map((result, idx) => {
        const bm25Score = scorer.scoreDocument(tokenize(query, options), idx);
        return {
            ...result,
            bm25Score
        };
    });

    // Sort by BM25 score (descending)
    scoredResults.sort((a, b) => b.bm25Score - a.bm25Score);

    return scoredResults;
}

/**
 * Convert vector results to ranked format for RRF
 */
function vectorResultsToRanked(vectorResults) {
    return vectorResults.metadata.map((meta, idx) => ({
        hash: vectorResults.hashes[idx],
        score: meta.score || 0,
        text: meta.text || '',
        metadata: meta
    }));
}

/**
 * Convert vector results to scored format for weighted combination
 */
function vectorResultsToScored(vectorResults) {
    return vectorResultsToRanked(vectorResults);
}
