# StudyCord RAG 1 Evaluation

This directory contains evaluation tooling only. It does not change the
production RAG API, prompts, authentication, persistence, or FAISS settings.

## Evaluated production architecture

- Validation and extraction: `rag1.ingestion.ingest_rag_document`
- Chunking: `RecursiveCharacterTextSplitter`, 1,000 characters, 200 overlap
- Embeddings: Google `models/gemini-embedding-001`
- Index construction: `FAISS.from_documents`
- Persistent restoration: the existing ownership-safe `resolve_rag_document`
- Retrieval: ranked `similarity_search`, top 4 chunks
- Contextualization: the existing bounded-history rewrite prompt, using the
  configured OpenRouter model at temperature 0
- Answer generation: the existing grounded answer prompt, using the configured
  OpenRouter model at temperature 0.3

The evaluator deliberately bypasses the process-local generated-answer cache so
every measured case performs contextualization, retrieval, and answer
generation. It still uses the production document resolver, persistent FAISS
index, prompt builders, and model factory.

Only total ingestion time is measured. Breaking validation, extraction,
chunking, and embedding into separate measurements would require instrumentation
inside production ingestion, which Phase 17.9 intentionally avoids.

## Install evaluation-only dependency

From `Backend` with the backend virtual environment activated:

```powershell
pip install -r evaluation\requirements.txt
```

The framework pins RAGAS 0.4.3 and uses its modern collections API:

- `Faithfulness`
- `AnswerRelevancy`
- `ContextPrecision`
- `ContextRecall`

RAGAS uses an OpenRouter evaluator LLM and Google
`gemini-embedding-001` embeddings. Set `RAGAS_EVALUATOR_MODEL` to a fixed model
for the academic run; otherwise it uses `OPENROUTER_MODEL`. Do not change the
model during one experiment.

## Dataset

Copy `datasets/rag1_dataset.template.json` to a local dataset file. Generated
or sensitive local datasets can be placed under `datasets/local/`, which is
gitignored.

```json
{
  "dataset_name": "rag1-final-evaluation-v1",
  "ground_truth_type": "manual",
  "description": "Manually verified questions for five study documents.",
  "cases": [
    {
      "id": "q001",
      "document_id": "00000000-0000-0000-0000-000000000000",
      "question": "What methodology does the document use?",
      "reference_answer": "A manually written answer verified against the document.",
      "reference_contexts": [
        "Optional manually selected source passage."
      ]
    },
    {
      "id": "q002",
      "document_id": "00000000-0000-0000-0000-000000000000",
      "question": "Why was it selected?",
      "reference_answer": "A manually verified follow-up answer.",
      "history": [
        {
          "role": "user",
          "content": "What methodology does the document use?"
        },
        {
          "role": "assistant",
          "content": "The document uses mixed methods."
        }
      ]
    }
  ]
}
```

`ground_truth_type` must be one of:

- `manual`
- `synthetic`
- `synthetic_reviewed`

Synthetic references are explicitly labelled in every result row and must not
be presented as objective human ground truth.

## Run

Use the authenticated owner's UUID that owns every referenced local RAG
document:

```powershell
python -m evaluation.evaluate_rag1 `
  --dataset evaluation\datasets\local\rag1_final.json `
  --user-id <authenticated-user-uuid>
```

To verify pipeline collection without invoking RAGAS:

```powershell
python -m evaluation.evaluate_rag1 `
  --dataset evaluation\datasets\local\rag1_final.json `
  --user-id <authenticated-user-uuid> `
  --skip-quality
```

Optional ingestion measurement uses the real ingestion function. Point
`RAG1_DATA_DIR` at an isolated evaluation workspace so evaluation artifacts do
not mix with normal local RAG data:

```powershell
python -m evaluation.evaluate_rag1 `
  --user-id <authenticated-user-uuid> `
  --rag1-data-dir evaluation\workspace\rag1 `
  --skip-quality `
  --ingestion-file C:\path\document.pdf
```

The ingestion-only result reports the generated document UUID. Use those UUIDs
when authoring the query dataset, and pass the same `--rag1-data-dir` when
running its query evaluation.

The command writes:

- `evaluation/results/rag1_evaluation.json`
- `evaluation/results/rag1_evaluation.csv`

Generated result files and the evaluation workspace are gitignored.
