import os
# pyrefly: ignore [missing-import]
import httpx
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, HTTPException
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
from pathlib import Path

# Load env variables from Backend/.env using absolute path
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

import uuid
import json
import re
import io
from fastapi import UploadFile, File
from pydantic import BaseModel

# LangChain and Gemini imports
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI
from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document

# Map GEMINI_API_KEY to GOOGLE_API_KEY for langchain-google-genai compatibility
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if GEMINI_API_KEY and not os.getenv("GOOGLE_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = GEMINI_API_KEY

if os.getenv("GOOGLE_API_KEY"):
    print("[BACKEND] GEMINI_API_KEY/GOOGLE_API_KEY loaded successfully.")
else:
    print("[BACKEND] WARNING: GEMINI_API_KEY is not configured.")

METERED_DOMAIN = os.getenv("METERED_DOMAIN", "studycord.metered.live")
METERED_SECRET_KEY = os.getenv("METERED_SECRET_KEY")

app = FastAPI(title="StudyCord Secure TURN API")

# Enable CORS for the frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/turn-credentials")
async def get_turn_credentials():
    if not METERED_SECRET_KEY:
        print("[TURN-API] METERED_SECRET_KEY environment variable is not set.")
        raise HTTPException(
            status_code=500,
            detail="METERED_SECRET_KEY environment variable is not set on the backend."
        )

    post_url = f"https://{METERED_DOMAIN}/api/v1/turn/credential"
    post_params = {"secretKey": METERED_SECRET_KEY}
    post_data = {"label": "studycord-dev", "expiryInSeconds": 3600}

    masked_secret = f"{METERED_SECRET_KEY[:4]}...{METERED_SECRET_KEY[-4:]}" if METERED_SECRET_KEY and len(METERED_SECRET_KEY) > 8 else "***"
    print(f"[TURN-API] Creating TURN credential. URL: {post_url}?secretKey={masked_secret}, Body: {post_data}")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Step 1: Create TURN credential
            post_response = await client.post(post_url, params=post_params, json=post_data)
            post_response.raise_for_status()
            credential_info = post_response.json()
            
            api_key = credential_info.get("apiKey")
            if not api_key:
                print(f"[TURN-API] POST response did not contain 'apiKey'. Response: {credential_info}")
                raise HTTPException(
                    status_code=502,
                    detail="Failed to retrieve apiKey from Metered credential creation."
                )

            # Step 2: Fetch ICE servers using the api key
            get_url = f"https://{METERED_DOMAIN}/api/v1/turn/credentials"
            get_params = {"apiKey": api_key}
            
            masked_api_key = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else "***"
            print(f"[TURN-API] Fetching ICE servers. URL: {get_url}?apiKey={masked_api_key}")

            get_response = await client.get(get_url, params=get_params)
            get_response.raise_for_status()
            
            ice_servers = get_response.json()
            return ice_servers
    except httpx.HTTPStatusError as e:
        print(f"[TURN-API] Metered API returned error status {e.response.status_code}: {e.response.text}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch credentials from Metered API: {e.response.text}"
        )
    except Exception as e:
        print(f"[TURN-API] Connection error fetching Metered credentials: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal connection error: {str(e)}"
        )

# =====================================================================
# STUDYCORD BASIC RAG MVP ENDPOINTS
# =====================================================================

# In-memory store: doc_id -> { "db": FAISS, "text": str, "filename": str }
vector_stores = {}

async def extract_text_from_file(file: UploadFile) -> str:
    filename = file.filename
    content = await file.read()
    ext = filename.split(".")[-1].lower()
    
    if ext == "txt":
        return content.decode("utf-8", errors="ignore")
    
    elif ext == "pdf":
        from pypdf import PdfReader
        pdf_file = io.BytesIO(content)
        reader = PdfReader(pdf_file)
        text = ""
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + "\n"
        return text
        
    elif ext == "docx":
        import docx
        docx_file = io.BytesIO(content)
        doc = docx.Document(docx_file)
        text = ""
        for p in doc.paragraphs:
            if p.text:
                text += p.text + "\n"
        for table in doc.tables:
            for row in table.rows:
                row_text = [cell.text for cell in row.cells if cell.text]
                if row_text:
                    text += " | ".join(row_text) + "\n"
        return text
    
    else:
        raise ValueError(f"Unsupported file format: {ext}")

def parse_json_from_response(content: str):
    # Try direct parse
    try:
        return json.loads(content.strip())
    except json.JSONDecodeError:
        pass
        
    # Try to find json block using regex
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass
            
    # Try finding the first '[' or '{' and last ']' or '}'
    start_idx = min(content.find('{') if '{' in content else len(content), content.find('[') if '[' in content else len(content))
    end_idx = max(content.rfind('}') if '}' in content else -1, content.rfind(']') if ']' in content else -1)
    if start_idx < end_idx:
        try:
            return json.loads(content[start_idx:end_idx+1])
        except json.JSONDecodeError:
            pass
            
    raise ValueError("Response could not be parsed as valid JSON.")

class ChatRequest(BaseModel):
    question: str
    mode: str = "chat"
    doc_id: str

class DocRequest(BaseModel):
    doc_id: str

@app.post("/api/rag/upload")
async def rag_upload(file: UploadFile = File(...)):
    if not os.getenv("GOOGLE_API_KEY"):
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY is not configured on the backend. Please add it to Backend/.env"
        )
        
    try:
        text = await extract_text_from_file(file)
        if not text.strip():
            raise HTTPException(status_code=400, detail="The uploaded file contains no readable text.")
            
        # Split text into chunks
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        chunks = text_splitter.split_text(text)
        
        # Convert to Documents
        documents = [Document(page_content=chunk, metadata={"source": file.filename}) for chunk in chunks]
        
        # Embeddings and FAISS
        embeddings = GoogleGenerativeAIEmbeddings(model="models/gemini-embedding-001")
        db = FAISS.from_documents(documents, embeddings)
        
        doc_id = str(uuid.uuid4())
        vector_stores[doc_id] = {
            "db": db,
            "text": text,
            "filename": file.filename
        }
        
        return {
            "status": "success",
            "doc_id": doc_id,
            "filename": file.filename,
            "num_chunks": len(chunks)
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"[RAG-UPLOAD] Error processing document: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to process document: {str(e)}")

