export async function queryGraphRag(question) {
    const response = await fetch("http://localhost:8000/query", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ question }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`GraphRAG query error: ${err}`);
    }

    return response.json();
}

export async function indexDocumentToGraphRag({
    documentId,
    fileName,
    rawText,
}) {
    const response = await fetch("http://localhost:8000/documents/index", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            documentId,
            fileName,
            rawText,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`GraphRAG index error: ${err}`);
    }

    return response.json();
}
