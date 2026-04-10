from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from pathlib import Path
import subprocess
import re

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
INPUT_DIR = BASE_DIR / "input"

INPUT_DIR.mkdir(parents=True, exist_ok=True)

class IndexPayload(BaseModel):
    documentId: int
    fileName: str
    rawText: str

class QueryPayload(BaseModel):
    question: str

def sanitize_filename(name: str) -> str:
    name = name.strip().lower()
    name = re.sub(r"[^a-z0-9-_]+", "-", name)
    name = re.sub(r"-+", "-", name).strip("-")
    return name or "document"

@app.get("/")
def root():
    return {"message": "GraphRAG service is running"}

@app.post("/documents/index")
def index_document(payload: IndexPayload):
    try:
        safe_name = sanitize_filename(payload.fileName)
        file_path = INPUT_DIR / f"{payload.documentId}-{safe_name}.txt"

        file_path.write_text(payload.rawText, encoding="utf-8")

        result = subprocess.run(
            ["graphrag", "index"],
            capture_output=True,
            text=True
        )

        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail={
                    "message": "GraphRAG indexing failed",
                    "stderr": result.stderr
                }
            )

        return {
            "success": True,
            "documentId": payload.documentId,
            "filePath": str(file_path),
            "stdout": result.stdout
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/query")
def query_graph(payload: QueryPayload):
    result = subprocess.run(
        ["graphrag", "query", payload.question],
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail={
                "message": "GraphRAG query failed",
                "stderr": result.stderr
            }
        )

    return {
        "question": payload.question,
        "output": result.stdout
    }