@app.post("/api/rag/chat")
async def rag_chat(request: ChatRequest):
    if not os.getenv("GOOGLE_API_KEY"):
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY is not configured on the backend. Please add it to Backend/.env"
        )
        
    doc_data = vector_stores.get(request.doc_id)
    if not doc_data:
        raise HTTPException(status_code=404, detail="Document not found or expired. Please upload it again.")
        
    try:
        db = doc_data["db"]
        docs = db.similarity_search(request.question, k=4)
        context = "\n\n".join([doc.page_content for doc in docs])
        
        chat = ChatGoogleGenerativeAI(model="gemini-2.5-flash", temperature=0.3)
        prompt = (
            f"You are an AI Study Assistant for StudyCord. Answer the student's question based strictly on the provided document context. "
            f"If the answer cannot be found in the context, you may use your general knowledge to answer, but state clearly that it is not explicitly mentioned in the document.\n\n"
            f"Document Context:\n{context}\n\n"
            f"Student Question: {request.question}\n\n"
            f"Helpful Answer:"
        )
        
        response = await chat.ainvoke(prompt)
        return {"answer": response.content}
    except Exception as e:
        print(f"[RAG-CHAT] Error querying: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to process chat question: {str(e)}")

@app.post("/api/rag/summary")
async def rag_summary(request: DocRequest):
    if not os.getenv("GOOGLE_API_KEY"):
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY is not configured on the backend. Please add it to Backend/.env"
        )
        
    doc_data = vector_stores.get(request.doc_id)
    if not doc_data:
        raise HTTPException(status_code=404, detail="Document not found.")
        
    try:
        text = doc_data["text"][:50000] # truncate to stay within safe prompt length
        chat = ChatGoogleGenerativeAI(model="gemini-2.5-flash", temperature=0.2)
        
        prompt = (
            "Analyze the provided document text and generate a structured summary. "
            "You MUST reply ONLY with a valid JSON object matching the following structure:\n"
            "{\n"
            "  \"executive_summary\": \"A concise 2-3 paragraph summary of the entire document.\",\n"
            "  \"key_concepts\": [\n"
            "    {\"concept\": \"Name of concept\", \"description\": \"Definition/explanation of the concept\"}\n"
            "  ],\n"
            "  \"key_points\": [\n"
            "    \"Important point or takeaway 1\",\n"
            "    \"Important point or takeaway 2\"\n"
            "  ]\n"
            "}\n\n"
            "Do not include any formatting, markdown wrappers, or explanation outside of the raw JSON object.\n\n"
            f"Document Text:\n{text}"
        )
        
        response = await chat.ainvoke(prompt)
        parsed_json = parse_json_from_response(response.content)
        return parsed_json
    except Exception as e:
        print(f"[RAG-SUMMARY] Error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to generate summary: {str(e)}")

