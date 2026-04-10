import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import { extractPdfText } from "./cvParser.js";
import { storeChunksForExistingDocument, searchRelevantChunks, storeCandidateMetadata, hybridCandidateSearch } from "./ragService.js";
import { openai } from "./openai.js";
import { pool } from "./db.js";
import { extractGraphDataFromCv, storeGraphData, getGraphByDocumentId, buildGraphContext } from "./graphService.js";
import { advancedHybridGraphSearch } from "./hybridGraphSearchService.js";

dotenv.config();

const app = express();
app.use(express.json());

const upload = multer({ dest: "uploads/" });

app.post("/api/cv/upload", upload.single("cv"), async (req, res) => {
    try {
        const rawText = await extractPdfText(req.file.path);

        const result = await pool.query(
            `INSERT INTO cv_documents (file_name, raw_text, processing_status)
       VALUES ($1, $2, 'UPLOADED')
       RETURNING id, file_name, processing_status`,
            [req.file.originalname, rawText]
        );

        res.json({
            success: true,
            document: result.rows[0],
        });
    } catch (error) {
        console.error("Error processing CV:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/cv/search", async (req, res) => {
    try {
        const { query } = req.body;
        const results = await searchRelevantChunks(query, 5, 0.7);

        res.json({ results, count: results.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/cv/ask", async (req, res) => {
    try {
        const { question } = req.body;
        const chunks = await searchRelevantChunks(question, 10);

        const context = chunks.map((c, i) => {
            return `[Chunk ${i + 1}] File: ${c.file_name}\n${c.content}`;
        }).join("\n\n");

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Answer only based on the provided CV context. If there is not enough information, say there is not enough information.",
                },
                {
                    role: "user",
                    content: `Context:\n${context}\n\nQuestion: ${question}`,
                },
            ],
        });

        res.json({
            answer: response.choices[0].message.content,
            retrievedChunks: chunks,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/cv/:documentId/process", async (req, res) => {
    const { documentId } = req.params;

    try {
        const docResult = await pool.query(
            `SELECT * FROM cv_documents WHERE id = $1`,
            [documentId]
        );

        if (docResult.rows.length === 0) {
            return res.status(404).json({ error: "Document not found" });
        }

        const document = docResult.rows[0];

        await pool.query(
            `UPDATE cv_documents
       SET processing_status = 'PROCESSING', processing_error = NULL
       WHERE id = $1`,
            [documentId]
        );

        try {
            const chunkInfo = await storeChunksForExistingDocument(
                documentId,
                document.raw_text
            );

            const metadata = await storeCandidateMetadata(
                documentId,
                document.raw_text
            );

            const graphData = await extractGraphDataFromCv(document.raw_text);
            await storeGraphData(documentId, graphData);

            await pool.query(
                `UPDATE cv_documents
         SET processing_status = 'COMPLETED'
         WHERE id = $1`,
                [documentId]
            );

            res.json({
                success: true,
                message: "Document processed successfully",
                chunkInfo,
                metadata,
                graphSummary: {
                    entityCount: graphData.entities?.length || 0,
                    relationshipCount: graphData.relationships?.length || 0,
                },
            });
        } catch (processingError) {
            await pool.query(
                `UPDATE cv_documents
         SET processing_status = 'FAILED', processing_error = $2
         WHERE id = $1`,
                [documentId, processingError.message]
            );

            throw processingError;
        }
    } catch (error) {
        console.error("Error processing document:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/cv/:documentId/status", async (req, res) => {
    try {
        const { documentId } = req.params;

        const result = await pool.query(
            `SELECT id, file_name, processing_status, processing_error, created_at
       FROM cv_documents
       WHERE id = $1`,
            [documentId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Document not found" });
        }

        res.json({ document: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/candidates/hybrid-search", async (req, res) => {
    try {
        const results = await hybridCandidateSearch(req.body);
        res.json({ results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/cv/:documentId/graph", async (req, res) => {
    try {
        const { documentId } = req.params;
        const graph = await getGraphByDocumentId(documentId);

        res.json({
            documentId,
            ...graph,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/graph/query", async (req, res) => {
    try {
        const { relation, toEntity } = req.body;

        const result = await pool.query(
            `SELECT document_id, from_entity, relation, to_entity
       FROM graph_relationships
       WHERE relation = $1
         AND to_entity ILIKE $2`,
            [relation, `%${toEntity}%`]
        );

        res.json({ results: result.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/cv/ask-graph", async (req, res) => {
    try {
        const { question } = req.body;

        const graphContext = await buildGraphContext(50);

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content:
                        "Answer only based on the provided graph context. If there is not enough information, say there is not enough information.",
                },
                {
                    role: "user",
                    content: `Graph Context:\n${graphContext}\n\nQuestion: ${question}`,
                },
            ],
        });

        res.json({
            answer: response.choices[0].message.content,
            graphContext,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/candidates/:documentId/graph-summary", async (req, res) => {
    try {
        const { documentId } = req.params;

        const candidateResult = await pool.query(
            `SELECT * FROM candidates WHERE document_id = $1`,
            [documentId]
        );

        const graph = await getGraphByDocumentId(documentId);

        res.json({
            candidate: candidateResult.rows[0] || null,
            graph,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/candidates/search-advanced", async (req, res) => {
    try {
        const {
            query,
            minYearsExperience = 0,
            skillKeyword = null,
            graphRelation = null,
            graphTarget = null,
            limit = 10,
        } = req.body;

        if (!query) {
            return res.status(400).json({ error: "query is required" });
        }

        const results = await advancedHybridGraphSearch({
            query,
            minYearsExperience,
            skillKeyword,
            graphRelation,
            graphTarget,
            limit,
        });

        res.json({
            success: true,
            count: results.length,
            results,
        });
    } catch (error) {
        console.error("advanced search error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
});