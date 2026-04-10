import { pool } from "./db.js";
import { getEmbedding } from "./openai.js";
import { extractCandidateMetadata } from "./metadataService.js";



export function chunkText(text, chunkSize = 800, overlap = 100) {
    const cleanText = text.replace(/\s+/g, " ").trim();
    const chunks = [];
    let start = 0;

    while (start < cleanText.length) {
        const end = start + chunkSize;
        chunks.push(cleanText.slice(start, end));
        start += chunkSize - overlap;
    }

    return chunks;
}

export async function storeDocumentWithChunks(fileName, rawText) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const docResult = await client.query(
            `INSERT INTO cv_documents (file_name, raw_text)
       VALUES ($1, $2)
       RETURNING id`,
            [fileName, rawText]
        );

        const documentId = docResult.rows[0].id;
        const chunks = chunkText(rawText);

        for (let i = 0; i < chunks.length; i++) {
            const embedding = await getEmbedding(chunks[i]);

            await client.query(
                `INSERT INTO cv_chunks (document_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4::vector)`,
                [documentId, i, chunks[i], JSON.stringify(embedding)]
            );
        }

        await client.query("COMMIT");
        return { documentId, chunkCount: chunks.length };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function searchRelevantChunks(queryText, limit = 5, threshold = null) {
    const embedding = await getEmbedding(queryText);

    const query = threshold !== null
        ? {
            text: `SELECT c.id, c.document_id, d.file_name, c.chunk_index, c.content,
                (c.embedding <=> $1::vector) AS distance
         FROM cv_chunks c
         JOIN cv_documents d ON d.id = c.document_id
         WHERE (c.embedding <=> $1::vector) < $3
         ORDER BY distance
         LIMIT $2`,
            values: [JSON.stringify(embedding), limit, threshold],
        }
        : {
            text: `SELECT c.id, c.document_id, d.file_name, c.chunk_index, c.content,
                (c.embedding <=> $1::vector) AS distance
         FROM cv_chunks c
         JOIN cv_documents d ON d.id = c.document_id
         ORDER BY distance
         LIMIT $2`,
            values: [JSON.stringify(embedding), limit],
        };

    const result = await pool.query(query);
    return result.rows;
}

export async function storeCandidateMetadata(documentId, rawText) {
    const metadata = await extractCandidateMetadata(rawText);

    await pool.query(
        `INSERT INTO candidates
      (document_id, full_name, current_title, years_experience, raw_skills, summary)
     VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            documentId,
            metadata.full_name || null,
            metadata.current_title || null,
            metadata.years_experience || null,
            metadata.skills || null,
            metadata.summary || null,
        ]
    );

    return metadata;
}

export async function storeChunksForExistingDocument(documentId, rawText) {
    const client = await pool.connect();

    try {
        const chunks = chunkText(rawText);

        for (let i = 0; i < chunks.length; i++) {
            const embedding = await getEmbedding(chunks[i]);

            await client.query(
                `INSERT INTO cv_chunks (document_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4::vector)`,
                [documentId, i, chunks[i], JSON.stringify(embedding)]
            );
        }

        return { chunkCount: chunks.length };
    } finally {
        client.release();
    }
}

export async function hybridCandidateSearch({
    query,
    minYearsExperience = 0,
    skillKeyword = null,
}) {
    const embedding = await getEmbedding(query);

    const result = await pool.query(
        `SELECT document_id, file_name, full_name, current_title, years_experience, raw_skills, content, distance
     FROM (
       SELECT DISTINCT ON (d.id)
         d.id AS document_id,
         d.file_name,
         c.full_name,
         c.current_title,
         c.years_experience,
         c.raw_skills,
         ch.content,
         ch.embedding <-> $1::vector AS distance
       FROM cv_chunks ch
       JOIN cv_documents d ON d.id = ch.document_id
       LEFT JOIN candidates c ON c.document_id = d.id
       WHERE ($2::int = 0 OR c.years_experience >= $2)
         AND ($3::text IS NULL OR c.raw_skills ILIKE '%' || $3 || '%')
       ORDER BY d.id, ch.embedding <-> $1::vector
     ) ranked
     ORDER BY distance
     LIMIT 5`,
        [JSON.stringify(embedding), minYearsExperience, skillKeyword]
    );

    return result.rows;
}