import { openai } from "./openai.js";
import { pool } from "./db.js";

export async function extractGraphDataFromCv(rawText) {
    const prompt = `
From this CV text, extract graph entities and relationships.

Return JSON with this structure:
{
  "entities": [
    { "type": "PERSON|SKILL|COMPANY|ROLE|DOMAIN", "value": "..." }
  ],
  "relationships": [
    { "from": "...", "relation": "...", "to": "..." }
  ]
}

Rules:
- Use only relevant business entities
- Avoid duplicates if possible
- Use uppercase relation names like HAS_SKILL, WORKED_AT, PLAYED_ROLE, HAS_DOMAIN
- If unsure, do not invent
- Return JSON only

CV TEXT:
${rawText}
`;

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
            {
                role: "user",
                content: prompt,
            },
        ],
    });

    return JSON.parse(response.choices[0].message.content);
}

export async function storeGraphData(documentId, graphData) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        for (const entity of graphData.entities || []) {
            await client.query(
                `INSERT INTO graph_entities (document_id, entity_type, entity_value)
         VALUES ($1, $2, $3)`,
                [documentId, entity.type, entity.value]
            );
        }

        for (const rel of graphData.relationships || []) {
            await client.query(
                `INSERT INTO graph_relationships (document_id, from_entity, relation, to_entity)
         VALUES ($1, $2, $3, $4)`,
                [documentId, rel.from, rel.relation, rel.to]
            );
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function getGraphByDocumentId(documentId) {
    const entities = await pool.query(
        `SELECT id, entity_type, entity_value
     FROM graph_entities
     WHERE document_id = $1
     ORDER BY id`,
        [documentId]
    );

    const relationships = await pool.query(
        `SELECT id, from_entity, relation, to_entity
     FROM graph_relationships
     WHERE document_id = $1
     ORDER BY id`,
        [documentId]
    );

    return {
        entities: entities.rows,
        relationships: relationships.rows,
    };
}

export async function buildGraphContext(limit = 30) {
    const result = await pool.query(
        `SELECT from_entity, relation, to_entity
     FROM graph_relationships
     ORDER BY id
     LIMIT $1`,
        [limit]
    );

    return result.rows
        .map(r => `${r.from_entity} --${r.relation}--> ${r.to_entity}`)
        .join("\n");


    // Alice --HAS_SKILL--> Python
    // Alice --WORKED_AT--> Acme Corp
}