@app.post("/api/rag/flashcards")
async def rag_flashcards(request: DocRequest):
    if not os.getenv("GOOGLE_API_KEY"):
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY is not configured on the backend. Please add it to Backend/.env"
        )
        
    doc_data = vector_stores.get(request.doc_id)
    if not doc_data:
        raise HTTPException(status_code=404, detail="Document not found.")
        
    try:
        text = doc_data["text"][:50000]
        chat = ChatGoogleGenerativeAI(model="gemini-2.5-flash", temperature=0.3)
        
        prompt = (
            "Analyze the provided document text and generate a list of 5 to 8 high-quality revision flashcards. "
            "You MUST reply ONLY with a valid JSON array matching the following structure:\n"
            "[\n"
            "  {\"question\": \"A clear, specific study question?\", \"answer\": \"A concise, informative answer explaining the concept.\"}\n"
            "]\n\n"
            "Do not include any formatting, markdown wrappers, or explanation outside of the raw JSON array.\n\n"
            f"Document Text:\n{text}"
        )
        
        response = await chat.ainvoke(prompt)
        parsed_json = parse_json_from_response(response.content)
        return {"flashcards": parsed_json}
    except Exception as e:
        print(f"[RAG-FLASHCARDS] Error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to generate flashcards: {str(e)}")

@app.post("/api/rag/mcq")
async def rag_mcq(request: DocRequest):
    if not os.getenv("GOOGLE_API_KEY"):
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY is not configured on the backend. Please add it to Backend/.env"
        )
        
    doc_data = vector_stores.get(request.doc_id)
    if not doc_data:
        raise HTTPException(status_code=404, detail="Document not found.")
        
    try:
        text = doc_data["text"][:50000]
        chat = ChatGoogleGenerativeAI(model="gemini-2.5-flash", temperature=0.3)
        
        prompt = (
            "Analyze the provided document text and generate 5 multiple-choice questions (MCQs) for revision. "
            "Each question must have exactly 4 unique options, and one correct answer (which must exactly match one of the options). "
            "You MUST reply ONLY with a valid JSON array matching the following structure:\n"
            "[\n"
            "  {\n"
            "    \"question\": \"Question text here?\",\n"
            "    \"options\": [\"Option 1\", \"Option 2\", \"Option 3\", \"Option 4\"],\n"
            "    \"correct_answer\": \"Option 2\"\n"
            "  }\n"
            "]\n\n"
            "Do not include any formatting, markdown wrappers, or explanation outside of the raw JSON array.\n\n"
            f"Document Text:\n{text}"
        )
        
        response = await chat.ainvoke(prompt)
        parsed_json = parse_json_from_response(response.content)
        return {"mcqs": parsed_json}
    except Exception as e:
        print(f"[RAG-MCQ] Error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to generate MCQs: {str(e)}")

if __name__ == "__main__":
    # pyrefly: ignore [missing-import]
    import uvicorn
    # Read port from env if needed, default to 8000
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
