import { pool } from "./db.js";
import { getEmbedding } from "./openai.js";
import { getGraphByDocumentId } from "./graphService.js";

/**
 * Step 1:
 * Ambil kandidat berdasarkan metadata filter
 */
async function findCandidatesByMetadata({
    minYearsExperience = 0,
    skillKeyword = null,
}) {
    const result = await pool.query(
        `SELECT
        d.id AS document_id,
        d.file_name,
        c.full_name,
        c.current_title,
        c.years_experience,
        c.raw_skills,
        c.summary
     FROM cv_documents d
     LEFT JOIN candidates c ON c.document_id = d.id
     WHERE ($1::int = 0 OR c.years_experience >= $1)
       AND ($2::text IS NULL OR c.raw_skills ILIKE '%' || $2 || '%')`,
        [minYearsExperience, skillKeyword]
    );

    return result.rows;
}

/**
 * Step 2:
 * Ambil kandidat berdasarkan vector similarity
 */
async function findCandidatesByVector({ query, limit = 10 }) {
    const embedding = await getEmbedding(query);
    const embeddingStr = `[${embedding.join(",")}]`;

    const result = await pool.query(
        `SELECT
        d.id AS document_id,
        d.file_name,
        c.full_name,
        c.current_title,
        c.years_experience,
        c.raw_skills,
        ch.content,
        (ch.embedding <-> $1) AS distance
     FROM cv_chunks ch
     JOIN cv_documents d ON d.id = ch.document_id
     LEFT JOIN candidates c ON c.document_id = d.id
     ORDER BY ch.embedding <-> $1
     LIMIT $2`,
        [embeddingStr, limit]
    );

    return result.rows;
}

/**
 * Step 3:
 * Ambil kandidat berdasarkan relasi graph
 */
async function findCandidatesByGraph({
    graphRelation = null,
    graphTarget = null,
}) {
    if (!graphRelation || !graphTarget) return [];

    const result = await pool.query(
        `SELECT
        gr.document_id,
        d.file_name,
        c.full_name,
        c.current_title,
        c.years_experience,
        c.raw_skills,
        gr.from_entity,
        gr.relation,
        gr.to_entity
     FROM graph_relationships gr
     JOIN cv_documents d ON d.id = gr.document_id
     LEFT JOIN candidates c ON c.document_id = d.id
     WHERE gr.relation = $1
       AND gr.to_entity ILIKE '%' || $2 || '%'`,
        [graphRelation, graphTarget]
    );

    return result.rows;
}

/**
 * Step 4:
 * Fetch all graph relationships for a set of document IDs
 */
async function fetchGraphForDocuments(documentIds) {
    if (!documentIds || documentIds.length === 0) return [];

    const result = await pool.query(
        `SELECT document_id, from_entity, relation, to_entity
         FROM graph_relationships
         WHERE document_id = ANY($1::int[])`,
        [documentIds]
    );

    return result.rows;
}

/**
 * Build a readable graph context string for a single document
 * (same format as buildGraphContext in graphService.js)
 */
async function buildGraphContextForDocument(documentId) {
    const { relationships } = await getGraphByDocumentId(documentId);
    return relationships
        .map((r) => `${r.from_entity} --${r.relation}--> ${r.to_entity}`)
        .join("\n");
}

/**
 * Step 5:
 * Merge hasil metadata + vector + graph
 */
function mergeAndScoreCandidates({
    metadataResults,
    vectorResults,
    graphResults,
}) {
    const candidateMap = new Map();

    function ensureCandidate(row) {
        const key = row.document_id;

        if (!candidateMap.has(key)) {
            candidateMap.set(key, {
                document_id: row.document_id,
                file_name: row.file_name,
                full_name: row.full_name || null,
                current_title: row.current_title || null,
                years_experience: row.years_experience || null,
                raw_skills: row.raw_skills || null,
                score: 0,
                reasons: [],
                matched_chunks: [],
                matched_graph: [],
            });
        }

        return candidateMap.get(key);
    }

    // Metadata score
    for (const row of metadataResults) {
        const candidate = ensureCandidate(row);
        candidate.score += 30;
        candidate.reasons.push("Matched metadata filters");
    }

    // Vector score
    vectorResults.forEach((row, index) => {
        const candidate = ensureCandidate(row);

        // skor lebih besar untuk ranking lebih atas
        const vectorScore = Math.max(1, 20 - index * 2);
        candidate.score += vectorScore;
        candidate.reasons.push(`Matched semantic search (rank ${index + 1})`);

        candidate.matched_chunks.push({
            content: row.content,
            distance: row.distance,
        });
    });

    // Graph score
    for (const row of graphResults) {
        const candidate = ensureCandidate(row);
        candidate.score += 25;
        candidate.reasons.push(
            `Matched graph relation ${row.relation} -> ${row.to_entity}`
        );

        candidate.matched_graph.push({
            from_entity: row.from_entity,
            relation: row.relation,
            to_entity: row.to_entity,
        });
    }

    // rapikan reasons agar unik
    for (const candidate of candidateMap.values()) {
        candidate.reasons = [...new Set(candidate.reasons)];
    }

    return Array.from(candidateMap.values()).sort((a, b) => b.score - a.score);
}

/**
 * Main service
 */
export async function advancedHybridGraphSearch({
    query,
    minYearsExperience = 0,
    skillKeyword = null,
    graphRelation = null,
    graphTarget = null,
    limit = 10,
}) {
    const [metadataResults, vectorResults, graphResults] = await Promise.all([
        findCandidatesByMetadata({
            minYearsExperience,
            skillKeyword,
        }),
        findCandidatesByVector({
            query,
            limit,
        }),
        findCandidatesByGraph({
            graphRelation,
            graphTarget,
        }),
    ]);

    const merged = mergeAndScoreCandidates({
        metadataResults,
        vectorResults,
        graphResults,
    });

    const sliced = merged.slice(0, limit);

    // Enrich matched_graph for all candidates using their document IDs
    const documentIds = sliced.map((c) => c.document_id);
    const allGraphRows = await fetchGraphForDocuments(documentIds);

    const graphByDoc = {};
    for (const row of allGraphRows) {
        if (!graphByDoc[row.document_id]) graphByDoc[row.document_id] = [];
        graphByDoc[row.document_id].push({
            from_entity: row.from_entity,
            relation: row.relation,
            to_entity: row.to_entity,
        });
    }

    for (const candidate of sliced) {
        if (candidate.matched_graph.length === 0) {
            candidate.matched_graph = graphByDoc[candidate.document_id] || [];
        }
        candidate.graph_context = candidate.matched_graph
            .map((r) => `${r.from_entity} --${r.relation}--> ${r.to_entity}`)
            .join("\n");
    }

    return sliced;
}